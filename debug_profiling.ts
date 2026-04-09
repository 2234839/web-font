/**
 * 精确分段计时：找出当前真正的瓶颈
 */
import { readFile } from "node:fs/promises";
import { Font } from "./vendor/fonteditor-core/lib/ttf/font.js";

const FONT_PATH = "font/令东齐伋复刻体.ttf";
const raw = await readFile(FONT_PATH);
const fontBuffer = new Uint8Array(raw).buffer;

const testCases = [
  { label: "8个汉字", subset: [..."天地玄黄宇宙洪荒"].map(c => c.codePointAt(0)!) },
  { label: "千字文前段", subset: [..."天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔"].map(c => c.codePointAt(0)!) },
];

const ROUNDS = 30;

for (const { label, subset } of testCases) {
  let createSum = 0, optimizeSum = 0, sortSum = 0, writeSum = 0;

  for (let i = 0; i < ROUNDS; i++) {
    let t0 = performance.now();
    const font = Font.create(fontBuffer, { type: "ttf", subset });
    let t1 = performance.now();
    createSum += t1 - t0;

    const optimized = font.optimize();
    let t2 = performance.now();
    optimizeSum += t2 - t1;

    const sorted = optimized.sort();
    let t3 = performance.now();
    sortSum += t3 - t2;

    const result = sorted.write({ type: "ttf" });
    let t4 = performance.now();
    writeSum += t4 - t3;
  }

  const total = createSum + optimizeSum + sortSum + writeSum;
  console.log(`${label} (${ROUNDS} rounds):`);
  console.log(`  create:    ${createSum.toFixed(1)}ms (${(createSum / total * 100).toFixed(1)}%)`);
  console.log(`  optimize:  ${optimizeSum.toFixed(1)}ms (${(optimizeSum / total * 100).toFixed(1)}%)`);
  console.log(`  sort:      ${sortSum.toFixed(1)}ms (${(sortSum / total * 100).toFixed(1)}%)`);
  console.log(`  write:     ${writeSum.toFixed(1)}ms (${(writeSum / total * 100).toFixed(1)}%)`);
  console.log(`  total:     ${total.toFixed(1)}ms`);
  console.log();
}
