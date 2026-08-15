/**
 * 字体裁剪基准测试（leafer Node 版）
 * 运行: pnpx tsx 基准测试_leafer.test.ts
 *
 * 与 基准测试.test.ts（puppeteer 浏览器版）共用 基准测试用例.ts 的用例表，
 * 渲染层换为 @leafer-ui/node（@napi-rs/canvas Skia 后端），无需浏览器与 HTTP 服务器：
 *   1. 直接调用 backend/font_util/font.ts 的 fontSubset（与 API 完全一致）
 *   2. full 基准：原始字体文件 GlobalFonts.register 后用 leafer Text 渲染（基准参照原则与浏览器版一致）
 *   3. subset：fontSubset 产物注册到唯一 family 后同参数渲染
 *   4. leafer.export('png') 导出位图，pngjs 解码后算 SSIM（scripts/ssim.ts）
 *
 * 与浏览器版的分工（为什么双方案并存）：
 *   - Skia（GlobalFonts）只吃裸 sfnt（ttf/otf），不吃 woff2 容器——woff2 用例在本版
 *     只测裁剪耗时/产物体积（woff2 是无损容器，编码正确性由 puppeteer 版 SSIM 守护），
 *     SSIM 渲染验证只做 outType=ttf 的用例（含 otf→ttf：CFF 轮廓裸 otf 字节直接注册）。
 *   - 本版价值：快（无浏览器启动/字体 HTTP 加载）、可在纯 Node CI 环境跑，
 *     且天然与 leafer-x-webfont 插件的 Node 渲染路径同栈。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Leafer, Text, useCanvas } from "@leafer-ui/node";
import { Canvas as NapiCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { fontSubset } from "./backend/font_util/font.js";
import { testCases } from "./基准测试用例.js";
import { calculateSSIM } from "./scripts/ssim.js";
import { PNG } from "pngjs";

/** 必须在创建任何 Leafer 实例之前注入 napi canvas 平台 */
useCanvas("napi", { Canvas: NapiCanvas, loadImage });

const BENCHMARK_DIR = "benchmark_results";
const SCREENSHOT_DIR = `${BENCHMARK_DIR}/screenshots_leafer`;
const ROUNDS = 10;

/** family 注册序号（每字体一个唯一 family，规避 Skia 同名二次注册不可靠问题） */
let familySeq = 0;

/**
 * 用 leafer Text 渲染一行文字并导出 PNG 像素
 * 画布尺寸算法与浏览器版 renderTextViaBrowser 一致（charWidth = fontSize*1.5）
 * 文本起点 x=10 y=fontSize*1.2*0.1+…：浏览器版 #text 有 padding(top=fontSize*0.1, left=10)
 * line-height 1.2 由 leafer 的 lineHeight 默认值近似（视觉基准只要求 full/subset 同参数）
 */
async function renderTextViaLeafer(
  family: string,
  text: string,
  fontSize: number,
): Promise<{ pixels: Uint8Array; png: Buffer; inkPixels: number; width: number; height: number }> {
  const charWidth = Math.ceil(fontSize * 1.5);
  const width = text.length * charWidth + 20;
  const height = Math.ceil(fontSize * 1.5);

  const leafer = new Leafer({ width, height, fill: "#ffffff" });
  leafer.add(
    new Text({
      text,
      fontFamily: family,
      fontSize,
      fill: "#000000",
      x: 10,
      y: Math.ceil(fontSize * 0.1),
    }),
  );
  /** 等一帧布局+渲染落盘（leafer 异步渲染） */
  await new Promise((r) => setTimeout(r, 60));
  const out = (await leafer.export("png", { pixelRatio: 1 })) as { data: string };
  leafer.destroy();

  const png = Buffer.from(out.data.split(",")[1]!, "base64");
  const decoded = PNG.sync.read(png);
  const pixels = new Uint8Array(decoded.data);

  let inkPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! < 128) inkPixels++;
  }
  if (inkPixels === 0) {
    throw new Error(`字体渲染无墨水像素 (${family})，字体可能未正确加载`);
  }
  /** 用导出图真实尺寸（leafer 可能按 hiDPI/裁剪调整画布，传预设尺寸会触发 SSIM 尺寸守卫返回 0） */
  return { pixels, png, inkPixels, width: decoded.width, height: decoded.height };
}

/** 注册字体 buffer 到唯一 family，返回 family 名 */
function registerFamily(buf: Uint8Array): string {
  const family = `BenchFont_${familySeq++}`;
  /** 注册失败返回 null（woff2 等非法输入），成功返回 FontKey 对象 */
  if (!GlobalFonts.register(buf, family)) {
    throw new Error(`GlobalFonts.register 失败 (family=${family})`);
  }
  /** Skia 注册成功 ≠ 按 alias 可查（同 family 二次注册会被忽略），双保险校验 */
  if (!GlobalFonts.has(family)) {
    throw new Error(`GlobalFonts.has(${family}) = false，字体未按别名生效`);
  }
  return family;
}

// ======== 主测试 ========
await mkdir(`${BENCHMARK_DIR}/json`, { recursive: true });
await mkdir(SCREENSHOT_DIR, { recursive: true });

console.log("\n=== 字体裁剪基准测试（leafer Node 版）===\n");

const results: Array<{
  label: string;
  sourceType: string;
  outType: string;
  avg: number;
  min: number;
  max: number;
  outputSize: number;
  /** woff2 用例为 null（本版不做 woff2 渲染验证，见文件头说明） */
  ssim: number | null;
  fullInk: number | null;
  subsetInk: number | null;
}> = [];

for (const tc of testCases) {
  /** 字体文件缺失（如 font/temp/ 已清理、/mnt/d 未挂载）的用例跳过并标注，不视为失败 */
  if (!existsSync(tc.fontPath)) {
    console.log(`  [跳过] ${tc.label}: 字体文件不存在 ${tc.fontPath}`);
    continue;
  }
  const raw = await readFile(tc.fontPath);
  const buf = new Uint8Array(raw).buffer.slice(0) as ArrayBuffer;

  /** --- 子集化计时（与浏览器版相同流程） --- */
  const times: number[] = [];
  let lastSize = 0;
  let lastBuffer: Uint8Array | null = null;

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    const subsetBuf = await fontSubset(buf, tc.text, { sourceType: tc.sourceType, outType: tc.outType });
    const t1 = performance.now();
    times.push(t1 - t0);
    lastSize = subsetBuf.byteLength;
    if (i === 0) {
      lastBuffer = subsetBuf;
    }
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  /** --- 渲染对比：仅裸 sfnt 输出（ttf 输出，含 otf 输入；woff2 输出跳过） --- */
  let ssim: number | null = null;
  let fullInk: number | null = null;
  let subsetInk: number | null = null;

  if (lastBuffer && tc.outType === "ttf") {
    const safeLabel = tc.label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");

    /**
     * maxp 健康检查（与浏览器版同源守护）：
     * maxPoints/maxContours 为 0 会导致渲染器跳过渲染。
     * OTF（CFF）输入产出 maxp 0.5 无此二字段，跳过。
     */
    if (tc.sourceType !== "otf") {
      const ttfView = new DataView(lastBuffer.buffer, lastBuffer.byteOffset, lastBuffer.byteLength);
      const numTbl = ttfView.getUint16(4, false);
      for (let ti = 0; ti < numTbl; ti++) {
        const toff = 12 + ti * 16;
        const tag = String.fromCharCode(
          ttfView.getUint8(toff),
          ttfView.getUint8(toff + 1),
          ttfView.getUint8(toff + 2),
          ttfView.getUint8(toff + 3),
        );
        if (tag === "maxp") {
          const moff = ttfView.getUint32(toff + 8, false);
          const maxPoints = ttfView.getUint16(moff + 6, false);
          const maxContours = ttfView.getUint16(moff + 8, false);
          if (maxPoints === 0 || maxContours === 0) {
            throw new Error(`子集字体 maxp 异常: maxPoints=${maxPoints} maxContours=${maxContours}`);
          }
          break;
        }
      }
    }

    /** full：原始字体文件（未做任何转换）注册为基准 family */
    const fullFamily = registerFamily(new Uint8Array(raw));
    const renderSize = tc.fontSize ?? 48;
    const fullResult = await renderTextViaLeafer(fullFamily, tc.text, renderSize);

    /** subset：fontSubset 产物（otf 输入 → CFF 轮廓裸 sfnt；ttf 输入 → glyf sfnt）注册另一 family */
    const subsetFamily = registerFamily(lastBuffer);
    const subsetResult = await renderTextViaLeafer(subsetFamily, tc.text, renderSize);

    await writeFile(`${SCREENSHOT_DIR}/${safeLabel}_full.png`, fullResult.png);
    await writeFile(`${SCREENSHOT_DIR}/${safeLabel}_subset.png`, subsetResult.png);

    fullInk = fullResult.inkPixels;
    subsetInk = subsetResult.inkPixels;
    ssim = calculateSSIM(fullResult.pixels, subsetResult.pixels, fullResult.width, fullResult.height);
  }

  results.push({ label: tc.label, sourceType: tc.sourceType, outType: tc.outType, avg, min, max, outputSize: lastSize, ssim, fullInk, subsetInk });
  const tag = tc.sourceType === "otf" ? "otf→ttf" : tc.outType;
  const ssimText = ssim === null ? "  ssim=-(woff2跳过)" : `  ssim=${ssim.toFixed(4)}`;
  const inkText = fullInk === null ? "" : `  ink=${fullInk}/${subsetInk}`;
  console.log(`  [${tag}] ${tc.label}: avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms  输出=${lastSize.toLocaleString()} bytes${ssimText}${inkText}`);
}

/** 保存结果到 JSON */
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultFile = `${BENCHMARK_DIR}/json/benchmark_leafer_${timestamp}.json`;
await writeFile(resultFile, JSON.stringify({ timestamp: new Date().toISOString(), renderer: "leafer-node", rounds: ROUNDS, results }, null, 2));
console.log(`\n结果已保存到 ${resultFile}`);
console.log(`渲染对比图片已保存到 ${SCREENSHOT_DIR}/ 目录\n`);

/** 汇总：有 SSIM 的用例全须 ≥0.99（与浏览器版验收标准一致） */
const ssimCases = results.filter((r) => r.ssim !== null);
const failed = ssimCases.filter((r) => (r.ssim as number) < 0.99);
if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} 个用例 SSIM < 0.99:`);
  for (const f of failed) {
    console.error(`    ${f.label} (${f.sourceType}→${f.outType}): ssim=${f.ssim}`);
  }
  process.exit(1);
}
console.log(`✓ 全部 ${ssimCases.length} 个渲染用例 SSIM ≥ 0.99`);
