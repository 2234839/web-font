import { performance } from 'perf_hooks';
import { readFileSync } from 'fs';
import * as zlib from 'zlib';

const woff2enc = require('./vendor/fonteditor-core/woff2/woff2-encode.js');
const mod = woff2enc.__esModule ? woff2enc.default || woff2enc : woff2enc;

const tTransform = {total:0};
const tBrotli = {total:0};

// patch transformGlyfAndLoca
const origTransform = mod.transformGlyfAndLoca;
mod.transformGlyfAndLoca = function(...args:any[]) {
  const t=performance.now();
  const r = origTransform.apply(this,args);
  tTransform.total += performance.now()-t;
  return r;
};
// patch brotliCompressSync at module level not possible (local const), instead time encodeTTFToWOFF2 minus transform
const { fontSubset } = require('./backend/font_util/font.js');
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const text = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔';

const N=200;
// warmup
fontSubset(ab, text, {sourceType:'ttf',outType:'woff2'});
const t0=performance.now();
for(let i=0;i<N;i++) fontSubset(ab, text, {sourceType:'ttf',outType:'woff2'});
const total=performance.now()-t0;
console.log(`woff2 total avg=${(total/N).toFixed(3)}ms`);
console.log(`  transformGlyfAndLoca: ${(tTransform.total/N).toFixed(3)}ms (${(tTransform.total/total*100).toFixed(1)}%)`);
console.log(`  其余(brotli+组装): ${((total-tTransform.total)/N).toFixed(3)}ms (${((total-tTransform.total)/total*100).toFixed(1)}%)`);
