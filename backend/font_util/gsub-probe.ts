/**
 * 轻量 GSUB probe：直接从字体字节解析表目录，提取 GSUB 字节 + cmap 的 codepoint→gid 映射，
 * 完全跳过 glyf 轮廓解析（parseSimpleGlyf），为 collectReachableGsubTargets 提供 seed。
 *
 * 背景：fontSubset 原先对 probe 阶段也调用完整 Font.create（subset 模式），它会解析子集 glyph 的
 * glyf 轮廓——但 probe 只需要 GSUB（原始字节透传）和 cmap（codepoint→gid），根本不需要轮廓。
 * CJK 字体（思源黑体、令东齐伋）两次 Font.create 占总耗时 36%~63%，省掉 probe 那次显著加速。
 *
 * 本模块只解析表目录（ttf/otf 通用）+ cmap 的 format 4（BMP）和 format 12（含补充平面），
 * 覆盖所有测试用例（FiraCode/CJK/篆体 均含 p3e1:fmt4 和/或 p3e10:fmt12）。
 * 查找算法与 fonteditor-core 的 readWindowsAllCodes/lookupFormat4/lookupFormat12 一致，
 * 保证 seedGids 与原 probe 路径完全相同（reachable 结果不变）。
 *
 * 字体若无 format 4/12 subtable（极罕见，如纯 format0/6 字体），返回 null，调用方回退到 Font.create。
 *
 * @reference https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
 */

/** cmap 查找结果：每个子集 codepoint 的原始 gid（与 fonteditor-core cmap[cp] 语义一致） */
export interface CmapLookup {
  /** codepoint → 原始 gid（仅含能在 format4/12 查到的子集 codepoint） */
  get(cp: number): number | undefined;
}

/** ttf/otf 表目录条目 */
interface TableEntry {
  offset: number;
  length: number;
}

/**
 * 解析表目录，返回指定 tag 的 (offset, length)。ttf 与 otf 表目录结构相同
 * （otf 的 CFF 在表目录里也是普通条目）。sfnt 版本 0x00010000(ttf) / 'OTTO'(otf) 均支持。
 */
function readTableEntry(dv: DataView, tag: string): TableEntry | null {
  /** sfnt 头：version(4) + numTables(2) + searchRange(2) + entrySelector(2) + rangeShift(2) = 12 字节 */
  if (dv.byteLength < 12) return null;
  const numTables = dv.getUint16(4, false);
  if (numTables <= 0 || numTables > 100) return null;
  let off = 12;
  for (let i = 0; i < numTables; i++) {
    const recOff = off + i * 16;
    if (recOff + 16 > dv.byteLength) return null;
    /** tag 是 4 字节 ASCII（大端），逐字节比较避免 String.fromCharCode 分配 */
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
 * format 4 二分查找 segment 后计算 gid（与 lookupFormat4 一致）。
 * format4 表布局（相对 subtable 起始）：
 *   format(2) length(2) language(2) segCountX2(2) searchRange(2) entrySelector(2) rangeShift(2)
 *   endCode[segCount] reservedPad(2) startCode[segCount] idDelta[segCount] idRangeOffset[segCount] glyphIdArray[]
 */
function lookupFormat4(dv: DataView, subOff: number, unicode: number): number {
  if (unicode > 0xFFFF) return -1;
  const segCountX2 = dv.getUint16(subOff + 6, false);
  const segCount = segCountX2 >>> 1;
  /** endCode 起始 = subOff + 14（7 个 uint16 头字段） */
  const endCodeBase = subOff + 14;
  /** startCode 起始 = endCodeBase + segCount*2 + 2(reservedPad) */
  const startCodeBase = endCodeBase + segCount * 2 + 2;
  const idDeltaBase = startCodeBase + segCount * 2;
  const idRangeOffsetBase = idDeltaBase + segCount * 2;
  /** idRangeOffset 值是「相对 idRangeOffset[i] 字节位置」的偏移（指向 glyphIdArray 某项） */
  const lo = 0;
  let hi = segCount - 1;
  /** 二分 endCode 找包含 unicode 的 segment（endCode 升序） */
  let l = lo, h = hi;
  while (l <= h) {
    const mid = (l + h) >> 1;
    const start = dv.getUint16(startCodeBase + mid * 2, false);
    const end = dv.getUint16(endCodeBase + mid * 2, false);
    if (unicode < start) {
      h = mid - 1;
    } else if (unicode > end) {
      l = mid + 1;
    } else {
      const idDelta = dv.getInt16(idDeltaBase + mid * 2, false);
      const idRangeOffset = dv.getUint16(idRangeOffsetBase + mid * 2, false);
      if (idRangeOffset === 0) {
        return ((unicode + idDelta) & 0xFFFF);
      }
      /** idRangeOffset[i] 是从「idRangeOffset[i] 字节位置」到 glyphIdArray 目标项的字节偏移。
       *  目标字节位置 = idRangeOffsetBase + mid*2 + idRangeOffset + (unicode - start)*2 */
      const glyphOff = idRangeOffsetBase + mid * 2 + idRangeOffset + (unicode - start) * 2;
      if (glyphOff + 2 > dv.byteLength) return 0;
      const glyphId = dv.getUint16(glyphOff, false);
      if (glyphId === 0) return 0;
      return ((glyphId + idDelta) & 0xFFFF);
    }
  }
  return -1;
}

/**
 * format 12 二分查找 group（与 lookupFormat12 一致）。
 * format12 表布局：format(2) reserved(2) length(4) language(4) nGroups(4) groups[nGroups]
 * 每个 group 12 字节：startCharCode(4) endCharCode(4) startGlyphID(4)，groups 升序。
 */
function lookupFormat12(dv: DataView, subOff: number, unicode: number): number {
  const nGroups = dv.getUint32(subOff + 12, false);
  const groupsBase = subOff + 16;
  let l = 0, h = nGroups - 1;
  while (l <= h) {
    const mid = (l + h) >> 1;
    const gOff = groupsBase + mid * 12;
    const gStart = dv.getUint32(gOff, false);
    const gEnd = dv.getUint32(gOff + 4, false);
    if (unicode < gStart) {
      h = mid - 1;
    } else if (unicode > gEnd) {
      l = mid + 1;
    } else {
      return dv.getUint32(gOff + 8, false) + (unicode - gStart);
    }
  }
  return -1;
}

/**
 * 解析 cmap 表目录，选 format 12（p3e10）和 format 4（p3e1）的 subtable 偏移。
 * 选用优先级与 fonteditor-core readWindowsAllCodes 一致：format12 优先（含补充平面），format4 兜底（BMP）。
 * @returns { fmt4Off, fmt12Off } 各为 subtable 绝对偏移或 -1（无）
 */
function selectCmapSubtables(dv: DataView, cmapOff: number): { fmt4Off: number; fmt12Off: number } {
  const numberSubtables = dv.getUint16(cmapOff + 2, false);
  let fmt4Off = -1;
  let fmt12Off = -1;
  /** 子表目录项 8 字节：platformID(2) encodingID(2) offset(4)，offset 相对 cmap 表起始 */
  let dirOff = cmapOff + 4;
  for (let i = 0; i < numberSubtables; i++) {
    const platformID = dv.getUint16(dirOff, false);
    const encodingID = dv.getUint16(dirOff + 2, false);
    const subRelOff = dv.getUint32(dirOff + 4, false);
    const subOff = cmapOff + subRelOff;
    if (subOff + 2 <= dv.byteLength) {
      const format = dv.getUint16(subOff, false);
      /** 优先 p3e1:fmt4 与 p3e10:fmt12（与 readWindowsAllCodes 选择一致） */
      if (format === 12 && platformID === 3 && encodingID === 10 && fmt12Off < 0) {
        fmt12Off = subOff;
      } else if (format === 4 && platformID === 3 && encodingID === 1 && fmt4Off < 0) {
        fmt4Off = subOff;
      }
    }
    dirOff += 8;
  }
  return { fmt4Off, fmt12Off };
}

/** 轻量 probe 结果。result 区分三种情况：
 *  - { ok: true, gsubBytes, lookup }：成功拿到 GSUB 字节与 cmap 查找器，调用方据此算 reachable，跳过 Font.create probe
 *  - { ok: false, needsFallback: false }：无 reachable（otf、或 ttf 无 GSUB），调用方跳过 Font.create probe，extraSubsetGids=undefined
 *  - { ok: false, needsFallback: true }：有 GSUB 但无 format4/12 cmap（极罕见），调用方须回退 Font.create probe */
export type ProbeResult =
  | { ok: true; gsubBytes: Uint8Array; lookup: CmapLookup }
  | { ok: false; needsFallback: boolean };

/**
 * 轻量 probe：从字体字节提取 GSUB 字节切片与 codepoint→gid 查找器，跳过 glyf 解析。
 *
 * @param fontBuffer 原始字体字节
 * @param codePoints 子集 codepoint（仅这些会被 cmap 查找）
 * @param sourceType 字体类型（'ttf'/'otf' 等）。otf 字体 fonteditor-core 的 probe 本就 origGSUB=undefined
 *                  （otf→ttf 转换不携带 GSUB），reachable 跳过——此处对 otf 直接判无 reachable 保持该语义，
 *                  省掉 otf 字体一次完整 otf→ttf 转换的 probe。
 */
export function probeGsubAndCmap(
  fontBuffer: ArrayBuffer,
  codePoints: number[],
  sourceType: string,
): ProbeResult {
  /** otf 字体：fonteditor-core probe 的 origGSUB 本就是 undefined（otf→ttf 转换不携带 GSUB），
   *  reachable 跳过、extraSubsetGids=undefined。保持该语义，避免读到真实 GSUB 改变子集字形集。 */
  if (sourceType === "otf") return { ok: false, needsFallback: false };
  const dv = new DataView(fontBuffer);
  const gsubEntry = readTableEntry(dv, "GSUB");
  /** 无 GSUB 表 → 无 reachable（与原 probe origGSUB=undefined 一致） */
  if (gsubEntry === null) return { ok: false, needsFallback: false };
  /** GSUB 字节切片（offset/length 来自表目录，与 fonteditor-core 透传的字节一致） */
  const gsubBytes = new Uint8Array(fontBuffer, gsubEntry.offset, gsubEntry.length);

  const cmapEntry = readTableEntry(dv, "cmap");
  if (cmapEntry === null) return { ok: false, needsFallback: true };
  const { fmt4Off, fmt12Off } = selectCmapSubtables(dv, cmapEntry.offset);
  /** 有 GSUB 但无 format4/12 cmap（极罕见字体）→ 无法轻量查找，回退 Font.create */
  if (fmt4Off < 0 && fmt12Off < 0) return { ok: false, needsFallback: true };

  /** 预查所有子集 codepoint 的 gid（与 readWindowsAllCodes subset 模式逻辑一致：
   *  format12 优先，BMP 范围先试 format4，补充平面用 format12） */
  const gidMap = new Map<number, number>();
  for (const cp of codePoints) {
    if (gidMap.has(cp)) continue;
    let gid = -1;
    /** BMP（<0x10000）且有 format4：先查 format4（与 readWindowsAllCodes 一致：format12 存在时 BMP 仍先试 format4） */
    if (cp < 0x10000 && fmt4Off >= 0) {
      gid = lookupFormat4(dv, fmt4Off, cp);
    }
    /** format4 未命中（含补充平面）→ 查 format12 */
    if (gid < 0 && fmt12Off >= 0) {
      gid = lookupFormat12(dv, fmt12Off, cp);
    }
    if (gid >= 0) gidMap.set(cp, gid);
  }

  return {
    ok: true,
    gsubBytes,
    lookup: {
      get(cp: number): number | undefined {
        const g = gidMap.get(cp);
        return g === undefined ? undefined : g;
      },
    },
  };
}
