import { readFileSync } from 'fs';
import { fontSubset } from './backend/font_util/font.js';
import supportMod from './vendor/fonteditor-core/lib/ttf/table/support.js';
const support = (supportMod as any).default || supportMod;
const hmtxT = support.hmtx;
const origRead = hmtxT.prototype.read;
hmtxT.prototype.read = function(reader: any, ttf: any) {
  const r = origRead.call(this, reader, ttf);
  if (ttf.subsetGids) {
    let mx = 0;
    for (const g of ttf.subsetGids) if (g>mx) mx=g;
    console.log(`numGlyphs=${ttf.maxp.numGlyphs} subsetGids.len=${ttf.subsetGids.length} maxGid=${mx} alloc=${ttf.maxp.numGlyphs*2*4}B needed=${(mx+1)*2*4}B`);
  }
  return r;
};
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
fontSubset(ab, '天地玄黄宇宙洪荒', {sourceType:'ttf',outType:'ttf'});
