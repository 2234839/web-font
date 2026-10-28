/**
 * table 层 JS→TS 迁移的字节级一致性验证
 *
 * 双管线对比：旧 .js 表模块（CJS require）vs 新 .ts 表模块（ESM import），
 * 对真实字体执行 读(read) / 写(write) 全流程：
 *  1. read：分别用旧/新模块组装 mini-ttfreader，对同一字体 buffer 逐表读取，深度对比结果对象；
 *  2. write：各自把读出的 ttf 对象写回 buffer，逐字节对比；
 *  3. CFF：用 OTF 字体走 support-otf 双管线，对比 CFF/name/post 等表读取结果。
 *
 * 运行：bun scripts/verify_table_migration.ts
 */
import Reader from "../vendor/fonteditor-core/lib/ttf/reader";
import Writer from "../vendor/fonteditor-core/lib/ttf/writer";
import { checkSumArrayBuffer } from "../vendor/fonteditor-core/lib/ttf/util/checkSum";
import type { TableFullWriter, TableInstance } from "../vendor/fonteditor-core/lib/ttf/table/table";
import directoryNew from "../vendor/fonteditor-core/lib/ttf/table/directory";
import supportNew from "../vendor/fonteditor-core/lib/ttf/table/support";
import supportOtfNew from "../vendor/fonteditor-core/lib/ttf/table/support-otf";
import { createRequire } from "node:module";
import ttfreaderDefault from "../vendor/fonteditor-core/lib/ttf/ttfreader";

const require = createRequire(import.meta.url);
const TABLE_DIR = "../vendor/fonteditor-core/lib/ttf/table";
/** 从旧 .js 模块取 CJS 导出（exports.default） */
const loadOld = (name: string) => require(`${TABLE_DIR}/${name}.js`).default;

/* ------------------------------------------------------------------ *
 * 旧管线模块（显式 .js；缺失 .js 的表（OS2 等）由旧 support.js 自行解析到 .ts）
 * ------------------------------------------------------------------ */
const supportOld: Record<string, any> = {};
for (const n of ["head", "maxp", "loca", "cmap", "glyf", "name", "hhea", "hmtx", "post", "fpgm", "cvt", "prep", "gasp", "BASE", "GPOS", "GSUB", "kern", "kerx"]) {
  supportOld[n] = loadOld(n);
}
supportOld["OS/2"] = supportNew["OS/2"];
const directoryOld = loadOld("directory");
const supportOtfOld = loadOld("support-otf");
/* support-otf.js 里没有的引用保持与新版一致，避免缺表 */
for (const k of Object.keys(supportOtfNew)) {
  if (!(k in supportOtfOld)) {
    supportOtfOld[k] = (supportOtfNew as Record<string, any>)[k];
  }
}

/* ------------------------------------------------------------------ *
 * mini 读取器（复刻 ttfreader.readBuffer 的表遍历，模块映射可注入）
 * ------------------------------------------------------------------ */
const READ_TABLE_NAMES = [
  "head", "maxp", "loca", "cmap", "glyf", "name", "hhea", "hmtx",
  "post", "OS/2", "fpgm", "cvt", "prep", "gasp", "BASE", "GPOS", "GSUB", "kern", "kerx",
];

interface ReadOptions {
  hinting: boolean;
  kerning: boolean;
  subset?: number[];
}

/** mini ttf 读取器 */
function readTTF(buffer: ArrayBuffer, supportMap: Record<string, any>, DirectoryCtor: any, options: ReadOptions): Record<string, any> {
  const reader = new Reader(buffer, 0, buffer.byteLength, false);
  const ttf: Record<string, any> = {};

  const view = reader.view!;
  const vOffset = view.byteOffset;
  ttf.version = view.getInt32(vOffset, false) / 65536.0;
  ttf.numTables = view.getUint16(vOffset + 4, false);
  ttf.searchRange = view.getUint16(vOffset + 6, false);
  ttf.entrySelector = view.getUint16(vOffset + 8, false);
  ttf.rangeShift = view.getUint16(vOffset + 10, false);
  reader.offset = 12;

  ttf.tables = new DirectoryCtor(reader.offset).read(reader, ttf);
  ttf.readOptions = options;

  for (const tableName of READ_TABLE_NAMES) {
    if (!ttf.tables[tableName]) {
      continue;
    }
    if (!options.hinting && (tableName === "fpgm" || tableName === "cvt" || tableName === "prep" || tableName === "gasp")) {
      continue;
    }
    if (!options.hinting && !options.kerning && (tableName === "GPOS" || tableName === "GSUB" || tableName === "kern" || tableName === "kerx")) {
      continue;
    }
    const offset = ttf.tables[tableName].offset;
    ttf[tableName] = new supportMap[tableName](offset).read(reader, ttf);
  }
  reader.dispose();
  return ttf;
}

/** OTF/CFF 读取（复刻 otfreader 的表遍历） */
function readOTF(buffer: ArrayBuffer, supportMap: Record<string, any>, DirectoryCtor: any, options: ReadOptions): Record<string, any> {
  const reader = new Reader(buffer, 0, buffer.byteLength, false);
  const ttf: Record<string, any> = {};
  const view = reader.view!;
  const vOffset = view.byteOffset;
  ttf.version = view.getInt32(vOffset, false);
  ttf.numTables = view.getUint16(vOffset + 4, false);
  reader.offset = 12;
  ttf.tables = new DirectoryCtor(reader.offset).read(reader, ttf);
  ttf.readOptions = options;
  for (const tableName of ["head", "maxp", "cmap", "name", "hhea", "hmtx", "post", "OS/2", "CFF"]) {
    if (!ttf.tables[tableName]) {
      continue;
    }
    ttf[tableName] = new supportMap[tableName](ttf.tables[tableName].offset).read(reader, ttf);
  }
  reader.dispose();
  return ttf;
}

/* ------------------------------------------------------------------ *
 * mini 写出器（复刻 ttfwriter.dump，模块映射可注入；checksum 走真实计算）
 * ------------------------------------------------------------------ */
const WRITE_TABLE_NAMES = [
  "head", "hhea", "maxp", "hmtx", "cmap", "loca", "glyf", "name", "post", "OS/2",
  "cvt", "fpgm", "prep", "gasp", "GPOS", "GSUB", "kern", "kerx", "BASE",
];

/** mini ttf 写出器 */
function writeTTF(ttf: Record<string, any>, supportMap: Record<string, any>, DirectoryCtor: any): ArrayBuffer {
  ttf.support = {};
  const writeTables = WRITE_TABLE_NAMES.filter((n) => ttf[n]);
  let ttfSize = 12 + writeTables.length * 16;
  let ttfHeadOffset = 0;

  const tableInstances: Record<string, TableInstance> = {};
  const supportTablesArr: any[] = new Array(writeTables.length);
  ttf.support.tables = supportTablesArr;
  for (let ti = 0; ti < writeTables.length; ti++) {
    const tableName = writeTables[ti];
    const offset = ttfSize;
    if (!tableInstances[tableName]) {
      tableInstances[tableName] = new supportMap[tableName]();
    }
    const tableSize = tableInstances[tableName].size!(ttf);
    if (tableName === "head") {
      ttfHeadOffset = offset;
    }
    const size = (tableSize + 3) & ~3;
    supportTablesArr[ti] = { name: tableName, checkSum: 0, offset, length: tableSize, size };
    ttfSize += size;
  }
  ttf.writeOptions = { tables: writeTables };

  const writer = new Writer(new ArrayBuffer(ttfSize));
  const wView = writer.view;
  let pos = writer.offset;
  wView.setInt32(pos, ttf.version * 65536 + 0.5 | 0, false); pos += 4;
  wView.setUint16(pos, ttf.numTables, false); pos += 2;
  wView.setUint16(pos, ttf.searchRange, false); pos += 2;
  wView.setUint16(pos, ttf.entrySelector, false); pos += 2;
  wView.setUint16(pos, ttf.rangeShift, false); pos += 2;
  writer.offset = pos;

  new DirectoryCtor().write(writer, ttf);

  const buf = writer.getBuffer();
  const fullView = new Uint8Array(buf);
  const fullDataView = new DataView(buf);
  let wholeCheckSum = 0;
  for (const table of supportTablesArr) {
    const tableStart = writer.offset;
    tableInstances[table.name].write(writer, ttf);
    const pad = table.length % 4;
    if (pad) {
      fullView.fill(0, wView.byteOffset + writer.offset, wView.byteOffset + writer.offset + (4 - pad));
      writer.offset += 4 - pad;
    }
    table.checkSum = checkSumArrayBuffer(buf, tableStart, table.size, fullView, fullDataView);
    wholeCheckSum = (wholeCheckSum + table.checkSum) >>> 0;
  }
  for (let ci = 0; ci < supportTablesArr.length; ci++) {
    wView.setUint32(12 + ci * 16 + 4, supportTablesArr[ci].checkSum, false);
  }
  wView.setUint32(ttfHeadOffset + 8, (0xB1B0AFBA - wholeCheckSum) >>> 0, false);
  writer.dispose();
  return buf;
}

/* ------------------------------------------------------------------ *
 * 深度对比（函数属性标记为 [fn] 不参与比对，其余结构化序列化）
 * ------------------------------------------------------------------ */
/** 结构化序列化 */
function canon(v: any, depth = 0): string {
  if (v === null || v === undefined) {
    return String(v);
  }
  if (typeof v === "function") {
    return "[fn]";
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
    return typeof v + ":" + v;
  }
  if (v instanceof Date) {
    return "Date:" + v.getTime();
  }
  if (v instanceof ArrayBuffer) {
    return "AB:" + Buffer.from(new Uint8Array(v)).toString("hex");
  }
  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) {
      return "DV:" + Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).toString("hex");
    }
    return v.constructor.name + ":" + Array.from(v as unknown as ArrayLike<number>).join(",");
  }
  if (depth > 24) {
    return "[depth]";
  }
  if (Array.isArray(v)) {
    return "[" + v.map((x) => canon(x, depth + 1)).join("|") + "]";
  }
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => k + "=" + canon(v[k], depth + 1)).join(",") + "}";
}

/* ------------------------------------------------------------------ *
 * 验证执行
 * ------------------------------------------------------------------ */
let failed = 0;
let passed = 0;

/** 断言相等 */
function assertEq(what: string, a: string, b: string) {
  if (a === b) {
    passed++;
    console.log(`  ✅ ${what}`);
  } else {
    failed++;
    console.error(`  ❌ ${what}`);
    if (a.length < 400 && b.length < 400) {
      console.error(`     新: ${a.slice(0, 200)}\n     旧: ${b.slice(0, 200)}`);
    }
  }
}

/** 对单字体做读写全流程对比 */
function verifyTTF(path: string, options: ReadOptions) {
  console.log(`\n▶ ${path}${options.subset ? " [subset=" + options.subset.length + "字]" : ""}`);
  const u8 = require("fs").readFileSync(path);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  const ttfNew = readTTF(ab, supportNew, directoryNew, options);
  const ttfOld = readTTF(ab, supportOld, directoryOld, options);

  /* subset 模式下复刻 ttfreader.resolveGlyf（共享代码，两侧一致应用）后再写 */
  if (options.subset && options.subset.length > 0) {
    const resolveGlyf = (ttfreaderDefault.prototype as any).resolveGlyf;
    resolveGlyf.call(null, ttfNew);
    resolveGlyf.call(null, ttfOld);
  }

  assertEq("directory.read", canon(ttfNew.tables), canon(ttfOld.tables));
  for (const n of READ_TABLE_NAMES) {
    if (ttfNew[n] !== undefined || ttfOld[n] !== undefined) {
      assertEq(`read.${n}`, canon(ttfNew[n]), canon(ttfOld[n]));
    }
  }

  const bufNew = writeTTF(ttfNew, supportNew, directoryNew);
  const bufOld = writeTTF(ttfOld, supportOld, directoryOld);
  const hexNew = Buffer.from(new Uint8Array(bufNew)).toString("hex");
  const hexOld = Buffer.from(new Uint8Array(bufOld)).toString("hex");
  assertEq(`write(${hexNew.length / 2}B)`, hexNew, hexOld);
}

/** 对 OTF/CFF 字体做读取对比 */
function verifyOTF(path: string, options: ReadOptions) {
  console.log(`\n▶ ${path} [OTF/CFF]${options.subset ? " [subset]" : ""}`);
  const u8 = require("fs").readFileSync(path);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  const ttfNew = readOTF(ab, supportOtfNew, directoryNew, options);
  const ttfOld = readOTF(ab, supportOtfOld, directoryOld, options);
  assertEq("directory.read", canon(ttfNew.tables), canon(ttfOld.tables));
  for (const n of ["head", "maxp", "cmap", "name", "hmtx", "post", "OS/2", "CFF"]) {
    if (ttfNew[n] !== undefined || ttfOld[n] !== undefined) {
      assertEq(`read.${n}`, canon(ttfNew[n]), canon(ttfOld[n]));
    }
  }
}

const FULL: ReadOptions = { hinting: true, kerning: true };
const NOHINT: ReadOptions = { hinting: false, kerning: false };
const SUBSET: ReadOptions = { hinting: false, kerning: false, subset: "天地玄黄宇宙洪荒web-font验证中文字体0123".split("").map((c) => c.codePointAt(0)!) };

verifyTTF("font/得意黑.ttf", FULL);
verifyTTF("font/得意黑.ttf", NOHINT);
verifyTTF("font/得意黑.ttf", SUBSET);
verifyTTF("font/初夏明朝.ttf", FULL);
verifyTTF("font/令东齐伋复刻体.ttf", NOHINT);
verifyTTF("font/鸿蒙黑体.ttf", NOHINT);
verifyTTF("font/优设标题黑.ttf", FULL);
verifyOTF("/usr/share/fonts/opentype/font-awesome/FontAwesome.otf", FULL);
verifyOTF("/usr/share/fonts/opentype/font-awesome/FontAwesome.otf", SUBSET);

console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed > 0 ? 1 : 0);
