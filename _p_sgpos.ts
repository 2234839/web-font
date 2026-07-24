import fs from 'node:fs';
import { Font } from './vendor/fonteditor-core/lib/ttf/font.js';
import { subsetGPOS } from './backend/font_util/gpos-subset.js';
import { subsetGSUB } from './backend/font_util/gsub-subset.js';

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }

const p = '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf';
const text = '，。！？、；：“”‘’';
const buf = fs.readFileSync(p);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const codePoints = Array.from(text).map(c => c.codePointAt(0)!);

// 一次性拿到 subsetGids + GPOS 字节 + origToNew
const font = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true });
const preOpt = font.get();
const subsetGids: number[] = preOpt.subsetGids ?? [];
const origToNew = new Map<number, number>();
for (let i = 0; i < subsetGids.length; i++) origToNew.set(subsetGids[i], i);
const gposBytes = preOpt.GPOS instanceof Uint8Array ? preOpt.GPOS : new Uint8Array(preOpt.GPOS);
const gsubBytes = preOpt.GSUB instanceof Uint8Array ? preOpt.GSUB : new Uint8Array(preOpt.GSUB);
console.log('subsetGids:', subsetGids.length, 'GPOS:', gposBytes.length, 'GSUB:', gsubBytes.length);

function bench(label: string, fn: () => void, iters = 25) {
  for (let i = 0; i < 8; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); }
  console.log(`  ${label}: ${median(ts).toFixed(3)}ms (min ${Math.min(...ts).toFixed(3)})`);
}

bench('subsetGPOS', () => subsetGPOS(gposBytes, origToNew));
bench('subsetGSUB', () => subsetGSUB(gsubBytes, origToNew));
