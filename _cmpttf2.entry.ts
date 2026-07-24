import { readFileSync, writeFileSync } from 'fs';
import { fontSubset } from './backend/font_util/font.js';
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const text = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔';
const out = fontSubset(ab, text, {sourceType:'ttf',outType:'ttf'});
writeFileSync('/tmp/ttf_clean.bin', out);
console.log('len', out.length);
