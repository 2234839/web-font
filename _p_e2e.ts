import fs from 'node:fs';
import { fontSubset } from './backend/font_util/font.js';

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }
function bench(label: string, fn: () => void, iters = 15) {
  for (let i = 0; i < 5; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); }
  console.log(`${label}: ${median(ts).toFixed(3)}ms (min ${Math.min(...ts).toFixed(3)})`);
}

for (const [name, p, text] of [
  ['初夏纯标点', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '，。！？、；：“”‘’'],
  ['初夏汉字标点', '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf', '你好，世界！今天天气不错。'],
  ['思源8字', './font/思源黑体.ttf', '天地玄黄宇宙洪荒'],
  ['令东千字', './font/令东齐伋复刻体.ttf', '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈'],
] as const) {
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
  console.log(`\n=== ${name} ===`);
  let outLen = 0;
  bench('  fontSubset(woff2)', () => { const o = fontSubset(ab, text, { sourceType: 'ttf' as const, outType: 'woff2' as const }); outLen = o.length; });
  console.log(`  woff2 out: ${outLen}B`);
}
