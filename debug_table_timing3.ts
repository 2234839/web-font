/**
 * 精确表读取计时
 */
import { readFile } from "node:fs/promises";

const FONT_PATH = "font/令东齐伋复刻体.ttf";
const raw = await readFile(FONT_PATH);
const fontBuffer = new Uint8Array(raw).buffer;

const ROUNDS = 20;
const tableTimes: Record<string, number> = {};

for (let r = 0; r < ROUNDS; r++) {
  const ReaderModule = await import("./vendor/fonteditor-core/lib/ttf/reader.js");
  const Reader = (ReaderModule as any).default || ReaderModule;
  const DirectoryModule = await import("./vendor/fonteditor-core/lib/ttf/table/directory.js");
  const Directory = (DirectoryModule as any).default || DirectoryModule;
  const supportModule = await import("./vendor/fonteditor-core/lib/ttf/table/support.js");
  const support = (supportModule as any).default || supportModule;

  const reader = new Reader(fontBuffer, 0, fontBuffer.byteLength, false);
  const ttf: any = {};

  ttf.version = reader.readFixed(0);
  ttf.numTables = reader.readUint16();
  ttf.searchRange = reader.readUint16();
  ttf.entrySelector = reader.readUint16();
  ttf.rangeShift = reader.readUint16();
  ttf.tables = new Directory(reader.offset).read(reader, ttf);
  ttf.readOptions = { subset: [..."天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔"].map(c => c.codePointAt(0)) };

  for (const tableName of Object.keys(support)) {
    if (ttf.tables[tableName]) {
      const offset = ttf.tables[tableName].offset;
      const t0 = performance.now();
      ttf[tableName] = new support[tableName](offset).read(reader, ttf);
      const t1 = performance.now();
      tableTimes[tableName] = (tableTimes[tableName] || 0) + (t1 - t0);
    }
  }
  reader.dispose();
}

const total = Object.values(tableTimes).reduce((a: number, b: number) => a + b, 0);
const sorted = Object.entries(tableTimes).sort((a, b) => b[1] - a[1]);

console.log(`表读取时间 (${ROUNDS} rounds):`);
for (const [name, time] of sorted) {
  console.log(`  ${name.padEnd(8)} ${time.toFixed(1).padStart(8)}ms  ${(time / total * 100).toFixed(1).padStart(3)}%`);
}
console.log(`  ${'total'.padEnd(8)} ${total.toFixed(1).padStart(8)}ms`);
