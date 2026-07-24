import fs from 'node:fs';
import * as TTFReaderNS from './vendor/fonteditor-core/lib/ttf/ttfreader.js';
const TTFReader: any = TTFReaderNS.default.default ?? TTFReaderNS.default;
const support: any = (await import('./vendor/fonteditor-core/lib/ttf/table/support.js')).default.default ?? (await import('./vendor/fonteditor-core/lib/ttf/table/support.js')).default;

const buf = fs.readFileSync('/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const cps = Array.from('，。！？、；：“”‘’').map(c => c.codePointAt(0)!);

// 先拿到 reader + tables 目录
const r0 = new (TTFReader as any)({ subset: cps, kerning: true });
// 手动复刻 readBuffer 前半，拿 reader + tables
const Reader = (await import('./vendor/fonteditor-core/lib/ttf/reader.js')).default.default ?? (await import('./vendor/fonteditor-core/lib/ttf/reader.js')).default;
const Directory = (await import('./vendor/fonteditor-core/lib/ttf/directory.js')).default.default ?? (await import('./vendor/fonteditor-core/lib/ttf/directory.js')).default;

function makeReader() {
  const reader = new Reader(ab, 0, ab.byteLength, false);
  reader.offset = 12;
  return reader;
}

// 各表独立计时
function timeTable(tableName: string, iters = 15) {
  const TableClass = support[tableName];
  if (!TableClass) { console.log(`  ${tableName}: 无 support 类`); return; }
  // warmup + 计时
  const ts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const reader = makeReader();
    const dir = new Directory(12).read(reader, {});
    if (!dir[tableName]) return;
    const tc = new TableClass(dir[tableName].offset);
    tc.read(reader, { tables: dir, readOptions: { subset: cps, kerning: true } } as any);
  }
  for (let i = 0; i < iters; i++) {
    const reader = makeReader();
    const dir = new Directory(12).read(reader, {});
    const tc = new TableClass(dir[tableName].offset);
    const t0 = performance.now();
    tc.read(reader, { tables: dir, readOptions: { subset: cps, kerning: true } } as any);
    ts.push(performance.now() - t0);
  }
  ts.sort((a,b)=>a-b);
  console.log(`  ${tableName}: ${ts[Math.floor(ts.length/2)].toFixed(3)}ms (min ${ts[0].toFixed(3)})`);
}

console.log('=== 初夏标点 各表 read 耗时 ===');
for (const t of ['head','hhea','maxp','OS/2','name','cmap','hmtx','vmtx','GPOS','GSUB','post']) {
  timeTable(t);
}
