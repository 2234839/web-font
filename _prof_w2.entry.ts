import { fontSubset } from './backend/font_util/font.js';
import { readFileSync } from 'fs';
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const text = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔';
const g:any = globalThis;
const N=200;
fontSubset(ab, text, {sourceType:'ttf',outType:'woff2'}); // warmup
g.__t.transform=0; g.__t.brotli=0;
import('perf_hooks').then(({performance})=>{
  const t0=performance.now();
  for(let i=0;i<N;i++) fontSubset(ab, text, {sourceType:'ttf',outType:'woff2'});
  const total=performance.now()-t0;
  console.log(`woff2 total avg=${(total/N).toFixed(3)}ms`);
  console.log(`  transformGlyfAndLoca: ${(g.__t.transform/N).toFixed(3)}ms (${(g.__t.transform/total*100).toFixed(1)}%)`);
  console.log(`  brotli:               ${(g.__t.brotli/N).toFixed(3)}ms (${(g.__t.brotli/total*100).toFixed(1)}%)`);
  console.log(`  其余(Font.create+ttf write+组装): ${((total-g.__t.transform-g.__t.brotli)/N).toFixed(3)}ms (${((total-g.__t.transform-g.__t.brotli)/total*100).toFixed(1)}%)`);
});
