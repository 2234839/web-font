/**
 * @file otf字体读取
 * @author mengke01(kekee000@gmail.com)
 */

import directory from "./table/directory";
import supportOtfRaw from "./table/support-otf";
import Reader from "./reader";
import error from "./error";

/** otf 读取结果（表名 → 表数据，字段动态访问） */
type OtfObject = Record<string, any>;

/** 读取选项 */
interface OTFReaderOptions {
  /** 子集字符列表 */
  subset?: number[];
}

/** 支持读取的表构造器 */
interface ReadableTable {
  /** 表在字体文件中的偏移 */
  offset: number;
  /** 读取表内容 */
  read(reader: Reader, font: OtfObject): unknown;
}

/** otf 支持的表集合，按表名索引构造器 */
const otfSupport = supportOtfRaw as unknown as Record<string, new (offset?: number) => ReadableTable>;

/** otf 表索引目录 */
interface DirectoryTable {
  /** 读取表索引 */
  read(reader: Reader, font: unknown): Record<string, any>;
}

/** directory 表读取器，构造时可传入表索引起始偏移 */
const DirectoryTableCtor = directory as unknown as new (offset: number) => DirectoryTable;

/**
 * OTF 读取器
 */
export default class OTFReader {
  /** 读取选项 */
  options: OTFReaderOptions;
  /** 解析后的 otf 对象 */
  font: OtfObject | null;

  /**
   * OTF读取函数
   *
   * @param options 读取参数
   */
  constructor(options: OTFReaderOptions = {}) {
    options.subset = options.subset || [];
    this.options = options;
    this.font = null;
  }

  /**
   * 读取otf buffer
   *
   * @param buffer buffer对象
   * @return otf对象
   */
  readBuffer(buffer: ArrayBuffer): OtfObject {
    const reader = new Reader(buffer, 0, buffer.byteLength, false);
    const font: OtfObject = {};

    // version
    font.version = reader.readString(0, 4);
    if (font.version !== "OTTO") {
      error.raise(10301);
    }

    // num tables
    font.numTables = reader.readUint16();
    if (font.numTables <= 0 || font.numTables > 100) {
      error.raise(10302);
    }

    // searchRange
    font.searchRange = reader.readUint16();

    // entrySelector
    font.entrySelector = reader.readUint16();

    // rangeShift
    font.rangeShift = reader.readUint16();
    font.tables = new DirectoryTableCtor(reader.offset).read(reader, font);
    if (!font.tables.head || !font.tables.cmap || !font.tables.CFF) {
      error.raise(10302);
    }
    font.readOptions = this.options;

    /* 预构建表名列表，替代 for...in 遍历 */
    const otfTableNames = ["head", "maxp", "cmap", "name", "hhea", "hmtx", "post", "OS/2", "CFF", "GPOS", "kern"];
    for (let ti = 0, tl = otfTableNames.length; ti < tl; ti++) {
      const tableName = otfTableNames[ti];
      if (font.tables[tableName]) {
        const offset = font.tables[tableName].offset;
        font[tableName] = new otfSupport[tableName](offset).read(reader, font);
      }
    }
    if (!font.CFF.glyf) {
      error.raise(10303);
    }
    reader.dispose();
    return font;
  }

  /**
   * 关联glyf相关的信息
   *
   * @param font font对象
   */
  resolveGlyf(font: OtfObject): void {
    let glyf = font.CFF.glyf;
    const codes = font.cmap;
    const subsetMap = font.readOptions.subset ? font.subsetMap : null;
    /**
     * subset 模式下只遍历 subset unicode 列表（O(S)），避免全 cmap 遍历（O(U)）
     * 思源等大 CID 字体 cmap 有数万映射，原 Object.keys + 全量循环开销显著
     */
    if (subsetMap && font.readOptions.subset && font.readOptions.subset.length > 0) {
      const subsetList = font.readOptions.subset;
      for (let si = 0, sl = subsetList.length; si < sl; si++) {
        const cp = subsetList[si];
        const gid = codes[cp];
        if (gid === undefined) continue;
        if (!subsetMap[gid]) continue;
        if (!glyf[gid].unicode) glyf[gid].unicode = [];
        glyf[gid].unicode.push(cp);
      }
    } else {
      /* subsetMap 检查提到循环外，消除每次迭代的分支判断 */
      const cmapKeys = Object.keys(codes);
      if (subsetMap) {
        for (let ki = 0, kl = cmapKeys.length; ki < kl; ki++) {
          const c = cmapKeys[ki];
          const i = codes[c];
          if (!subsetMap[i]) continue;
          if (!glyf[i].unicode) glyf[i].unicode = [];
          glyf[i].unicode.push(+c);
        }
      } else {
        for (let ki2 = 0, kl2 = cmapKeys.length; ki2 < kl2; ki2++) {
          const c2 = cmapKeys[ki2];
          const i2 = codes[c2];
          if (!glyf[i2].unicode) glyf[i2].unicode = [];
          glyf[i2].unicode.push(+c2);
        }
      }
    }

    /* leftSideBearing / advanceWidth —— 兼容扁平 Int32Array 和对象数组 */
    const hmtxData = font.hmtx;
    const isFlat = hmtxData instanceof Int32Array;
    const hLen = isFlat ? hmtxData.length / 2 : hmtxData.length;
    /**
     * subset 模式下遍历 subsetGids（O(S)），避免全 hmtx 遍历（O(U)）
     */
    if (subsetMap && font.subsetGids) {
      const sGids = font.subsetGids;
      if (isFlat) {
        for (let gi = 0, gl = sGids.length; gi < gl; gi++) {
          const gid2 = sGids[gi];
          glyf[gid2].advanceWidth = hmtxData[gid2 * 2] || 0;
          glyf[gid2].leftSideBearing = hmtxData[gid2 * 2 + 1];
        }
      } else {
        for (let gi2 = 0, gl2 = sGids.length; gi2 < gl2; gi2++) {
          const gid3 = sGids[gi2];
          glyf[gid3].advanceWidth = hmtxData[gid3].advanceWidth || 0;
          glyf[gid3].leftSideBearing = hmtxData[gid3].leftSideBearing;
        }
      }
    } else if (subsetMap) {
      if (isFlat) {
        for (let hi = 0, j = 0; hi < hLen; hi++, j += 2) {
          if (!subsetMap[hi]) continue;
          glyf[hi].advanceWidth = hmtxData[j] || 0;
          glyf[hi].leftSideBearing = hmtxData[j + 1];
        }
      } else {
        for (let hi = 0; hi < hLen; hi++) {
          if (!subsetMap[hi]) continue;
          glyf[hi].advanceWidth = hmtxData[hi].advanceWidth || 0;
          glyf[hi].leftSideBearing = hmtxData[hi].leftSideBearing;
        }
      }
    } else {
      if (isFlat) {
        for (let hi = 0, j = 0; hi < hLen; hi++, j += 2) {
          glyf[hi].advanceWidth = hmtxData[j] || 0;
          glyf[hi].leftSideBearing = hmtxData[j + 1];
        }
      } else {
        for (let hi = 0; hi < hLen; hi++) {
          glyf[hi].advanceWidth = hmtxData[hi].advanceWidth || 0;
          glyf[hi].leftSideBearing = hmtxData[hi].leftSideBearing;
        }
      }
    }

    // 设置了subsetMap之后需要选取subset中的字形
    /* 密集数组替代 for...in，消除字符串键转换 */
    if (subsetMap) {
      const subsetGids = font.subsetGids;
      let subGlyf;
      if (subsetGids) {
        subGlyf = new Array(subsetGids.length);
        for (let si = 0, sl = subsetGids.length; si < sl; si++) {
          subGlyf[si] = glyf[subsetGids[si]];
        }
      } else {
        subGlyf = [];
        const subsetKeys = Object.keys(subsetMap);
        for (let si = 0, sl = subsetKeys.length; si < sl; si++) {
          subGlyf.push(glyf[+subsetKeys[si]]);
        }
      }
      glyf = subGlyf;
    }
    font.glyf = glyf;
  }

  /**
   * 清除非必须的表
   *
   * @param font font对象
   */
  cleanTables(font: OtfObject): void {
    /* delete → null 赋值，避免 V8 隐藏类转换 */
    font.readOptions = null;
    font.tables = null;
    font.hmtx = null;
    font.post.glyphNameIndex = null;
    font.post.names = null;
    font.subsetMap = null;

    // 清除无用的表
    const cff = font.CFF;
    cff.glyf = null;
    cff.charset = null;
    cff.encoding = null;
    cff.gsubrs = null;
    cff.gsubrsBias = null;
    cff.subrs = null;
    cff.subrsBias = null;
  }

  /**
   * 获取解析后的ttf文档
   *
   * @param buffer buffer对象
   * @return ttf文档
   */
  read(buffer: ArrayBuffer): OtfObject {
    this.font = this.readBuffer(buffer);
    this.resolveGlyf(this.font);
    this.cleanTables(this.font);
    return this.font;
  }

  /**
   * 注销
   */
  dispose(): void {
    /* delete → null 赋值，避免 V8 隐藏类转换 */
    this.font = null;
    this.options = null as unknown as OTFReaderOptions;
  }
}
