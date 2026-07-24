import fs from 'node:fs';
import { Font } from './vendor/fonteditor-core/lib/ttf/font.js';

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }
function bench(label: string, fn: () => void, iters = 9) {
  for (let i = 0; i < 3; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); }
  console.log(`${label}: ${median(ts).toFixed(3)}ms (min ${Math.min(...ts).toFixed(3)})`);
}

for (const [name, p, text] of [
  ['初夏标点', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '，。！？、；：“”‘’'],
  ['思源8字', './font/思源黑体.ttf', '天地玄黄宇宙洪荒'],
  ['令东千字', './font/令东齐伋复刻体.ttf', '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈'],
] as const) {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
  const cps = Array.from(text);
  console.log(`\n=== ${name} (${text.length}字) ===`);

  bench('  create', () => Font.create(ab, { type: 'ttf', subset: cps as any, kerning: true }));
  const font = Font.create(ab, { type: 'ttf', subset: cps as any, kerning: true });
  const opt = (font as any).optimize();
  bench('  write-woff2', () => opt.write({ type: 'woff2', hinting: false } as any));
  // write-ttf 对比
  bench('  write-ttf', () => opt.write({ type: 'ttf', hinting: false } as any));
}
