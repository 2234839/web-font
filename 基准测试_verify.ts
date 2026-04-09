/**
 * Node 端渲染验证 — 加载 llrt 生成的子集字体，渲染并与完整字体对比 SSIM
 * 运行: pnpm tsx 基准测试_verify.ts
 *
 * 前置: 先运行 llrt 基准测试生成子集字体文件
 */
import { readFile } from "node:fs/promises";
import { Canvas, FontLibrary } from "skia-canvas";
import type { FontFace } from "skia-canvas";

const BENCHMARK_DIR = "benchmark_results";

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
  const { writeFile } = await import("node:fs/promises");
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

async function main() {
  const metaRaw = await readFile(`${BENCHMARK_DIR}/llrt_bench_meta.json`, "utf-8");
  const meta = JSON.parse(metaRaw);

  console.log("\n=== LLRT 子集字体渲染验证（Node 渲染） ===\n");
  console.log(`[来源] ${meta.runtime} 运行时裁剪`);
  console.log(`[字体] ${meta.fontName}`);
  console.log(`[轮次] ${meta.rounds}\n`);

  /** 注册完整字体 */
  FontLibrary.use(meta.fontName, meta.fontPath);

  let allPassed = true;

  for (const item of meta.results) {
    const familyName = `LLRT_${item.label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")}`;
    FontLibrary.use(familyName, item.fontFile);

    const fullPixels = renderText(meta.fontName, item.text, 48);
    const subsetPixels = renderText(familyName, item.text, 48);
    const ssim = calculateSSIM(fullPixels, subsetPixels);

    /** 保存渲染对比图 */
    const safeLabel = item.label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
    await renderTextToPng(meta.fontName, item.text, 48, `${BENCHMARK_DIR}/llrt_verify_${safeLabel}_full.png`);
    await renderTextToPng(familyName, item.text, 48, `${BENCHMARK_DIR}/llrt_verify_${safeLabel}_subset.png`);

    const passed = ssim >= 0.999;
    if (!passed) allPassed = false;
    console.log(`  ${item.label}: ssim=${ssim.toFixed(4)} ${passed ? "PASS" : "FAIL"}  (${item.outputSize.toLocaleString()} bytes)`);
  }

  console.log(`\n${allPassed ? "全部通过！" : "存在渲染差异，请检查对比图片！"}`);
}

main();
