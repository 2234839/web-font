/**
 * 字体裁剪基准测试
 * 运行: pnpm tsx 基准测试.test.ts
 *
 * 测量:
 *   1. 子集化总耗时（Font.create → optimize → sort → write）
 *   2. 渲染相似度（子集字体 vs 完整字体，SSIM 指标）
 *   3. 输出渲染对比图片到 benchmark_results/ 目录
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Font } from "./vendor/fonteditor-core/lib/ttf/font.js";
import woff2Module from "./vendor/fonteditor-core/woff2/index.js";
import { Canvas, FontLibrary } from "skia-canvas";

const FONT_PATH = "font/令东齐伋复刻体.ttf";
const FONT_NAME = "令东齐伋复刻体";
const BENCHMARK_DIR = "benchmark_results";

const raw = await readFile(FONT_PATH);
const fontBuffer = new Uint8Array(raw).buffer;
FontLibrary.use(FONT_NAME, FONT_PATH);

/** 初始化 woff2 wasm 并测量耗时 */
const wasmInitStart = performance.now();
await woff2Module.init();
const wasmInitTime = performance.now() - wasmInitStart;
console.log(`  woff2 wasm 初始化: ${wasmInitTime.toFixed(1)}ms`);

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

/** 渲染文字并保存为 PNG */
async function renderTextToPng(fontFamily: string, text: string, fontSize: number, filePath: string) {
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
  const buffer = await canvas.toBuffer("png");
  return writeFile(filePath, buffer);
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
  await mkdir(BENCHMARK_DIR, { recursive: true });
  const fontPath = `${BENCHMARK_DIR}/_bench_${counter}.ttf`;
  await writeFile(fontPath, Buffer.from(ttfBuffer));
  const familyName = `BenchSubset_${counter}`;
  FontLibrary.use(familyName, [fontPath]);
  return familyName;
}

await mkdir(BENCHMARK_DIR, { recursive: true });

console.log("\n=== 字体裁剪基准测试 ===\n");

const results: Array<{
  label: string;
  avg: number;
  min: number;
  max: number;
  outputSize: number;
  ssim: number;
}> = [];

for (const { label, text } of testCases) {
  const subset = [...text].map((c) => c.codePointAt(0)!);

  /** --- ttf 测试 --- */
  const ttfTimes: number[] = [];
  let lastTtfSize = 0;
  let lastTtfBuffer: ArrayBuffer | null = null;

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    const font = Font.create(fontBuffer, { type: "ttf", subset });
    const optimized = font.optimize().sort();
    const result = optimized.write({ type: "ttf" });
    const t1 = performance.now();
    ttfTimes.push(t1 - t0);
    lastTtfSize = typeof result === "string" ? result.length : result.byteLength;
    if (i === 0) {
      lastTtfBuffer = result instanceof ArrayBuffer ? result : new Uint8Array(result as any).buffer;
    }
  }

  const ttfAvg = ttfTimes.reduce((a, b) => a + b, 0) / ttfTimes.length;
  const ttfMin = Math.min(...ttfTimes);
  const ttfMax = Math.max(...ttfTimes);

  /** --- woff2 测试 --- */
  const woff2Times: number[] = [];
  let lastWoff2Size = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    const font = Font.create(fontBuffer, { type: "ttf", subset });
    const optimized = font.optimize().sort();
    const result = optimized.write({ type: "woff2" });
    const t1 = performance.now();
    woff2Times.push(t1 - t0);
    lastWoff2Size = typeof result === "string" ? result.length : result.byteLength;
  }

  const woff2Avg = woff2Times.reduce((a, b) => a + b, 0) / woff2Times.length;
  const woff2Min = Math.min(...woff2Times);
  const woff2Max = Math.max(...woff2Times);
  const compressionRatio = ((1 - lastWoff2Size / lastTtfSize) * 100).toFixed(1);

  /** 计算渲染相似度（使用 ttf） */
  let ssim = 0;
  if (lastTtfBuffer) {
    subsetFontCounter++;
    const familyName = await registerSubsetFont(lastTtfBuffer, subsetFontCounter);

    const safeLabel = label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
    await renderTextToPng(FONT_NAME, text, 48, `${BENCHMARK_DIR}/${safeLabel}_full.png`);
    await renderTextToPng(familyName, text, 48, `${BENCHMARK_DIR}/${safeLabel}_subset.png`);

    const fullPixels = renderText(FONT_NAME, text, 48);
    const subsetPixels = renderText(familyName, text, 48);
    ssim = calculateSSIM(fullPixels, subsetPixels);
  }

  results.push({ label, avg: ttfAvg, min: ttfMin, max: ttfMax, outputSize: lastTtfSize, ssim });
  console.log(`  [ttf]   ${label}: avg=${ttfAvg.toFixed(1)}ms  min=${ttfMin.toFixed(1)}ms  max=${ttfMax.toFixed(1)}ms  输出=${lastTtfSize.toLocaleString()} bytes  ssim=${ssim.toFixed(4)}`);
  console.log(`  [woff2] ${label}: avg=${woff2Avg.toFixed(1)}ms  min=${woff2Min.toFixed(1)}ms  max=${woff2Max.toFixed(1)}ms  输出=${lastWoff2Size.toLocaleString()} bytes  压缩率=${compressionRatio}%`);
}

/** --- OTF 测试（直接 OTF 子集化，SSIM 对比原始 OTF 渲染 vs 子集 TTF 渲染） --- */
const OTF_FONT_PATH = "font/temp/SourceHanSans-Regular.otf";
let otfTestResults: string[] = [];
try {
  const otfRaw = await readFile(OTF_FONT_PATH);
  const otfBuffer = new Uint8Array(otfRaw).buffer;

  /** 注册原始 OTF 字体作为渲染基准 */
  const OTF_FONT_NAME = `OTF_Bench_${Date.now()}`;
  FontLibrary.use(OTF_FONT_NAME, OTF_FONT_PATH);

  const otfTestCases = [
    { label: "otf-8个汉字", text: "天地玄黄宇宙洪荒" },
    { label: "otf-拉丁+数字", text: "Hello World 123" },
  ];

  for (const { label, text } of otfTestCases) {
    const subset = [...text].map((c) => c.codePointAt(0)!);
    const otfTimes: number[] = [];
    let lastOtfTtfSize = 0;
    let lastOtfTtfBuffer: ArrayBuffer | null = null;

    for (let i = 0; i < ROUNDS; i++) {
      const t0 = performance.now();
      const font = Font.create(otfBuffer, { type: "otf", subset });
      const optimized = font.optimize().sort();
      const result = optimized.write({ type: "ttf" });
      const t1 = performance.now();
      otfTimes.push(t1 - t0);
      lastOtfTtfSize = typeof result === "string" ? result.length : result.byteLength;
      if (i === 0) {
        lastOtfTtfBuffer = result instanceof ArrayBuffer ? result : new Uint8Array(result as any).buffer;
      }
    }

    const otfAvg = otfTimes.reduce((a, b) => a + b, 0) / otfTimes.length;
    const otfMin = Math.min(...otfTimes);
    const otfMax = Math.max(...otfTimes);

    /** OTF SSIM：对比原始 OTF 渲染 vs 子集 TTF 渲染 */
    let otfSsim = 0;
    if (lastOtfTtfBuffer) {
      subsetFontCounter++;
      const familyName = await registerSubsetFont(lastOtfTtfBuffer, subsetFontCounter);

      const safeLabel = label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
      await renderTextToPng(OTF_FONT_NAME, text, 48, `${BENCHMARK_DIR}/${safeLabel}_otf_full.png`);
      await renderTextToPng(familyName, text, 48, `${BENCHMARK_DIR}/${safeLabel}_otf_subset.png`);

      const fullPixels = renderText(OTF_FONT_NAME, text, 48);
      const subsetPixels = renderText(familyName, text, 48);
      otfSsim = calculateSSIM(fullPixels, subsetPixels);
    }

    otfTestResults.push(`  [otf] ${label}: avg=${otfAvg.toFixed(1)}ms  min=${otfMin.toFixed(1)}ms  max=${otfMax.toFixed(1)}ms  输出=${lastOtfTtfSize.toLocaleString()} bytes  ssim=${otfSsim.toFixed(4)}`);
  }
} catch {
  otfTestResults.push("  [otf] 跳过（未找到 OTF 测试字体 font/temp/SourceHanSans-Regular.otf）");
}

/** 保存结果到 JSON */
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultFile = `${BENCHMARK_DIR}/benchmark_${timestamp}.json`;
await writeFile(resultFile, JSON.stringify({ timestamp: new Date().toISOString(), rounds: ROUNDS, results }, null, 2));
console.log(`\n结果已保存到 ${resultFile}`);
console.log(`渲染对比图片已保存到 ${BENCHMARK_DIR}/ 目录`);

if (otfTestResults.length) {
  console.log("\n--- OTF→TTF 子集化 ---");
  for (const line of otfTestResults) console.log(line);
}
console.log("");
