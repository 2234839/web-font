import fs from 'node:fs';
import { Font } from './vendor/fonteditor-core/lib/ttf/font.js';
import { probeGsubAndCmap } from './backend/font_util/gsub-probe.js';
import { collectReachableGsubTargets } from './backend/font_util/gsub-reachable.js';
import { subsetGPOS } from './backend/font_util/gpos-subset.js';
import { subsetGSUB } from './backend/font_util/gsub-subset.js';

function rewriteLayoutTablesForSubset(opt: any, subsetGids: number[]) {
  const ttf = opt.get();
  const origToNew = new Map<number, number>();
  for (let i = 0; i < subsetGids.length; i++) origToNew.set(subsetGids[i], i);
  const og = ttf.GPOS;
  if (og) { const b = og instanceof Uint8Array ? og : new Uint8Array(og); if (b.byteLength > 0) { const r = subsetGPOS(b, origToNew); if (r) ttf.GPOS = r; } }
  const os = ttf.GSUB;
  if (os) { const b = os instanceof Uint8Array ? os : new Uint8Array(os); if (b.byteLength > 0) { ttf.GSUB = subsetGSUB(b, origToNew); } }
}

function median(a: number[]) { return a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]; }

const p = '/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf';
const text = '，。！？、；：“”‘’';
const buf = fs.readFileSync(p);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength) as ArrayBuffer;
const codePoints = Array.from(text).map(c => c.codePointAt(0)!);

// 准备共享对象
function build() {
  const probe = probeGsubAndCmap(ab, codePoints, 'ttf');
  let extraSubsetGids: number[] | undefined;
  if (probe.ok) {
    const seed = new Set<number>([0]);
    for (const cp of codePoints) { const g = probe.lookup.get(cp); if (g !== undefined) seed.add(g); }
    const r = collectReachableGsubTargets(probe.gsubBytes!, seed);
    if (r.size > 0) extraSubsetGids = [...r];
  }
  return { extraSubsetGids };
}

const { extraSubsetGids } = build();

function timePhase(label: string, fn: () => void, iters = 13) {
  for (let i = 0; i < 4; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); }
  console.log(`  ${label}: ${median(ts).toFixed(3)}ms`);
}

console.log('=== 初夏纯标点 各阶段（独立 best-of）===');
timePhase('1.probe', () => probeGsubAndCmap(ab, codePoints, 'ttf'));

let fontRef: any;
timePhase('2.Font.create', () => { fontRef = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true, extraSubsetGids }); });

const font = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true, extraSubsetGids });
const preOpt = font.get();
const subsetGids: number[] = preOpt.subsetGids ?? [];
console.log(`  subsetGids count: ${subsetGids.length}`);

timePhase('3.optimize', () => { const f = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true, extraSubsetGids }); f.optimize(); });

const opt = font.optimize();
// rewrite 内部拆解
timePhase('4a.subsetGPOS', () => {
  const f = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true, extraSubsetGids });
  const o = f.optimize();
  // 复刻 rewriteLayoutTablesForSubset 的 GPOS 部分
  const ttf = o.get();
  const origToNew = new Map<number, number>();
  for (let i = 0; i < subsetGids.length; i++) origToNew.set(subsetGids[i], i);
  const g = ttf.GPOS;
  if (g) { subsetGPOS(g instanceof Uint8Array ? g : new Uint8Array(g), origToNew); }
});

timePhase('4.rewriteLayoutTables', () => {
  const f = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true, extraSubsetGids });
  const o = f.optimize();
  rewriteLayoutTablesForSubset(o, subsetGids);
});

timePhase('5.write(woff2)', () => {
  const f = Font.create(ab, { type: 'ttf', subset: codePoints as any, kerning: true, extraSubsetGids });
  const o = f.optimize();
  rewriteLayoutTablesForSubset(o, subsetGids);
  o.write({ type: 'woff2', hinting: false } as any);
});
