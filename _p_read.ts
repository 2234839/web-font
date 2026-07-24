import fs from 'node:fs';
import * as TTFReaderNS from './vendor/fonteditor-core/lib/ttf/ttfreader.js';
const TTFReader: any = (TTFReaderNS as any).default.default ?? (TTFReaderNS as any).default ?? TTFReaderNS;

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }
function bench(label: string, mk: () => () => void, iters = 9) {
  const fn = mk();
  for (let i = 0; i < 3; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) { const f = mk(); const t0 = performance.now(); f(); ts.push(performance.now() - t0); }
  console.log(`${label}: ${median(ts).toFixed(3)}ms (min ${Math.min(...ts).toFixed(3)})`);
}

for (const [name, p, text] of [
  ['初夏标点', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '，。！？、；：“”‘’'],
  ['思源8字', './font/思源黑体.ttf', '天地玄黄宇宙洪荒'],
] as const) {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
  const cps = Array.from(text).map(c => c.codePointAt(0)!);
  console.log(`\n=== ${name} ===`);

  bench('  readBuffer', () => () => { const r = new (TTFReader as any)({ subset: cps, kerning: true }); r.readBuffer(ab); });
  bench('  resolveGlyf', () => () => {
    const r = new (TTFReader as any)({ subset: cps, kerning: true });
    const ttf = r.readBuffer(ab);
    r.resolveGlyf(ttf);
  });
  bench('  full read', () => () => { const r = new (TTFReader as any)({ subset: cps, kerning: true }); r.read(ab); });
}
