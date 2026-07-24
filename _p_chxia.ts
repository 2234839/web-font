import fs from 'node:fs';
import { Font } from './vendor/fonteditor-core/lib/ttf/font.js';
import { probeGsubAndCmap, collectReachableGsubTargets } from './backend/font_util/gsub-probe.js';

const fontBuf = fs.readFileSync('/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf');
const ab = fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength) as ArrayBuffer;
const text = '，。！？、；：“”‘’';
const codePoints = Array.from(text);
const option = { sourceType: 'ttf' as const, outType: 'woff2' as const };

function timeOnce<T>(label: string, fn: () => T, runs = 1): T {
  // warmup
  for (let i = 0; i < 3; i++) fn();
  const t0 = performance.now();
  let res: T;
  for (let i = 0; i < runs; i++) res = fn();
  const t1 = performance.now();
  console.log(`${label}: ${((t1 - t0) / runs).toFixed(2)}ms`);
  return res!;
}

// 阶段拆解（best of 5）
function median(arr: number[]) { return arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)]; }

function bench(label: string, fn: () => void, iters = 7) {
  for (let i = 0; i < 3; i++) fn(); // warmup
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  console.log(`${label}: ${median(ts).toFixed(3)}ms (min ${Math.min(...ts).toFixed(3)})`);
}

// 1. probe
bench('1.probe', () => probeGsubAndCmap(ab, codePoints, option.sourceType));

// 2. Font.create
bench('2.Font.create', () => Font.create(ab, { type: option.sourceType, subset: codePoints as any, kerning: true }));

// 完整 Font.create 拿到对象
const font = Font.create(ab, { type: option.sourceType, subset: codePoints as any, kerning: true });

// 3. optimize
bench('3.optimize', () => (font as any).optimize());

// 4. write (woff2)
const optimized = (font as any).optimize();
bench('5.write(woff2)', () => {
  const f = Font.create(ab, { type: option.sourceType, subset: codePoints as any, kerning: true });
  const o = (f as any).optimize();
  o.write({ type: 'woff2', hinting: false } as any);
});

// 端到端对比
bench('E2E', () => {
  const f = Font.create(ab, { type: option.sourceType, subset: codePoints as any, kerning: true });
  const o = (f as any).optimize();
  o.write({ type: 'woff2', hinting: false } as any);
}, 5);
