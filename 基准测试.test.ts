/**
 * 字体裁剪基准测试（无头浏览器版）
 * 运行: pnpx tsx 基准测试.test.ts
 *
 * 原理:
 *   1. 直接调用 backend/font_util/font.ts 的 fontSubset（与 API 完全一致）
 *   2. 本地 HTTP 服务器同时提供 HTML 页面和字体文件
 *   3. 完整字体通过 @font-face + HTTP URL 加载（与浏览器实际行为一致）
 *   4. 子集字体也通过 @font-face + HTTP URL 加载
 *   5. 在浏览器 canvas 中渲染文字，截图并计算 SSIM
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
  #text { font-family: "${fontFamily}", sans-serif; font-size: ${fontSize}px; line-height: 1.2; color: black; padding: ${Math.ceil(fontSize * 0.1)}px 10px; display: inline-block; }
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
): Promise<{ pixels: Uint8Array; screenshot: Buffer; inkPixels: number }> {
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
   * 使用 DOM 渲染 + 页面截图来获取像素数据（而非 canvas）
   * 这样更贴近真实浏览器渲染行为，能检测到 maxp 等表异常导致的不渲染
   */
  const screenshot = await page.screenshot({ type: "png" });
  const pixelData = await page.evaluate(() => {
    const el = document.getElementById("text")!;
    const rect = el.getBoundingClientRect();
    /** 用 canvas 从 DOM 元素提取像素 */
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(document.documentElement as any, 0, 0);
    const imgData = ctx.getImageData(Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height));
    let ink = 0;
    for (let i = 0; i < imgData.data.length; i += 4) { if (imgData.data[i] < 128) ink++; }
    return { pixels: Array.from(imgData.data), ink };
  });

  const inkPixels = pixelData.ink;
  if (inkPixels === 0) {
    throw new Error(`字体渲染无墨水像素 (${fontFamily})，字体可能未正确加载`);
  }

  return { pixels: new Uint8Array(pixelData.pixels), screenshot: Buffer.from(screenshot), inkPixels };
}

/** 计算两张图片的结构相似度（简化版 SSIM），返回 0~1 */
function calculateSSIM(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  const pixelCount = a.length / 4;
  let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const ga = 0.299 * a[idx] + 0.587 * a[idx + 1] + 0.114 * a[idx + 2];
    const gb = 0.299 * b[idx] + 0.587 * b[idx + 1] + 0.114 * b[idx + 2];
    sumA += ga; sumB += gb;
    sumA2 += ga * ga; sumB2 += gb * gb; sumAB += ga * gb;
  }
  const meanA = sumA / pixelCount, meanB = sumB / pixelCount;
  const varA = sumA2 / pixelCount - meanA * meanA;
  const varB = sumB2 / pixelCount - meanB * meanB;
  const covAB = sumAB / pixelCount - meanA * meanB;
  const C1 = 6.5025, C2 = 58.5225;
  return (2 * meanA * meanB + C1) * (2 * covAB + C2) / ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
}

// ======== 测试配置 ========

const testCases = [
  /** TTF 字体 */
  { label: "8个汉字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "8个汉字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "拉丁+数字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "Hello World 123", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "拉丁+数字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "Hello World 123", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "千字文前段", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "千字文前段", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** OTF 字体 */
  { label: "otf-五个汉字", fontPath: "font/temp/BaiHuOTFJiaoYuHanZi-2.otf", fontName: "白狐教育汉字", text: "天地黄宇宙", sourceType: "otf" as const, outType: "ttf" as const, fullFormat: "opentype" },
];

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
    if (i === 0) lastBuffer = subsetBuf;
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
     * 之前 OTF→TTF 转换因 optimizettf 中 _flatContours 路径遗漏统计而触发此问题
     */
    if (tc.outType !== "woff2") {
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

    /** 注册子集字体 */
    const subsetKey = `subset_${safeLabel}.${tc.outType}`;
    fontStore.set(subsetKey, Buffer.from(lastBuffer));

    /** 完整字体 key */
    const fullKey = tc.sourceType === "otf"
      ? `full_otf_${tc.label}.otf`
      : `full_ttf_${tc.label}.ttf`;

    /** 渲染完整字体 */
    const fullResult = await renderTextViaBrowser(page, baseUrl, fullKey, tc.text, 48, tc.fullFormat);

    /** 渲染子集字体 */
    const subsetResult = await renderTextViaBrowser(page, baseUrl, subsetKey, tc.text, 48, "truetype");

    await writeFile(`${BENCHMARK_DIR}/screenshots/${safeLabel}_full.png`, fullResult.screenshot);
    await writeFile(`${BENCHMARK_DIR}/screenshots/${safeLabel}_subset.png`, subsetResult.screenshot);

    fullInk = fullResult.inkPixels;
    subsetInk = subsetResult.inkPixels;
    ssim = calculateSSIM(fullResult.pixels, subsetResult.pixels);
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
