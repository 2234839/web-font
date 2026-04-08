/**
 * 字体裁剪基准测试
 * 运行: pnpm tsx 基准测试.test.ts
 *
 * 测量:
 *   1. 子集化总耗时（Font.create → optimize → sort → write）
 *   2. 渲染相似度（子集字体 vs 完整字体，SSIM 指标）
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Font } from "fonteditor-core";
import { Canvas, FontLibrary } from "skia-canvas";

const FONT_PATH = "font/令东齐伋复刻体.ttf";
const FONT_NAME = "令东齐伋复刻体";

const raw = await readFile(FONT_PATH);
const fontBuffer = new Uint8Array(raw).buffer;
FontLibrary.use(FONT_NAME, FONT_PATH);

const testCases = [
  { label: "8个汉字", text: "天地玄黄宇宙洪荒" },
  { label: "拉丁+数字", text: "Hello World 123" },
  {
    label: "千字文前段",
    text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔",
  },
];

const ROUNDS = 10;

/** 子集字体临时文件计数器 */
let subsetFontCounter = 0;

/** 渲染文字到像素数据 */
function renderText(fontFamily: string, text: string, fontSize: number): Uint8Array {
  const charWidth = Math.ceil(fontSize * 1.5);
  const width = text.length * charWidth + 20;
  const height = Math.ceil(fontSize * 1.5);
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle = "black";
  ctx.fillText(text, 10, Math.ceil(fontSize * 1.2));
  const imgData = ctx.getImageData(0, 0, width, height);
  return new Uint8Array(imgData.data.buffer);
}

/** 计算两张图片的结构相似度（简化版 SSIM），返回 0~1 */
function calculateSSIM(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;

  const toGray = (data: Uint8Array, offset: number) =>
    0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];

  const pixelCount = a.length / 4;
  let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const ga = toGray(a, idx);
    const gb = toGray(b, idx);
    sumA += ga;
    sumB += gb;
    sumA2 += ga * ga;
    sumB2 += gb * gb;
    sumAB += ga * gb;
  }

  const meanA = sumA / pixelCount;
  const meanB = sumB / pixelCount;
  const varA = sumA2 / pixelCount - meanA * meanA;
  const varB = sumB2 / pixelCount - meanB * meanB;
  const covAB = sumAB / pixelCount - meanA * meanB;

  const C1 = 6.5025;
  const C2 = 58.5225;

  return (2 * meanA * meanB + C1) * (2 * covAB + C2) /
    ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
}

/** 注册子集字体用于渲染 */
async function registerSubsetFont(ttfBuffer: ArrayBuffer, counter: number): Promise<string> {
  await mkdir("verify_font_baseline", { recursive: true });
  const fontPath = `verify_font_baseline/_bench_${counter}.ttf`;
  await writeFile(fontPath, Buffer.from(ttfBuffer));
  const familyName = `BenchSubset_${counter}`;
  FontLibrary.use(familyName, [fontPath]);
  return familyName;
}

console.log("\n=== 字体裁剪基准测试 ===\n");

for (const { label, text } of testCases) {
  const subset = [...text].map((c) => c.codePointAt(0)!);
  const times: number[] = [];
  let lastOutputSize = 0;
  let lastTtfBuffer: ArrayBuffer | null = null;

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    const font = Font.create(fontBuffer, { type: "ttf", subset });
    const optimized = font.optimize().sort();
    const result = optimized.write({ type: "ttf" });
    const t1 = performance.now();
    times.push(t1 - t0);
    lastOutputSize = typeof result === "string" ? result.length : result.byteLength;
    if (i === 0) {
      lastTtfBuffer = result instanceof ArrayBuffer ? result : new Uint8Array(result as any).buffer;
    }
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  /** 计算渲染相似度 */
  let ssim = 0;
  if (lastTtfBuffer) {
    subsetFontCounter++;
    const familyName = await registerSubsetFont(lastTtfBuffer, subsetFontCounter);
    const fullPixels = renderText(FONT_NAME, text, 48);
    const subsetPixels = renderText(familyName, text, 48);
    ssim = calculateSSIM(fullPixels, subsetPixels);
  }

  console.log(`  ${label}: avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms  输出=${lastOutputSize.toLocaleString()} bytes  ssim=${ssim.toFixed(4)}`);
}

console.log("");
