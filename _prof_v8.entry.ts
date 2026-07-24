import { fontSubset } from './backend/font_util/font.js';
import { readFileSync, writeFileSync } from 'fs';
import { Session } from 'inspector';
const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const text = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔';
const opt = {sourceType:'ttf' as const, outType:'woff2' as const};
(async()=>{
  for(let i=0;i<50;i++) fontSubset(ab, text, opt);
  const s = new Session();
  s.connect();
  await new Promise<void>(r=>s.post('Profiler.enable',()=>r()));
  await new Promise<void>(r=>s.post('Profiler.start',()=>r()));
  for(let i=0;i<2000;i++) fontSubset(ab, text, opt);
  const prof:any = await new Promise(r=>s.post('Profiler.stop',(_,v)=>r(v)));
  writeFileSync('/tmp/prof.json', JSON.stringify(prof));
  console.log('profile written, samples=', prof.profile.samples.length);
})();
