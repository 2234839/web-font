/**
 * 字体裁剪基准测试（Rust 后端版 SSIM）
 * 运行: pnpx tsx 基准测试_rust.test.ts [rustPort]
 *
 * 与 基准测试.test.ts（TS fontSubset 版）同构，subset 产物来源替换为
 * rust-spike HTTP 服务（/api?font=&text=&outType=）：
 *   1. 扫描 /mnt/d/字体资源 全部字体 + font/ 主目录字体生成用例
 *   2. full 渲染 = 原始字体文件（正确性基准，不做任何转换）
 *   3. subset 渲染 = Rust 服务产物，经浏览器 OTS + FontFace 真实加载
 *   4. DOM 渲染截图，calculateSSIM（与 TS 版同一实现，结果可直接对比）
 *
 * 达标线：ssim >= 0.98（历史固有差异下限：篆体 0.9876 / 初夏 0.9920）
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import puppeteer, { type Page } from "puppeteer";
import { calculateSSIM } from "./scripts/ssim.js";
import { PNG } from "pngjs";

const BENCHMARK_DIR = "benchmark_results";
const RUST_PORT = process.argv[2] || "8099";
/** 小样本冒烟：传入字体数（如 `pnpx tsx 基准测试_rust.test.ts 8099 3`），缺省 0 = 全量 */
const LIMIT = parseInt(process.argv[3] || "0", 10);
/** 名字子串过滤（如 `pnpx tsx 基准测试_rust.test.ts 8099 0 NotoSansCJK` 只测 OTF/CFF 路径） */
const NAME_FILTER = process.argv[4] || "";
const SCAN_DIRS = ["/mnt/d/字体资源", "font"];
const TEXT = "天地玄黄宇宙洪荒，你好世界！Hello 123";

// ======== 用例生成（全字体扫描） ========
interface Case {
  /** 展示标签 */
  label: string;
  /** 原始字体绝对路径（full 渲染基准） */
  fontPath: string;
  /** API font= 参数（= /tmp/ssim-fonts 中的 symlink 名） */
  apiFont: string;
  /** 输入轮廓类型 */
  sourceType: "ttf" | "otf";
  /** 输出容器 */
  outType: "ttf" | "woff2";
}

async function scanFonts(): Promise<Case[]> {
  const cases: Case[] = [];
  for (const dir of SCAN_DIRS) {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(ttf|otf)$/i.test(e.name)) continue;
      const parent = e.parentPath ?? dir;
      const fontPath = `${parent}/${e.name}`;
      if (fontPath.includes("node_modules") || fontPath.includes("zig-out") || fontPath.includes("target/")) continue;
      if (NAME_FILTER && !fontPath.includes(NAME_FILTER)) continue;
      const sourceType = e.name.toLowerCase().endsWith(".otf") ? "otf" : "ttf";
      const symlink = `/tmp/ssim-fonts/${e.name}`;
      for (const outType of ["ttf", "woff2"] as const) {
        cases.push({ label: `${e.name} ${outType}`, fontPath, apiFont: e.name, sourceType, outType });
      }
    }
  }
  return LIMIT > 0 ? cases.slice(0, LIMIT) : cases;
}

// ======== HTTP 服务器（HTML 渲染页 + 字体文件） ========
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

// ======== 无头浏览器渲染（与 TS 版 renderTextViaBrowser 同实现） ========
async function renderTextViaBrowser(
  page: Page,
  baseUrl: string,
  fontFamily: string,
  text: string,
  fontSize: number,
  fontFormat: string = "truetype",
): Promise<{ pixels: Uint8Array; screenshot: Uint8Array; inkPixels: number; width: number; height: number }> {
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

  const screenshot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } });
  const png = PNG.sync.read(Buffer.from(screenshot));
  const pixels = new Uint8Array(png.data);

  let inkPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 128) inkPixels++;
  }

  if (inkPixels === 0) {
    throw new Error(`字体渲染无墨水像素 (${fontFamily})，字体可能未正确加载`);
  }

  return { pixels, screenshot, inkPixels, width, height };
}

// ======== Rust 服务 subset 请求 ========
async function rustSubset(apiFont: string, text: string, outType: string): Promise<Buffer> {
  const q = new URLSearchParams({ font: apiFont, text, outType });
  const resp = await fetch(`http://127.0.0.1:${RUST_PORT}/api?${q}`);
  if (!resp.ok) {
    throw new Error(`Rust 服务 ${resp.status}: ${(await resp.text()).slice(0, 60)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ======== 主测试 ========
await mkdir(`${BENCHMARK_DIR}/screenshots_rust`, { recursive: true });

const cases = await scanFonts();
console.log(`\n=== Rust 版 SSIM 基准（${cases.length} 用例，文本：${TEXT}）===\n`);

const { server, port } = await createFontServer();
const baseUrl = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  headless: true,
  /** WSL2 无 snap 桌面环境，用系统 chromium-browser（版本恰与 puppeteer 锁定版本一致） */
  executablePath: "/usr/bin/chromium-browser",
  args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
});
const page = await browser.newPage();
page.setViewport({ width: 1600, height: 200 });
page.on("pageerror", (err) => console.log(`  [page-error] ${err instanceof Error ? err.message : String(err)}`));

console.log(`  渲染服务: ${baseUrl}  Rust 服务: 127.0.0.1:${RUST_PORT}\n`);

const results: Array<{
  label: string; sourceType: string; outType: string; ms: number;
  outputSize: number; ssim: number; fullInk: number; subsetInk: number; error?: string;
}> = [];

for (const tc of cases) {
  const safeLabel = tc.label.replace(/[^a-zA-Z0-9一-鿿]/g, "_");
  try {
    const t0 = performance.now();
    const subsetBuf = await rustSubset(tc.apiFont, TEXT, tc.outType);
    const ms = performance.now() - t0;

    /** 注册子集字体：OTF 输入产出 CFF 轮廓须用 .otf 扩展名 + opentype format（TS 版同规则） */
    const subsetExt = tc.sourceType === "otf" ? (tc.outType === "woff2" ? "woff2" : "otf") : tc.outType;
    const subsetKey = `subset_${safeLabel}.${subsetExt}`;
    fontStore.set(subsetKey, subsetBuf);

    const fullKey = `full_${safeLabel}`;
    const raw = await readFile(tc.fontPath);
    fontStore.set(fullKey + (tc.sourceType === "otf" ? ".otf" : ".ttf"), raw);

    const fullFormat = tc.sourceType === "otf" ? "opentype" : "truetype";
    const subsetFormat = tc.sourceType === "otf"
      ? (tc.outType === "woff2" ? "woff2" : "opentype")
      : (tc.outType === "woff2" ? "woff2" : "truetype");

    const fullResult = await renderTextViaBrowser(page, baseUrl, fullKey, TEXT, 48, fullFormat);
    const subsetResult = await renderTextViaBrowser(page, baseUrl, subsetKey, TEXT, 48, subsetFormat);

    await writeFile(`${BENCHMARK_DIR}/screenshots_rust/${safeLabel}_full.png`, fullResult.screenshot);
    await writeFile(`${BENCHMARK_DIR}/screenshots_rust/${safeLabel}_subset.png`, subsetResult.screenshot);

    const ssim = calculateSSIM(fullResult.pixels, subsetResult.pixels, fullResult.width, fullResult.height);
    results.push({ label: tc.label, sourceType: tc.sourceType, outType: tc.outType, ms: Math.round(ms), outputSize: subsetBuf.length, ssim, fullInk: fullResult.inkPixels, subsetInk: subsetResult.inkPixels });
    console.log(`  [${tc.outType}] ${tc.label}: ssim=${ssim.toFixed(4)}  输出=${subsetBuf.length.toLocaleString()}B  ${Math.round(ms)}ms  ink=${fullResult.inkPixels}/${subsetResult.inkPixels}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ label: tc.label, sourceType: tc.sourceType, outType: tc.outType, ms: 0, outputSize: 0, ssim: 0, fullInk: 0, subsetInk: 0, error: msg });
    console.log(`  [FAIL] ${tc.label}: ${msg.slice(0, 100)}`);
  }
}

await browser.close();
server.close();

// ======== 汇总与达标判定 ========
const PASS_LINE = 0.98;
const scored = results.filter((r) => !r.error);
const failed = results.filter((r) => r.error);
const below = scored.filter((r) => r.ssim < PASS_LINE);
const avgSsim = scored.length ? scored.reduce((a, r) => a + r.ssim, 0) / scored.length : 0;

console.log(`\n=== 汇总 ===`);
console.log(`  总用例 ${results.length}  达标(≥${PASS_LINE}) ${scored.length - below.length}  未达标 ${below.length}  请求失败 ${failed.length}`);
console.log(`  平均 SSIM = ${avgSsim.toFixed(4)}   最低 = ${scored.length ? Math.min(...scored.map((r) => r.ssim)).toFixed(4) : "-"}`);
for (const r of below) console.log(`  未达标: ${r.label} ssim=${r.ssim.toFixed(4)}`);
for (const r of failed) console.log(`  失败: ${r.label} -> ${(r.error ?? "").slice(0, 80)}`);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultFile = `${BENCHMARK_DIR}/json/benchmark_rust_${timestamp}.json`;
await writeFile(resultFile, JSON.stringify({ timestamp: new Date().toISOString(), backend: "rust-spike", passLine: PASS_LINE, results }, null, 2));
console.log(`\n结果已保存到 ${resultFile}`);
console.log(`渲染对比图片已保存到 ${BENCHMARK_DIR}/screenshots_rust/ 目录\n`);
