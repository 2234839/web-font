/**
 * @file ttf写入器
 * @author mengke01(kekee000@gmail.com)
 */
import Writer from "./writer";
import directory from "./table/directory";
import support from "./table/support";
import { checkSumArrayBuffer } from "./util/checkSum";
import error from "./error";

/** 表实例公共形状（directory 实例无 size，故 size 可选） */
interface TableInstance {
  /**
   * 计算表大小
   */
  size?(ttf: unknown): number;
  /**
   * 写入表内容
   */
  write(writer: unknown, ttf: unknown): void;
}

/** directory 表项条目 */
interface SupportTableEntry {
  /** 表名 */
  name: string;
  /** 校验和 */
  checkSum: number;
  /** 偏移 */
  offset: number;
  /** 长度 */
  length: number;
  /** 4 字节对齐后的大小 */
  size: number;
}

/** ttf.support 对象形状 */
interface TtfSupport {
  /** 表项列表（写入前为空，由 dump 填充） */
  tables?: SupportTableEntry[];
}

/** ttf.writeOptions 对象形状 */
interface TtfWriteOptions {
  /** 是否写零轮廓字形数据 */
  writeZeroContoursGlyfData: boolean;
  /** 是否写 hinting 表 */
  hinting: boolean;
  /** 是否写 kerning 表 */
  kerning: boolean;
  /** 待写入的表名列表 */
  tables: string[];
}

/** glyf 轮廓最小形状（仅消费 unicode 字段） */
interface GlyfItem {
  /** unicode 码点列表 */
  unicode?: number[];
}

/** head 表最小形状（仅消费 ttfwriter 触达的字段） */
interface TtfHead {
  /** 校验和调整值 */
  checkSumAdjustment: number;
  /** 魔数 */
  magickNumber: number;
  /** 创建时间（时间戳或日期字符串） */
  created: number | string;
  /** 修改时间（时间戳或日期字符串） */
  modified: number | string;
}

/** TTF 数据对象最小形状（仅 ttfwriter 消费的字段） */
interface TtfData {
  /** 版本号 */
  version: number;
  /** 表数量 */
  numTables: number;
  /** 二分选择子 */
  entrySelector: number;
  /** 搜索范围 */
  searchRange: number;
  /** 范围偏移 */
  rangeShift: number;
  /** head 表 */
  head: TtfHead;
  /** 字形列表 */
  glyf: GlyfItem[];
  /** name 表 */
  name: unknown;
  /** OS/2 表 */
  "OS/2": unknown;
  /** unicode 是否已排序去重 */
  _unicodeSorted?: boolean;
  /** 写入选项（dump 结束后置 null） */
  writeOptions: TtfWriteOptions | null;
  /** 支持表信息（dump 结束后置 null） */
  support: TtfSupport | null;
  /** cvt 表 */
  cvt?: unknown;
  /** fpgm 表 */
  fpgm?: unknown;
  /** prep 表 */
  prep?: unknown;
  /** gasp 表 */
  gasp?: unknown;
  /** BASE 表 */
  BASE?: unknown;
  /** GPOS 表 */
  GPOS?: unknown;
  /** GSUB 表 */
  GSUB?: unknown;
  /** kern 表 */
  kern?: unknown;
  /** kerx 表 */
  kerx?: unknown;
}

/** TTFWriter 构造选项 */
interface TTFWriterOptions {
  /** 是否写零轮廓字形数据 */
  writeZeroContoursGlyfData?: boolean;
  /** 是否写 hinting 相关表 */
  hinting?: boolean;
  /** 是否写 kerning 相关表 */
  kerning?: boolean;
  /** 支持表信息覆写 */
  support?: TtfSupport;
  /** 是否跳过 checksum 计算（woff2/woff/eot 输出时） */
  skipCheckSum?: boolean;
}

/** ttf 写入支持的默认表集合 */
const SUPPORT_TABLES = ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
/** 优化291: 日期正则预编译为模块级常量 */
const ALL_DIGITS = /^\d+$/;

export default class TTFWriter {
  /**
   * 写入选项（dispose 后置 null）
   */
  options: TTFWriterOptions | null;

  constructor(options: TTFWriterOptions = {}) {
    this.options = {
      writeZeroContoursGlyfData: options.writeZeroContoursGlyfData || false,
      hinting: options.hinting || false,
      kerning: options.kerning || false,
      support: options.support,
      /** 优化316: woff2/woff/eot 输出会重新编码，不消费 TTF directory 的 per-table checksum 与
       *  head.checkSumAdjustment（encodeTTFToWOFF2 只读 directory 的 tag/offset/length，重建自己的 directory）。
       *  跳过 checksum 计算可省大字集下 ~5% 的 checkSumArrayBuffer 开销。head.checkSumAdjustment 保持 0 占位
       *  （resolveTTF 已置 0），浏览器渲染不依赖该字段。仅 ttf 直出（消费 directory checksum）时不能跳过。 */
      skipCheckSum: options.skipCheckSum || false
    };
  }

  /**
   * 优化4+46: resolveTTF 中 unicode 排序修正 + forEach → for 循环
   */
  resolveTTF(ttf: TtfData) {
    ttf.version = ttf.version || 0x1;
    ttf.numTables = ttf.writeOptions!.tables.length;
    ttf.entrySelector = 31 - Math.clz32(ttf.numTables);
    ttf.searchRange = 2 << ttf.entrySelector;
    ttf.rangeShift = ttf.numTables * 16 - ttf.searchRange;

    ttf.head.checkSumAdjustment = 0;
    ttf.head.magickNumber = 0x5F0F3CF5;
    if (typeof ttf.head.created === 'string') {
      ttf.head.created = ALL_DIGITS.test(ttf.head.created) ? +ttf.head.created : Date.parse(ttf.head.created);
    }
    if (typeof ttf.head.modified === 'string') {
      ttf.head.modified = /^\d+$/.test(ttf.head.modified) ? +ttf.head.modified : Date.parse(ttf.head.modified);
    }
    if (!ttf.head.created) {
      ttf.head.created = Date.now();
    }
    if (!ttf.head.modified) {
      ttf.head.modified = ttf.head.created;
    }
    /* 优化112+145: optimizettf 已排序 unicode 并检查重复，跳过冗余工作；延迟分配 checkUnicodeRepeat */
    if (!ttf._unicodeSorted) {
      const checkUnicodeRepeat: Record<number, boolean> = {};
      const glyfs = ttf.glyf;
      for (let index = 0, gl = glyfs.length; index < gl; index++) {
        const glyf = glyfs[index];
        if (glyf.unicode) {
          glyf.unicode.sort(function (a, b) { return a - b; });
          const unicode = glyf.unicode;
          for (let ui = 0, ul = unicode.length; ui < ul; ui++) {
            const u = unicode[ui];
            if (checkUnicodeRepeat[u]) {
              error.raise({ number: 10200, data: index }, index);
            } else {
              checkUnicodeRepeat[u] = true;
            }
          }
        }
      }
    }
  }

  dump(ttf: TtfData) {
    /** 优化286: support 为 undefined 时直接赋值空对象，避免 Object.assign 调用 */
    ttf.support = this.options!.support ? Object.assign({}, this.options!.support) : {};
    let ttfSize = 12 + ttf.numTables * 16;
    let ttfHeadOffset = 0;

    /* 优化35+56: 缓存 TableClass 实例，forEach → for 循环 */
    const writeTables = ttf.writeOptions!.tables;
    const supportTables = support;
    const tableInstances: Record<string, TableInstance> = {};
    const supportTablesArr = new Array<SupportTableEntry>(writeTables.length);
    ttf.support.tables = supportTablesArr;
    for (let ti = 0, tl = writeTables.length; ti < tl; ti++) {
      const tableName = writeTables[ti];
      const offset = ttfSize;
      if (!tableInstances[tableName]) {
        tableInstances[tableName] = new supportTables[tableName]();
      }
      const tableSize = tableInstances[tableName].size!(ttf);
      let size = tableSize;
      if (tableName === 'head') {
        ttfHeadOffset = offset;
      }
      size = (size + 3) & ~3;
      supportTablesArr[ti] = {
        name: tableName,
        checkSum: 0,
        offset: offset,
        length: tableSize,
        size: size
      };
      ttfSize += size;
    }
    const writer = new Writer(new ArrayBuffer(ttfSize));

    /* 优化36+184: 头部直接 view 写入，Math.round 替换为位运算 */
    const wView = writer.view;
    let pos = writer.offset;
    wView.setInt32(pos, ttf.version * 65536 + 0.5 | 0, false); pos += 4;
    wView.setUint16(pos, ttf.numTables, false); pos += 2;
    wView.setUint16(pos, ttf.searchRange, false); pos += 2;
    wView.setUint16(pos, ttf.entrySelector, false); pos += 2;
    wView.setUint16(pos, ttf.rangeShift, false); pos += 2;
    writer.offset = pos;

    /* 优化: directory 实例复用 tableInstances 缓存 */
    if (!tableInstances['directory']) {
      tableInstances['directory'] = new directory();
    }
    tableInstances['directory'].write(writer, ttf);

    /* 优化56+87+179+184: forEach → for 循环，缓存 buffer 引用，累加各表校验和避免全局重算
     * 优化184: 内联 writeEmpty 为 fullView.fill(0)，避免 writer.writeEmpty 的函数调用 + 边界检查开销 */
    const supportTableList = ttf.support.tables;
    const buf = writer.getBuffer();
    /** 优化316: skipCheckSum（woff2/woff/eot）时跳过 checksum 计算，head.checkSumAdjustment 保持 0 占位 */
    const skipCheckSum = this.options!.skipCheckSum;
    let wholeCheckSum = 0;
    /** fullView 仍需用于表 padding fill(0)，skipCheckSum 时不必创建 fullDataView */
    const fullView = new Uint8Array(buf);
    const fullDataView = skipCheckSum ? null : new DataView(buf);
    for (let si = 0, sl = supportTableList!.length; si < sl; si++) {
      const table = supportTableList![si];
      const tableStart = writer.offset;
      const tName = table.name;
      if (!tableInstances[tName]) {
        tableInstances[tName] = new supportTables[tName]();
      }
      tableInstances[tName].write(writer, ttf);
      const pad = table.length % 4;
      if (pad) {
        fullView.fill(0, wView.byteOffset + writer.offset, wView.byteOffset + writer.offset + (4 - pad));
        writer.offset += 4 - pad;
      }
      if (!skipCheckSum) {
        table.checkSum = checkSumArrayBuffer(buf, tableStart, table.size, fullView, fullDataView);
        wholeCheckSum = (wholeCheckSum + table.checkSum) >>> 0;
      }
    }

    if (!skipCheckSum) {
      /* 优化111: 重新写入校验和，直接 view 写入 */
      const csView = writer.view;
      for (let ci = 0, cl = supportTableList!.length; ci < cl; ci++) {
        const offset2 = 12 + ci * 16 + 4;
        csView.setUint32(offset2, supportTableList![ci].checkSum, false);
      }

      /* 优化179: 用累加的各表校验和替代全局 checkSum，避免重遍历整个 buffer */
      const ttfCheckSum = (0xB1B0AFBA - wholeCheckSum) >>> 0;
      csView.setUint32(ttfHeadOffset + 8, ttfCheckSum, false);
    }
    /** 优化260: delete → null 赋值，避免 V8 隐藏类转换 */
    ttf.writeOptions = null;
    ttf.support = null;
    writer.dispose();
    return buf;
  }

  prepareDump(ttf: TtfData) {
    if (!ttf.glyf || ttf.glyf.length === 0) {
      error.raise(10201);
    }
    if (!ttf['OS/2'] || !ttf.head || !ttf.name) {
      error.raise(10204);
    }
    /* 优化: 无 hinting/kerning 时直接使用 SUPPORT_TABLES，避免 concat 开销 */
    /* 优化186: 使用 slice() 创建副本，防止 push 变异模块级数组导致后续调用表膨胀 */
    let tables = SUPPORT_TABLES;
    /* 优化228+291: 合并 hinting 和 kerning 分支，消除重复表名 */
    if (this.options!.hinting || this.options!.kerning) {
      tables = SUPPORT_TABLES.slice();
      /** 优化291: 使用 Set 去重，防止 hinting+kerning 同时开启时 GPOS/kern/kerx 被重复 push */
      const added: Record<string, boolean> = {};
      if (this.options!.hinting) {
        const hintTables = ['cvt', 'fpgm', 'prep', 'gasp', 'GPOS', 'kern', 'kerx'] as const;
        for (let i = 0; i < hintTables.length; i++) {
          const tn = hintTables[i];
          if (ttf[tn] && !added[tn]) {
            tables.push(tn);
            added[tn] = true;
          }
        }
      }
      if (this.options!.kerning) {
        const kernTables = ['GPOS', 'GSUB', 'kern', 'kerx'] as const;
        for (let j = 0; j < kernTables.length; j++) {
          const kn = kernTables[j];
          if (ttf[kn] && !added[kn]) {
            tables.push(kn);
            added[kn] = true;
          }
        }
      }
    }
    /** BASE 是排版基线表（非 hinting bytecode），存在即写，与 hinting/kerning 开关无关
     *  （SUPPORT_TABLES 不含 BASE，无重复风险） */
    if (ttf['BASE']) {
      tables = tables.slice();
      tables.push('BASE');
    }
    ttf.writeOptions = {
      writeZeroContoursGlyfData: !!this.options!.writeZeroContoursGlyfData,
      hinting: !!this.options!.hinting,
      kerning: !!this.options!.kerning,
      /* 优化144: SUPPORT_TABLES 已有序，hint/kern 表名按字母序追加，无需 sort() */
      tables: tables
    };
  }

  write(ttf: TtfData) {
    this.prepareDump(ttf);
    this.resolveTTF(ttf);
    const buffer = this.dump(ttf);
    return buffer;
  }

  dispose() {
    /** 优化262: delete → null 赋值，避免 V8 隐藏类转换 */
    this.options = null;
  }
}
