import { fontSubset } from './backend/font_util/font.js';
import { readFileSync } from 'fs';
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const text = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔';
const g:any = globalThis;
const N=300;
fontSubset(ab, text, {sourceType:'ttf',outType:'woff2'}); // warmup
g.__wt.flagDecode=0; g.__wt.xDecode=0; g.__wt.yTriplet=0;
import('perf_hooks').then(({performance})=>{
  const t0=performance.now();
  for(let i=0;i<N;i++) fontSubset(ab, text, {sourceType:'ttf',outType:'woff2'});
  const total=performance.now()-t0;
  console.log(`woff2 total avg=${(total/N).toFixed(3)}ms`);
  const f=g.__wt.flagDecode/N, x=g.__wt.xDecode/N, y=g.__wt.yTriplet/N;
  const tInside=(f+x+y);
  console.log(`  flagDecode: ${f.toFixed(3)}ms (${(f/total*100).toFixed(1)}%)`);
  console.log(`  xDecode:    ${x.toFixed(3)}ms (${(x/total*100).toFixed(1)}%)`);
  console.log(`  y+triplet:  ${y.toFixed(3)}ms (${(y/total*100).toFixed(1)}%)`);
  console.log(`  循环内合计: ${tInside.toFixed(3)}ms (${(tInside/total*100).toFixed(1)}%)`);
});
