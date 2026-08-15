/**
 * 字体裁剪基准测试（无头浏览器版）
 * 运行: pnpx tsx 基准测试.test.ts
 *
 * 原理:
 *   1. 直接调用 backend/font_util/font.ts 的 fontSubset（与 API 完全一致）
 *   2. 本地 HTTP 服务器同时提供 HTML 页面和字体文件
 *   3. 完整字体（full）直接使用原始字体文件渲染，不做任何转换（这是基准参照）
 *   4. 子集字体通过 fontSubset 子集化后，通过 @font-face + HTTP URL 加载
 *   5. 在浏览器 DOM 中渲染文字，截图并计算 SSIM
 *
 * 注意: full 渲染必须用原始字体，这是正确性的基准。如果 full 渲染都不对，
 *       那么 subset 的 SSIM 对比就毫无意义。
 *
 * 测量:
 *   1. 子集化总耗时（fontSubset）
 *   2. 渲染相似度（完整字体 vs 子集字体，SSIM 指标）
 *   3. 输出渲染对比图片到 benchmark_results/screenshots/ 目录
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import puppeteer, { type Page } from "puppeteer";
import { fontSubset } from "./backend/font_util/font.js";
import { testCases } from "./基准测试用例.js";
import { calculateSSIM } from "./scripts/ssim.js";
import { PNG } from "pngjs";

const BENCHMARK_DIR = "benchmark_results";
const ROUNDS = 10;

// ======== HTTP 服务器 ========
const fontStore = new Map<string, Buffer>();

function createFontServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://localhost`);
      const path = url.pathname;

      if (path === "/render") {
        const params = url.searchParams;
        const fontFamily = params.get("font") || "TestFont";
        const fontFormat = params.get("format") || "truetype";
        const text = params.get("text") || "";
        const fontSize = parseInt(params.get("size") || "48", 10);
        const width = parseInt(params.get("width") || "800", 10);
        const height = parseInt(params.get("height") || "80", 10);

        const html = `<!DOCTYPE html>
<html><head>
<style>
  @font-face { font-family: "${fontFamily}"; src: url("/fonts/${fontFamily}") format("${fontFormat}"); }
  body { margin: 0; background: white; }
  #text { font-family: "${fontFamily}", sans-serif; font-size: ${fontSize}px; line-height: 1.2; color: black; padding: ${Math.ceil(fontSize * 0.1)}px 10px; display: inline-block; white-space: nowrap; }
</style></head><body>
<div id="text">${text.replace(/</g, "&lt;")}</div>
<script>
(async () => {
  try {
    const fontFace = await document.fonts.load('${fontSize}px "${fontFamily}"');
    const loaded = document.fonts.check('${fontSize}px "${fontFamily}"');
    if (!loaded) { document.title = 'error=font not loaded'; return; }
    await new Promise(r => setTimeout(r, 500));
    const stillLoaded = document.fonts.check('${fontSize}px "${fontFamily}"');
    if (!stillLoaded) { document.title = 'error=font lost after wait'; return; }
    document.title = 'ready';
  } catch(e) { document.title = 'error=' + e.message; }
})();
</script>
</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (path.startsWith("/fonts/")) {
        const fontKey = decodeURIComponent(path.slice("/fonts/".length));
        let buf = fontStore.get(fontKey);
        if (!buf) buf = fontStore.get(fontKey + ".ttf");
        if (!buf) buf = fontStore.get(fontKey + ".otf");
        if (!buf) buf = fontStore.get(fontKey + ".woff2");
        if (buf) {
          console.log(`[fontsrv] GET ${fontKey} -> ${buf.length} bytes`);
          const ext = fontKey.endsWith(".woff2") ? "font/woff2" : fontKey.endsWith(".otf") ? "font/opentype" : "font/ttf";
          res.writeHead(200, { "Content-Type": ext, "Content-Length": buf.length, "Cache-Control": "public, max-age=31536000, immutable" });
          res.end(buf);
          return;
        }
      }

      res.writeHead(404);
      res.end("not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

// ======== 无头浏览器渲染 ========

async function renderTextViaBrowser(
  page: Page,
  baseUrl: string,
  fontFamily: string,
  text: string,
  fontSize: number,
  fontFormat: string = "truetype",
): Promise<{ pixels: Uint8Array; screenshot: Buffer; inkPixels: number; width: number; height: number }> {
  const charWidth = Math.ceil(fontSize * 1.5);
  const width = text.length * charWidth + 20;
  const height = Math.ceil(fontSize * 1.5);
  const renderUrl = `${baseUrl}/render?font=${encodeURIComponent(fontFamily)}&text=${encodeURIComponent(text)}&size=${fontSize}&width=${width}&height=${height}&format=${encodeURIComponent(fontFormat)}`;

  await page.goto("about:blank");
  await page.setViewport({ width, height });
  await page.goto(renderUrl, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.title === "ready" || document.title.startsWith("error="), { timeout: 60000 });

  const title = await page.title();
  if (title.startsWith("error=")) {
    throw new Error(`字体渲染失败 (${fontFamily}): ${title.slice(6)}`);
  }

  /**
   * DOM 渲染 + puppeteer 截图（而非 canvas 直接绘制）
   * 截图后用 pngjs 解码获取像素数据用于 SSIM 计算
   */
  const screenshot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  const png = PNG.sync.read(screenshot);
  const pixels = new Uint8Array(png.data);

  let inkPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 128) inkPixels++;
  }

  if (inkPixels === 0) {
    throw new Error(`字体渲染无墨水像素 (${fontFamily})，字体可能未正确加载`);
  }

  return { pixels, screenshot: Buffer.from(screenshot), inkPixels, width, height };
}

// ======== 测试配置（用例表见 基准测试用例.ts，与 leafer 版共享） ========


// ======== 主测试 ========
await mkdir(`${BENCHMARK_DIR}/json`, { recursive: true });
await mkdir(`${BENCHMARK_DIR}/screenshots`, { recursive: true });

console.log("\n=== 字体裁剪基准测试 ===\n");

/** 预加载字体文件 */
const fontBuffers = new Map<string, ArrayBuffer>();
for (const tc of testCases) {
  if (!fontBuffers.has(tc.fontPath)) {
    const raw = await readFile(tc.fontPath);
    fontBuffers.set(tc.fontPath, new Uint8Array(raw).buffer);
  }
}

/** 注册完整字体到 HTTP 服务器 */
for (const tc of testCases) {
  const key = `full_${tc.sourceType}_${tc.label}.ttf`;
  const raw = await readFile(tc.fontPath);
  fontStore.set(key, Buffer.from(raw));
  /** OTF 也注册 .otf 后缀 */
  if (tc.sourceType === "otf") {
    fontStore.set(key.replace(".ttf", ".otf"), Buffer.from(raw));
  }
}

/** 启动 HTTP 服务器和无头浏览器 */
const { server, port } = await createFontServer();
const baseUrl = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
});
const page = await browser.newPage();
page.setViewport({ width: 1200, height: 800 });
page.on("console", (msg) => console.log(`  [browser] ${msg.text()}`));
page.on("pageerror", (err) => console.log(`  [page-error] ${err.message}`));

console.log(`  HTTP 服务器: ${baseUrl}`);
console.log(`  无头浏览器: 已启动\n`);

const results: Array<{
  label: string;
  sourceType: string;
  outType: string;
  avg: number;
  min: number;
  max: number;
  outputSize: number;
  ssim: number;
  fullInk: number;
  subsetInk: number;
}> = [];

for (const tc of testCases) {
  const buf = fontBuffers.get(tc.fontPath)!;

  /** --- 子集化测试（调用 API 的 fontSubset） --- */
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

  /** --- 渲染对比 --- */
  let ssim = 0;
  let fullInk = 0;
  let subsetInk = 0;

  if (lastBuffer) {
    const safeLabel = tc.label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");

    /**
     * 验证子集字体的 maxp 表中 maxPoints/maxContours 不为 0
     * 这两个值为 0 会导致浏览器跳过渲染（字体加载成功但文字显示空白/fallback）
     * 之前 OTF→TTF 转换因 optimizettf 中 _flatContours 路径遗漏统计而触发此问题。
     * OTF（CFF）输入的 maxp 是 version 0.5（仅 numGlyphs，无 maxPoints/maxContours 字段），
     * 该检查不适用，跳过。
     */
    if (tc.outType !== "woff2" && tc.sourceType !== "otf") {
      const ttfView = new DataView(lastBuffer.buffer, lastBuffer.byteOffset, lastBuffer.byteLength);
      const numTbl = ttfView.getUint16(4, false);
      for (let ti = 0; ti < numTbl; ti++) {
        const toff = 12 + ti * 16;
        const tag = String.fromCharCode(ttfView.getUint8(toff), ttfView.getUint8(toff + 1), ttfView.getUint8(toff + 2), ttfView.getUint8(toff + 3));
        if (tag === "maxp") {
          const moff = ttfView.getUint32(toff + 8, false);
          const maxPoints = ttfView.getUint16(moff + 6, false);
          const maxContours = ttfView.getUint16(moff + 8, false);
          if (maxPoints === 0 || maxContours === 0) {
            throw new Error(`子集字体 maxp 异常: maxPoints=${maxPoints} maxContours=${maxContours}（浏览器将跳过渲染）`);
          }
          break;
        }
      }
    }

    /** 注册子集字体。
     *  otf 输入经 subsetOTF 产出 CFF 轮廓（无论 outType=ttf/woff2），裸输出必须用 .otf 扩展名，
     *  否则 HTTP Content-Type 会被判为 font/ttf 而浏览器以 truetype 嗅探 CFF 字节失败。
     *  woff2 输出仍用 .woff2（其 magic 自描述，扩展名无关）。 */
    const subsetExt = tc.sourceType === "otf"
      ? (tc.outType === "woff2" ? "woff2" : "otf")
      : tc.outType;
    const subsetKey = `subset_${safeLabel}.${subsetExt}`;
    fontStore.set(subsetKey, Buffer.from(lastBuffer));

    /** 完整字体 key */
    const fullKey = tc.sourceType === "otf"
      ? `full_otf_${tc.label}.otf`
      : `full_ttf_${tc.label}.ttf`;

    /** 渲染完整字体（fontSize 可选，默认 48；小字号用例用于守护 SSIM 在低分辨率下不退化） */
    const renderSize = tc.fontSize ?? 48;
    const fullResult = await renderTextViaBrowser(page, baseUrl, fullKey, tc.text, renderSize, tc.fullFormat);

    /**
     * 渲染子集字体：format 必须与字体实际轮廓类型匹配。
     * otf 输入经 subsetOTF 保留 CFF 轮廓（无论 outType=otf 还是 woff2 包裹），必须声明 format("opentype")
     * （或 woff2）让浏览器按 CFF 光栅化，否则用 truetype 声明会嗅探失败。
     * ttf 输入产出 glyf 轮廓，woff2 输出声明 woff2，裸 ttf 声明 truetype。
     */
    const subsetFormat = tc.sourceType === "otf"
      ? (tc.outType === "woff2" ? "woff2" : "opentype")
      : (tc.outType === "woff2" ? "woff2" : "truetype");
    const subsetResult = await renderTextViaBrowser(page, baseUrl, subsetKey, tc.text, renderSize, subsetFormat);

    await writeFile(`${BENCHMARK_DIR}/screenshots/${safeLabel}_full.png`, fullResult.screenshot);
    await writeFile(`${BENCHMARK_DIR}/screenshots/${safeLabel}_subset.png`, subsetResult.screenshot);

    fullInk = fullResult.inkPixels;
    subsetInk = subsetResult.inkPixels;
    ssim = calculateSSIM(fullResult.pixels, subsetResult.pixels, fullResult.width, fullResult.height);
  }

  results.push({ label: tc.label, sourceType: tc.sourceType, outType: tc.outType, avg, min, max, outputSize: lastSize, ssim, fullInk, subsetInk });
  const tag = tc.sourceType === "otf" ? "otf→ttf" : tc.outType;
  console.log(`  [${tag}] ${tc.label}: avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms  输出=${lastSize.toLocaleString()} bytes  ssim=${ssim.toFixed(4)}  ink=${fullInk}/${subsetInk}`);
}

/** 清理 */
await browser.close();
server.close();

/** 保存结果到 JSON */
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultFile = `${BENCHMARK_DIR}/json/benchmark_${timestamp}.json`;
await writeFile(resultFile, JSON.stringify({ timestamp: new Date().toISOString(), rounds: ROUNDS, results }, null, 2));
console.log(`\n结果已保存到 ${resultFile}`);
console.log(`渲染对比图片已保存到 ${BENCHMARK_DIR}/screenshots/ 目录\n`);
