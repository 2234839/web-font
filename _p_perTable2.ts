import fs from 'node:fs';
import * as TTFReaderNS from './vendor/fonteditor-core/lib/ttf/ttfreader.js';
const TTFReader: any = TTFReaderNS.default.default ?? TTFReaderNS.default;
const supportNS: any = await import('./vendor/fonteditor-core/lib/ttf/table/support.js');
const support: any = supportNS.default.default ?? supportNS.default;

const buf = fs.readFileSync('/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const cps = Array.from('，。！？、；：“”‘’').map(c => c.codePointAt(0)!);

// monkey-patch 每个表类的 read，累加耗时
const stats: Record<string, number[]> = {};
for (const tn of Object.keys(support)) {
  const TableClass: any = support[tn];
  if (!TableClass || !TableClass.prototype || !TableClass.prototype.read) continue;
  const orig = TableClass.prototype.read;
  TableClass.prototype.read = function(reader: any, ttf: any) {
    const t0 = performance.now();
    const r = orig.call(this, reader, ttf);
    const dt = performance.now() - t0;
    (stats[tn] ??= []).push(dt);
    return r;
  };
}

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }

// 多次跑 readBuffer 累加统计
for (let i = 0; i < 25; i++) {
  const r = new (TTFReader as any)({ subset: cps, kerning: true });
  r.readBuffer(ab);
}

console.log('=== 初夏标点 各表 read 耗时（25次中位数）===');
const rows = Object.entries(stats).map(([n, a]) => ({ n, med: median(a), min: Math.min(...a) }));
rows.sort((a,b)=>b.med-a.med);
for (const r of rows) console.log(`  ${r.n}: ${r.med.toFixed(3)}ms (min ${r.min.toFixed(3)}, ${stats[r.n].length}次)`);
