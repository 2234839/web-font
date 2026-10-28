/**
 * @file ttf读取器
 * @author mengke01(kekee000@gmail.com)
 */

import directory from "./table/directory";
import support from "./table/support";
import Reader from "./reader";
import postName from "./enum/postName";
import error from "./error";
import compound2simpleglyf from "./util/compound2simpleglyf";
import { getPascalStringAt } from "./table/post";

/** 表读取结果（表名 → 表数据/表索引，字段动态访问） */
type TtfObject = Record<string, any>;

/** 读取选项 */
interface TTFReaderOptions {
  /** 子集字符列表 */
  subset?: number[];
  /** 是否保留 hinting */
  hinting?: boolean;
  /** 是否保留 kerning 信息 */
  kerning?: boolean;
  /** 复合字形转简单字形 */
  compound2simple?: boolean;
}

/** 支持读取的表构造器（支持传入偏移并读取内容） */
interface ReadableTable {
  /** 表在字体文件中的偏移 */
  offset: number;
  /** 读取表内容 */
  read(reader: Reader, ttf: TtfObject): unknown;
}

/** 表名列表提升为模块级常量，避免每次 readBuffer 创建新数组 */
const TTF_TABLE_NAMES = [
  "head",
  "maxp",
  "loca",
  "cmap",
  "glyf",
  "name",
  "hhea",
  "hmtx",
  "post",
  "OS/2",
  "fpgm",
  "cvt",
  "prep",
  "gasp",
  "BASE",
  "GPOS",
  "GSUB",
  "kern",
  "kerx",
];

/** 表索引目录（directory 读取结果，按表名动态访问偏移） */
interface DirectoryTable {
  /** 读取表索引 */
  read(reader: Reader, ttf: unknown): Record<string, any>;
}

/** directory 表读取器，构造时可传入表索引起始偏移 */
const DirectoryTableCtor = directory as unknown as new (offset: number) => DirectoryTable;

/** 支持的表集合，按表名索引构造器 */
const supportTables = support as unknown as Record<string, new (offset?: number) => ReadableTable>;

/**
 * ttf 读取器
 */
export default class TTFReader {
  /** 读取选项 */
  options: TTFReaderOptions;
  /** 解析后的 ttf 对象 */
  ttf: TtfObject | null;

  /**
   * 读取器
   *
   * @param options 读取选项
   */
  constructor(options: TTFReaderOptions = {}) {
    options.subset = options.subset || [];
    options.hinting = options.hinting || false;
    options.kerning = options.kerning || false;
    options.compound2simple = options.compound2simple || false;
    this.options = options;
    this.ttf = null;
  }

  /**
   * 读取ttf buffer
   *
   * @param buffer buffer对象
   * @return ttf对象
   */
  readBuffer(buffer: ArrayBuffer): TtfObject {
    const reader = new Reader(buffer, 0, buffer.byteLength, false);
    const ttf: TtfObject = {};

    /* 头部直接 view 读取 */
    const view = reader.view!;
    const vOffset = view.byteOffset;
    ttf.version = view.getInt32(vOffset, false) / 65536.0;
    if (ttf.version !== 0x1) {
      error.raise(10101);
    }
    ttf.numTables = view.getUint16(vOffset + 4, false);
    if (ttf.numTables <= 0 || ttf.numTables > 100) {
      error.raise(10101);
    }
    ttf.searchRange = view.getUint16(vOffset + 6, false);
    ttf.entrySelector = view.getUint16(vOffset + 8, false);
    ttf.rangeShift = view.getUint16(vOffset + 10, false);
    reader.offset = 12;

    ttf.tables = new DirectoryTableCtor(reader.offset).read(reader, ttf);
    if (!ttf.tables.glyf || !ttf.tables.head || !ttf.tables.cmap || !ttf.tables.hmtx) {
      error.raise(10204);
    }
    ttf.readOptions = this.options;

    /* 跳过不必要的表，缓存 TableClass 实例，预构建表名列表替代 for...in */
    const hinting = this.options.hinting;
    const kerning = this.options.kerning;
    const tableInstances: Record<string, ReadableTable> = {};
    const ttfTableNames = TTF_TABLE_NAMES;
    for (let ti = 0, tl = ttfTableNames.length; ti < tl; ti++) {
      const tableName = ttfTableNames[ti];
      if (ttf.tables[tableName]) {
        /* hinting=false 时跳过 fpgm/cvt/prep/gasp */
        if (!hinting && (tableName === "fpgm" || tableName === "cvt" || tableName === "prep" || tableName === "gasp")) {
          continue;
        }
        /* hinting=false && kerning=false 时跳过 GPOS/GSUB/kern/kerx */
        if (
          !hinting &&
          !kerning &&
          (tableName === "GPOS" || tableName === "GSUB" || tableName === "kern" || tableName === "kerx")
        ) {
          continue;
        }
        const offset = ttf.tables[tableName].offset;
        /* 缓存 TableClass 实例 */
        if (!tableInstances[tableName]) {
          tableInstances[tableName] = new supportTables[tableName](offset);
        } else {
          tableInstances[tableName].offset = offset;
        }
        ttf[tableName] = tableInstances[tableName].read(reader, ttf);
      }
    }
    if (!ttf.glyf) {
      error.raise(10201);
    }
    reader.dispose();
    return ttf;
  }

  /**
   * 关联glyf相关的信息
   *
   * @param ttf ttf对象
   */
  resolveGlyf(ttf: TtfObject): void {
    const codes = ttf.cmap;
    const glyf = ttf.glyf;
    const subsetGids = ttf.readOptions.subset ? ttf.subsetGids : null;

    /* subset 模式下只遍历 subsetUnicodeMap（O(S)），避免全量 codes 遍历（O(U)） */
    if (ttf._subsetUnicodeMap) {
      const sum = ttf._subsetUnicodeMap;
      for (const uStr in sum) {
        const u = +uStr;
        const i = sum[u];
        if (!glyf[i].unicode) {
          glyf[i].unicode = [u];
        } else {
          glyf[i].unicode.push(u);
        }
      }
      ttf._subsetUnicodeMap = null;
    } else {
      for (const c in codes) {
        const i = codes[c];
        const code = +c;
        if (!glyf[i].unicode) {
          glyf[i].unicode = [code];
        } else {
          glyf[i].unicode.push(code);
        }
      }
    }

    /* advanceWidth 遍历优化，使用密集数组
     * （hmtx 紧凑存储）：subset 模式下 hmtx 按 subsetGids 顺序存储（Int32Array(S*2)），
     * 下标用 gi*2（subsetGids 内位置），而非原 gid*2 */
    const hmtx = ttf.hmtx;
    if (subsetGids) {
      for (let gi = 0, gl = subsetGids.length; gi < gl; gi++) {
        const idxNum = subsetGids[gi];
        const hIdx = gi * 2;
        glyf[idxNum].advanceWidth = hmtx[hIdx];
        glyf[idxNum].leftSideBearing = hmtx[hIdx + 1];
      }
    } else {
      for (let hi = 0, hl = hmtx.length / 2; hi < hl; hi++) {
        const hIdx2 = hi * 2;
        glyf[hi].advanceWidth = hmtx[hIdx2];
        glyf[hi].leftSideBearing = hmtx[hIdx2 + 1];
      }
    }

    /* post 表 glyf name */
    if (ttf.post && 2 === ttf.post.format) {
      const nameIndex = ttf.post.nameIndex;
      const names = ttf.post.names;
      const pascalBytes = ttf.post._pascalStringBytes;
      const pascalOffsets = ttf.post._pascalStringOffsets;
      /* subset 模式下按需从 view 读取 nameIndex */
      const niView = ttf.post._nameIndexView;
      const niViewOffset = ttf.post._nameIndexViewOffset;

      if (subsetGids) {
        for (let niIdx = 0, nl2 = subsetGids.length; niIdx < nl2; niIdx++) {
          const niNum = subsetGids[niIdx];
          const nIdx = niView ? niView.getUint16(niViewOffset + niNum * 2, false) : nameIndex && nameIndex[niNum];
          if (nIdx === undefined || nIdx === null) continue;
          if (nIdx <= 257) {
            glyf[niNum].name = postName[nIdx];
          } else if (names) {
            glyf[niNum].name = names[nIdx - 258] || "";
          } else if (pascalBytes) {
            let off = pascalOffsets ? pascalOffsets[nIdx - 258] : null;
            if (off === null) {
              /* 按需计算 pascal string 偏移量 */
              let pOff = 0;
              for (let pk = 0; pk < nIdx - 258; pk++) {
                pOff += 1 + (pascalBytes[pOff] || 0);
              }
              off = pOff;
            }
            glyf[niNum].name = off !== undefined ? getPascalStringAt(pascalBytes, off) : "";
          }
        }
      } else if (nameIndex) {
        for (let ni2 = 0, nl = nameIndex.length; ni2 < nl; ni2++) {
          const nIdx2 = nameIndex[ni2];
          if (nIdx2 <= 257) {
            glyf[ni2].name = postName[nIdx2];
          } else if (names) {
            glyf[ni2].name = names[nIdx2 - 258] || "";
          } else if (pascalBytes && pascalOffsets) {
            const off2 = pascalOffsets[nIdx2 - 258];
            glyf[ni2].name = off2 !== undefined ? getPascalStringAt(pascalBytes, off2) : "";
          }
        }
      }
    }

    /* subset 模式下合并 compound→simple 转换与 subGlyf 构建，消除二次遍历 */
    if (subsetGids) {
      const subGlyf = new Array(subsetGids.length);
      for (let si = 0, sl = subsetGids.length; si < sl; si++) {
        const siNum = subsetGids[si];
        if (glyf[siNum].compound) {
          compound2simpleglyf(siNum, ttf, true);
        }
        subGlyf[si] = glyf[siNum];
      }
      ttf.glyf = subGlyf;
      ttf.maxp.maxComponentElements = 0;
      ttf.maxp.maxComponentDepth = 0;
    }
  }

  /**
   * 清除非必须的表
   *
   * @param ttf ttf对象
   */
  cleanTables(ttf: TtfObject): void {
    /* delete → null 赋值，避免 V8 隐藏类转换 */
    ttf.readOptions = null;
    ttf.tables = null;
    ttf.hmtx = null;
    ttf.loca = null;
    if (ttf.post) {
      ttf.post.nameIndex = null;
      ttf.post.names = null;
      ttf.post._pascalStringBytes = null;
      ttf.post._pascalStringOffsets = null;
    }
    ttf.subsetMap = null;

    if (!this.options.hinting) {
      /* delete → null 赋值，避免 V8 隐藏类转换 */
      ttf.fpgm = null;
      ttf.cvt = null;
      ttf.prep = null;
      const glyfs = ttf.glyf;
      for (let i = 0, l = glyfs.length; i < l; i++) {
        glyfs[i].instructions = null;
      }
    }
    if (!this.options.hinting && !this.options.kerning) {
      ttf.GPOS = null;
      ttf.GSUB = null;
      ttf.kern = null;
      ttf.kerx = null;
    }

    if (this.options.compound2simple && ttf.maxp.maxComponentElements) {
      const glyfs2 = ttf.glyf;
      for (let j = 0, jl = glyfs2.length; j < jl; j++) {
        if (glyfs2[j].compound) {
          compound2simpleglyf(j, ttf, true);
        }
      }
      ttf.maxp.maxComponentElements = 0;
      ttf.maxp.maxComponentDepth = 0;
    }
  }

  /**
   * 读取ttf buffer 并解析
   *
   * @param buffer buffer对象
   * @return ttf对象
   */
  read(buffer: ArrayBuffer): TtfObject {
    this.ttf = this.readBuffer(buffer);
    this.resolveGlyf(this.ttf);
    this.cleanTables(this.ttf);
    return this.ttf;
  }

  /**
   * 注销
   */
  dispose(): void {
    /* delete → null 赋值，避免 V8 隐藏类转换 */
    this.ttf = null;
    this.options = null as unknown as TTFReaderOptions;
  }
}
