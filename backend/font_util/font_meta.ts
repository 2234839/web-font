/**
 * 字体元数据提取 —— 从字体字节解析 cmap，提取完整 codepoint 集合，
 * 并对照标准字符集计算覆盖率。
 *
 * 直接解析 cmap 表的 format4（BMP）和 format12（含补充平面）的 segment/group，
 * 遍历所有区间收集完整 codepoint 集合。不依赖 fonteditor-core 的 Font.create，
 * 避免解析 glyf 轮廓（对大字体可省数十毫秒）。
 */

/** ttf/otf 表目录条目 */
interface TableEntry {
  offset: number;
  length: number;
}

/** 解析表目录，返回指定 tag 的 (offset, length) */
function readTableEntry(dv: DataView, tag: string): TableEntry | null {
  if (dv.byteLength < 12) return null;
  const numTables = dv.getUint16(4, false);
  if (numTables <= 0 || numTables > 100) return null;
  let off = 12;
  for (let i = 0; i < numTables; i++) {
    const recOff = off + i * 16;
    if (recOff + 16 > dv.byteLength) return null;
    const t0 = dv.getUint8(recOff);
    const t1 = dv.getUint8(recOff + 1);
    const t2 = dv.getUint8(recOff + 2);
    const t3 = dv.getUint8(recOff + 3);
    if (t0 === tag.charCodeAt(0) && t1 === tag.charCodeAt(1) && t2 === tag.charCodeAt(2) && t3 === tag.charCodeAt(3)) {
      return { offset: dv.getUint32(recOff + 8, false), length: dv.getUint32(recOff + 12, false) };
    }
  }
  return null;
}

/**
 * 从 cmap 的 format4 subtable 遍历所有 segment，收集每个 segment 中 gid≠0 的 codepoint。
 * format4 表布局见 gsub-probe.ts 的 lookupFormat4 注释。
 */
/**
 * 构建 glyph 验证器：对 TrueType 字体，检查 gid 在 loca 表中对应 glyf 长度 > 0。
 * CFF 字体（无 glyf/loca）则返回恒真函数。
 */
function createGlyphValidator(dv: DataView): (gid: number) => boolean {
  const glyfEntry = readTableEntry(dv, "glyf");
  const locaEntry = readTableEntry(dv, "loca");
  const headEntry = readTableEntry(dv, "head");

  if (!glyfEntry || !locaEntry || !headEntry) {
    /** CFF 字体：cmap 有映射即有效 */
    return () => true;
  }

  /** indexToLocFormat：0=short(uint16偏移×2), 1=long(uint32偏移) */
  const locaFormat = dv.getUint16(headEntry.offset + 50, false);
  const locaBase = locaEntry.offset;

  return (gid: number): boolean => {
    let start: number;
    let end: number;
    if (locaFormat === 0) {
      start = dv.getUint16(locaBase + gid * 2, false) * 2;
      end = dv.getUint16(locaBase + (gid + 1) * 2, false) * 2;
    } else {
      start = dv.getUint32(locaBase + gid * 4, false);
      end = dv.getUint32(locaBase + (gid + 1) * 4, false);
    }
    return end - start > 0;
  };
}

function collectFormat4(dv: DataView, subOff: number, cps: Set<number>, hasGlyph: (gid: number) => boolean): void {
  if (subOff + 14 > dv.byteLength) return;
  const segCountX2 = dv.getUint16(subOff + 6, false);
  const segCount = segCountX2 / 2;
  const endCodeBase = subOff + 14;
  const startCodeBase = endCodeBase + segCount * 2 + 2;
  const idDeltaBase = startCodeBase + segCount * 2;
  const idRangeOffsetBase = idDeltaBase + segCount * 2;

  for (let i = 0; i < segCount; i++) {
    const start = dv.getUint16(startCodeBase + i * 2, false);
    const end = dv.getUint16(endCodeBase + i * 2, false);
    /** 0xFFFF 的 segment 是 format4 必有的哨兵，跳过 */
    if (start === 0xFFFF) continue;
    const idDelta = dv.getInt16(idDeltaBase + i * 2, false);
    const idRangeOffset = dv.getUint16(idRangeOffsetBase + i * 2, false);

    if (idRangeOffset === 0) {
      /** 线性映射：gid = (cp + idDelta) & 0xFFFF，gid=0 表示缺失 */
      for (let cp = start; cp <= end; cp++) {
        const gid = (cp + idDelta) & 0xFFFF;
        if (gid !== 0 && hasGlyph(gid)) cps.add(cp);
      }
    } else {
      /** 逐个查 glyphIdArray */
      for (let cp = start; cp <= end; cp++) {
        const glyphOff = idRangeOffsetBase + i * 2 + idRangeOffset + (cp - start) * 2;
        if (glyphOff + 2 > dv.byteLength) break;
        const glyphId = dv.getUint16(glyphOff, false);
        const gid = (glyphId + idDelta) & 0xFFFF;
        if (glyphId !== 0 && gid !== 0 && hasGlyph(gid)) cps.add(cp);
      }
    }
  }
}

/**
 * 从 cmap 的 format12 subtable 遍历所有 group，收集 gid 在范围内的 codepoint。
 * format12 表布局见 gsub-probe.ts 的 lookupFormat12 注释。
 */
function collectFormat12(dv: DataView, subOff: number, cps: Set<number>, hasGlyph: (gid: number) => boolean): void {
  if (subOff + 16 > dv.byteLength) return;
  const nGroups = dv.getUint32(subOff + 12, false);
  const groupsBase = subOff + 16;
  for (let i = 0; i < nGroups; i++) {
    const gOff = groupsBase + i * 12;
    if (gOff + 12 > dv.byteLength) break;
    const gStart = dv.getUint32(gOff, false);
    const gEnd = dv.getUint32(gOff + 4, false);
    const gGid = dv.getUint32(gOff + 8, false);
    /** 逐个验证 gid 是否有真实轮廓（空轮廓 glyph 会被 loca 表过滤掉） */
    for (let cp = gStart; cp <= gEnd; cp++) {
      const gid = gGid + (cp - gStart);
      if (gid !== 0 && hasGlyph(gid)) cps.add(cp);
    }
  }
}

/**
 * 从字体字节提取所有支持的 Unicode codepoint 集合。
 * 优先解析 format12（覆盖更广），再补 format4（BMP 兜底）。
 */
export function extractCodePoints(fontBuffer: ArrayBuffer | Uint8Array): Set<number> {
  const buf = fontBuffer instanceof Uint8Array ? fontBuffer.buffer : fontBuffer;
  const dv = new DataView(buf);
  const cmapEntry = readTableEntry(dv, "cmap");
  const cps = new Set<number>();
  if (cmapEntry === null) return cps;

  /** 选择 format4 和 format12 的 subtable 偏移 */
  const numberSubtables = dv.getUint16(cmapEntry.offset + 2, false);
  let fmt4Off = -1;
  let fmt12Off = -1;
  let dirOff = cmapEntry.offset + 4;
  for (let i = 0; i < numberSubtables; i++) {
    if (dirOff + 8 > dv.byteLength) break;
    const platformID = dv.getUint16(dirOff, false);
    const encodingID = dv.getUint16(dirOff + 2, false);
    const subRelOff = dv.getUint32(dirOff + 4, false);
    const subOff = cmapEntry.offset + subRelOff;
    if (subOff + 2 <= dv.byteLength) {
      const format = dv.getUint16(subOff, false);
      if (format === 12 && platformID === 3 && encodingID === 10 && fmt12Off < 0) {
        fmt12Off = subOff;
      } else if (format === 4 && platformID === 3 && encodingID === 1 && fmt4Off < 0) {
        fmt4Off = subOff;
      }
    }
    dirOff += 8;
  }

  /** 创建 glyph 轮廓验证器（TrueType 检查 loca，CFF 恒真） */
  const hasGlyph = createGlyphValidator(dv);

  /** format12 优先（含补充平面），format4 补充 BMP */
  if (fmt12Off >= 0) collectFormat12(dv, fmt12Off, cps, hasGlyph);
  if (fmt4Off >= 0) collectFormat4(dv, fmt4Off, cps, hasGlyph);

  return cps;
}

// ────────────────────── 标准字符集定义 ─────────────────────-

/** 字符集覆盖率结果 */
export interface CharsetCoverage {
  /** 字符集标识 */
  key: string;
  /** 字符集名称（中文） */
  name: string;
  /** 该字符集的总字符数 */
  total: number;
  /** 字体支持的字符数 */
  covered: number;
  /** 覆盖率百分比 (0~100，保留一位小数) */
  percent: number;
}

/**
 * 计算给定 Unicode 区间数组中，字体覆盖了多少 codepoint。
 * 区间数组格式：[[start, end], ...]，每个区间连续。
 */
function countCoverage(cps: Set<number>, ranges: ReadonlyArray<readonly [number, number]>): { total: number; covered: number } {
  let total = 0;
  let covered = 0;
  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp++) {
      total++;
      if (cps.has(cp)) covered++;
    }
  }
  return { total, covered };
}

/**
 * 标准字符集列表 —— 全部用 Unicode 区间表示，基于 Unicode 官方区块定义。
 * 覆盖率是近似值（区间内含少量非目标字符），但对字体选型参考足够精确。
 *
 * - ascii: ASCII 可打印字符，含字母、数字、常见标点（U+0020~U+007E）
 * - commonHanzi: 常用汉字（U+4E00~U+5535，约 3500 字），覆盖日常中文 99.8%
 * - cjkBasic: CJK 统一汉字基本区（U+4E00~U+9FFF，20992 码位），含简繁体
 * - cjkExtA: CJK 扩展A 区（U+3400~U+4DBF），罕见字/古字
 * - punctuation: CJK 标点符号（U+3000~U+303F）
 * - fullwidth: 全角字符（U+FF00~U+FFEF）
 * - cyrillic: 西里尔字母/俄文（U+0400~U+04FF）
 */
const CHARSETS: Array<{ key: string; name: string; ranges: ReadonlyArray<readonly [number, number]> }> = [
  { key: "ascii", name: "英文字母数字", ranges: [[0x20, 0x7e]] },
  { key: "commonHanzi", name: "常用汉字（约3500）", ranges: [[0x4e00, 0x5bad]] },
  { key: "cjkBasic", name: "CJK 基本汉字（20992）", ranges: [[0x4e00, 0x9fff]] },
  { key: "cjkExtA", name: "CJK 扩展A（罕用字）", ranges: [[0x3400, 0x4dbf]] },
  { key: "punctuation", name: "中文标点", ranges: [[0x3000, 0x303f]] },
  { key: "fullwidth", name: "全角字符", ranges: [[0xff00, 0xffef]] },
  { key: "cyrillic", name: "西里尔字母/俄文", ranges: [[0x400, 0x4ff]] },
];

/**
 * 计算字体对各类标准字符集的覆盖率。
 */
export function calcCoverage(cps: Set<number>): CharsetCoverage[] {
  return CHARSETS.map(({ key, name, ranges }) => {
    const { total, covered } = countCoverage(cps, ranges);
    return {
      key,
      name,
      total,
      covered,
      percent: total > 0 ? Math.round((covered / total) * 1000) / 10 : 0,
    };
  });
}

/**
 * 将 codepoint 集合编码为紧凑的区间数组（用于传输/存储）。
 * 每个区间 [start, end] 表示连续的 codepoint 范围。
 */
export function codePointsToRanges(cps: Set<number>): Array<[number, number]> {
  const sorted = [...cps].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[++i];
    }
    ranges.push([start, end]);
    i++;
  }
  return ranges;
}

/** OpenType name 表中的标准名称 ID */
const NAME_ID = {
  COPYRIGHT: 0,
  FAMILY: 1,
  SUBFAMILY: 2,
  UNIQUE_ID: 3,
  FULL_NAME: 4,
  VERSION: 5,
  POSTSCRIPT: 6,
  TRADEMARK: 7,
  MANUFACTURER: 8,
  DESIGNER: 9,
  DESCRIPTION: 10,
  VENDOR_URL: 11,
  DESIGNER_URL: 12,
  LICENSE: 13,
  LICENSE_URL: 14,
} as const;

/** 需要提取的 nameID 列表 */
const EXTRACT_NAME_IDS = [
  NAME_ID.COPYRIGHT,
  NAME_ID.FAMILY,
  NAME_ID.SUBFAMILY,
  NAME_ID.FULL_NAME,
  NAME_ID.VERSION,
  NAME_ID.POSTSCRIPT,
  NAME_ID.TRADEMARK,
  NAME_ID.MANUFACTURER,
  NAME_ID.DESIGNER,
  NAME_ID.DESCRIPTION,
  NAME_ID.VENDOR_URL,
  NAME_ID.DESIGNER_URL,
  NAME_ID.LICENSE,
  NAME_ID.LICENSE_URL,
] as const;

/** 字体基本信息（从 name 表提取） */
export interface FontInfo {
  /** 版权声明 */
  copyright?: string;
  /** 字体族名 */
  family?: string;
  /** 字体子族名（如 Regular、Bold） */
  subfamily?: string;
  /** 唯一标识 */
  uniqueId?: string;
  /** 完整名称 */
  fullName?: string;
  /** 版本号 */
  version?: string;
  /** PostScript 名称 */
  postScript?: string;
  /** 商标声明 */
  trademark?: string;
  /** 制造商/出版商 */
  manufacturer?: string;
  /** 设计师 */
  designer?: string;
  /** 描述 */
  description?: string;
  /** 厂商 URL */
  vendorUrl?: string;
  /** 设计师 URL */
  designerUrl?: string;
  /** 许可声明 */
  license?: string;
  /** 许可 URL */
  licenseUrl?: string;
}

/**
 * 解码 name record 的字符串。
 * platformID=3 (Windows) 使用 UTF-16BE；platformID=1 (Mac) 使用 Latin-1/ASCII。
 */
function decodeNameString(dv: DataView, offset: number, length: number, platformID: number): string {
  if (offset + length > dv.byteLength) return "";
  if (platformID === 3) {
    /** UTF-16BE */
    const codes: number[] = [];
    for (let i = 0; i < length; i += 2) {
      codes.push(dv.getUint16(offset + i, false));
    }
    return String.fromCodePoint(...codes);
  }
  /** Mac Roman / ASCII 近似 */
  const bytes = new Uint8Array(dv.buffer, offset, length);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 从 name 表提取字体基本信息。
 * 优先取 platformID=3 (Windows) 的英文记录，其次 platformID=0/1。
 */
export function extractFontInfo(fontBuffer: ArrayBuffer | Uint8Array): FontInfo {
  const buf = fontBuffer instanceof Uint8Array ? fontBuffer.buffer : fontBuffer;
  const dv = new DataView(buf);
  const nameEntry = readTableEntry(dv, "name");
  if (nameEntry === null) return {};

  const base = nameEntry.offset;
  if (base + 6 > dv.byteLength) return {};

  const format = dv.getUint16(base, false);
  const count = dv.getUint16(base + 2, false);
  /** stringOffset：相对 name 表起始的偏移，指向字符串存储区 */
  const stringOffset = dv.getUint16(base + 4, false);
  const storageBase = base + stringOffset;

  /** 收集每个 nameID 的最佳字符串，优先级：Windows(3) > Mac(1) */
  const collected = new Map<number, { text: string; priority: number }>();

  const recordBase = base + 6;
  for (let i = 0; i < count; i++) {
    const recOff = recordBase + i * 12;
    if (recOff + 12 > dv.byteLength) break;
    const platformID = dv.getUint16(recOff, false);
    const encodingID = dv.getUint16(recOff + 2, false);
    const languageID = dv.getUint16(recOff + 4, false);
    const nameID = dv.getUint16(recOff + 6, false);
    const length = dv.getUint16(recOff + 8, false);
    const offset = dv.getUint16(recOff + 10, false);

    if (!EXTRACT_NAME_IDS.includes(nameID as (typeof EXTRACT_NAME_IDS)[number])) continue;

    /** 优先级：Windows 英文(3,1,0x409) > Windows 中文(3,1,*) > Mac(1,*) > 其他 */
    let priority = 0;
    if (platformID === 3 && languageID === 0x0409) priority = 4;
    else if (platformID === 3 && encodingID === 1) priority = 3;
    else if (platformID === 3) priority = 2;
    else if (platformID === 1) priority = 1;

    const existing = collected.get(nameID);
    if (existing && existing.priority >= priority) continue;

    const text = decodeNameString(dv, storageBase + offset, length, platformID);
    if (text) collected.set(nameID, { text, priority });
  }

  /** format 1 有 lang-tag record，跳过 */
  void format;

  const info: FontInfo = {};
  const get = (id: number): string | undefined => collected.get(id)?.text;
  info.copyright = get(NAME_ID.COPYRIGHT);
  info.family = get(NAME_ID.FAMILY);
  info.subfamily = get(NAME_ID.SUBFAMILY);
  info.uniqueId = get(NAME_ID.UNIQUE_ID);
  info.fullName = get(NAME_ID.FULL_NAME);
  info.version = get(NAME_ID.VERSION);
  info.postScript = get(NAME_ID.POSTSCRIPT);
  info.trademark = get(NAME_ID.TRADEMARK);
  info.manufacturer = get(NAME_ID.MANUFACTURER);
  info.designer = get(NAME_ID.DESIGNER);
  info.description = get(NAME_ID.DESCRIPTION);
  info.vendorUrl = get(NAME_ID.VENDOR_URL);
  info.designerUrl = get(NAME_ID.DESIGNER_URL);
  info.license = get(NAME_ID.LICENSE);
  info.licenseUrl = get(NAME_ID.LICENSE_URL);
  return info;
}

/** 人工配置项（来自 font/font-config.json，由用户维护） */
export interface FontUserConfig {
  /** 显示名称（优先于文件名） */
  displayName?: string;
  /** 描述/简介 */
  description?: string;
  /** 标签列表 */
  tags?: string[];
  /** 开源仓库地址（如 GitHub URL） */
  homepage?: string;
  /** 默认预览文字 */
  previewText?: string;
  /** 详情页正文标题 */
  bodyTitle?: string;
  /** 详情页正文段落 */
  bodyText?: string;
  /** 详情页字符预览行 */
  charsetPreview?: string;
}

/** 字体元数据结果 */
export interface FontMeta {
  /** 字体支持的 codepoint 总数 */
  totalCodePoints: number;
  /** 各字符集覆盖率 */
  coverage: CharsetCoverage[];
  /**
   * 字体支持的所有 codepoint 区间（紧凑表示）。
   * 前端可据此判断任意字符是否被支持，无需请求完整字符列表。
   * 例如 [[0x20, 0x7e], [0x4e00, 0x9fff]] 表示支持 ASCII 和全部基本汉字。
   */
  ranges: Array<[number, number]>;
  /** 字体基本信息（版权、作者等，来自 name 表） */
  info: FontInfo;
  /** 人工配置（来自 font-config.json，由路由层合并） */
  config?: FontUserConfig;
}

/**
 * 提取字体元数据：codepoint 总数、覆盖率、支持的区间、字体基本信息。
 * 注意：config 字段由路由层从 font-config.json 填充，此处不包含。
 */
export function extractFontMeta(fontBuffer: ArrayBuffer | Uint8Array): FontMeta {
  const cps = extractCodePoints(fontBuffer);
  return {
    totalCodePoints: cps.size,
    coverage: calcCoverage(cps),
    ranges: codePointsToRanges(cps),
    info: extractFontInfo(fontBuffer),
  };
}
