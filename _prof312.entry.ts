import { performance } from 'perf_hooks';
import { readFileSync } from 'fs';
import { fontSubset } from './backend/font_util/font.js';
import supportMod from './vendor/fonteditor-core/lib/ttf/table/support.js';
const support = (supportMod as any).default || supportMod;

const buf = readFileSync('font/令东齐伋复刻体.ttf');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const times: Record<string, number> = {};
function wrap(proto: any, name: string, label: string) {
  const orig = proto[name];
  if (typeof orig !== 'function') return;
  proto[name] = function(...args: any[]) {
    const t = performance.now();
    const r = orig.apply(this, args);
    times[label] = (times[label]||0) + (performance.now()-t);
    return r;
  };
}

for (const tname of Object.keys(support)) {
  const T = support[tname];
  if (!T || !T.prototype) continue;
  wrap(T.prototype, 'read', 'read:'+tname);
  wrap(T.prototype, 'write', 'write:'+tname);
  wrap(T.prototype, 'size', 'size:'+tname);
}

const text = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔';
for (const outType of ['ttf','woff2'] as const) {
  for (const k of Object.keys(times)) delete times[k];
  const opt = {sourceType:'ttf' as const, outType};
  fontSubset(ab, text, opt);
  const N = 200;
  const t0 = performance.now();
  for (let i=0;i<N;i++) fontSubset(ab, text, opt);
  const total = performance.now()-t0;
  console.log(`\n=== ${outType} total avg=${(total/N).toFixed(3)}ms ===`);
  const sorted = Object.entries(times).sort((a,b)=>b[1]-a[1]);
  for (const [k,v] of sorted.slice(0,12)) {
    console.log(`  ${k.padEnd(18)} ${(v*1000/N|0)/1000}µs  ${(v/total*100).toFixed(1)}%`);
  }
}
