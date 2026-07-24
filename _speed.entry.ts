import { performance } from 'perf_hooks';
import { readFileSync } from 'fs';
import { fontSubset } from './backend/font_util/font.js';
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const cases: [string,string,any][] = [
  ['千字文woff2','天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔',{sourceType:'ttf',outType:'woff2'}],
  ['千字文ttf','天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔',{sourceType:'ttf',outType:'ttf'}],
];
for (const [label,text,opt] of cases) {
  fontSubset(ab, text, opt);
  const N = 300;
  const t0 = performance.now();
  for (let i=0;i<N;i++) fontSubset(ab, text, opt);
  console.log(`${label.padEnd(14)} avg=${((performance.now()-t0)/N).toFixed(3)}ms`);
}
