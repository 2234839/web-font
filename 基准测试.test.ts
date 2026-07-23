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

/**
 * 计算两张图片的标准 SSIM (Wang et al. 2004)
 * 使用 11x11 均匀滑动窗口 + 积分图加速，返回 0~1
 *
 * 修复：原实现用 Math.sqrt(像素数) 推断 width，假设图片为正方形。
 * 但渲染截图是宽长条（如 740×72），sqrt 会得到错误 width（230），
 * 导致像素坐标错位、SSIM 系统性偏低（尤其 OTF 用例被放大偏差）。
 * 改为由调用方传入真实 width/height。
 */
function calculateSSIM(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  if (a.length !== b.length) return 0;
  if (width * height * 4 !== a.length) return 0;
  if (width === 0 || height === 0) return 0;

  /** 转灰度并提取到独立数组 */
  const N = width * height;
  const grayA = new Float64Array(N);
  const grayB = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    grayA[i] = 0.299 * a[idx] + 0.587 * a[idx + 1] + 0.114 * a[idx + 2];
    grayB[i] = 0.299 * b[idx] + 0.587 * b[idx + 1] + 0.114 * b[idx + 2];
  }

  /** 构建积分图: S(x,y) = sum of gray[0..x-1, 0..y-1] */
  const w1 = width + 1;
  const intA = new Float64Array(w1 * (height + 1));
  const intA2 = new Float64Array(w1 * (height + 1));
  const intB = new Float64Array(w1 * (height + 1));
  const intB2 = new Float64Array(w1 * (height + 1));
  const intAB = new Float64Array(w1 * (height + 1));

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const irowOff = (y + 1) * w1;
    for (let x = 0; x < width; x++) {
      const va = grayA[rowOff + x];
      const vb = grayB[rowOff + x];
      const ip = irowOff + x + 1;
      intA[ip] = va + intA[ip - 1] + intA[ip - w1] - intA[ip - w1 - 1];
      intA2[ip] = va * va + intA2[ip - 1] + intA2[ip - w1] - intA2[ip - w1 - 1];
      intB[ip] = vb + intB[ip - 1] + intB[ip - w1] - intB[ip - w1 - 1];
      intB2[ip] = vb * vb + intB2[ip - 1] + intB2[ip - w1] - intB2[ip - w1 - 1];
      intAB[ip] = va * vb + intAB[ip - 1] + intAB[ip - w1] - intAB[ip - w1 - 1];
    }
  }

  /**
   * 从积分图计算矩形区域 [x1, x2) x [y1, y2) 的和
   * 矩形包含 (x2-x1) * (y2-y1) 个像素
   */
  const rectSum = (img: Float64Array, x1: number, y1: number, x2: number, y2: number) =>
    img[y2 * w1 + x2] - img[y1 * w1 + x2] - img[y2 * w1 + x1] + img[y1 * w1 + x1];

  /** 11x11 窗口, 半径=5 */
  const R = 5;
  const C1 = 6.5025;   // (0.01 * 255)^2
  const C2 = 58.5225;  // (0.03 * 255)^2

  let ssimSum = 0;
  let windowCount = 0;

  for (let y = R; y < height - R; y++) {
    for (let x = R; x < width - R; x++) {
      const x1 = x - R, x2 = x + R + 1;
      const y1 = y - R, y2 = y + R + 1;
      const n = (2 * R + 1) * (2 * R + 1);

      const sA = rectSum(intA, x1, y1, x2, y2);
      const sA2 = rectSum(intA2, x1, y1, x2, y2);
      const sB = rectSum(intB, x1, y1, x2, y2);
      const sB2 = rectSum(intB2, x1, y1, x2, y2);
      const sAB = rectSum(intAB, x1, y1, x2, y2);

      const muA = sA / n;
      const muB = sB / n;
      const sigmaA2 = sA2 / n - muA * muA;
      const sigmaB2 = sB2 / n - muB * muB;
      const sigmaAB = sAB / n - muA * muB;

      const num = (2 * muA * muB + C1) * (2 * sigmaAB + C2);
      const den = (muA * muA + muB * muB + C1) * (sigmaA2 + sigmaB2 + C2);
      ssimSum += num / den;
      windowCount++;
    }
  }

  return windowCount > 0 ? ssimSum / windowCount : 0;
}

// ======== 测试配置 ========

/**
 * 千字文中段（接续前段，用于更长文本压力测试）
 */
const QIANZIWEN_MID = "墨悲丝染诗赞羔羊景行维贤克念作圣德建名立形端表正空谷传声虚堂习听祸因恶积福缘善庆尺璧非宝寸阴是竞资父事君曰严与敬孝当竭力忠则尽命临深履薄夙兴温凊似兰斯馨如松之盛川流不息渊澄取映";

const testCases = [
  /** ===== 令东齐伋复刻体（TTF，楷书复古字体，主基准） ===== */
  { label: "8个汉字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "8个汉字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "拉丁+数字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "Hello World 123", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "拉丁+数字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "Hello World 123", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "千字文前段", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "千字文前段", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** 重复字符：守护 codePoints 去重逻辑，相同字形不应重复输出 */
  { label: "重复字符", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天天天天地地地地", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },

  /** ===== 思源黑体（TTF，无衬线黑体，字形简洁） ===== */
  { label: "思源黑体-8字", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "思源黑体-8字", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** 纯标点：非汉字字形 + 组合标记的渲染守护 */
  { label: "思源黑体-标点", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "，。！？、；：“”‘’", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** CJK 扩展 B 罕见字（代理对）：守护 textToCodePoints 的代理对跳过逻辑 */
  { label: "思源黑体-扩展B", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: "𠮷𡧑𢀖𤍤𥝹", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** 千字文中段：超长文本压力测试（>100 字） */
  { label: "思源黑体-千字文中段", fontPath: "font/思源黑体.ttf", fontName: "思源黑体", text: QIANZIWEN_MID, sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },

  /** ===== Yi山碑篆体（TTF，笔画极其复杂的篆书，字形数据量大） ===== */
  { label: "篆体-8字", fontPath: "font/temp/YiShanBeiZhuanTi.ttf", fontName: "Yi山碑篆体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "ttf" as const, fullFormat: "truetype" },
  { label: "篆体-8字", fontPath: "font/temp/YiShanBeiZhuanTi.ttf", fontName: "Yi山碑篆体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },

  /** ===== OTF 字体（含三点水等复杂笔画字，守护 OTF→TTF 转换正确性） ===== */
  { label: "otf-五个汉字", fontPath: "font/temp/BaiHuOTFJiaoYuHanZi-2.otf", fontName: "白狐教育汉字", text: "天地黄宇宙法海波", sourceType: "otf" as const, outType: "ttf" as const, fullFormat: "opentype" },
  /** OTF→woff2 输出路径守护（之前仅测 ttf 输出） */
  { label: "otf-五个汉字", fontPath: "font/temp/BaiHuOTFJiaoYuHanZi-2.otf", fontName: "白狐教育汉字", text: "天地黄宇宙法海波", sourceType: "otf" as const, outType: "woff2" as const, fullFormat: "opentype" },
  { label: "otf-思源黑体", fontPath: "font/temp/SourceHanSans-Regular.otf", fontName: "思源黑体", text: "天地玄黄宇宙洪法海波", sourceType: "otf" as const, outType: "ttf" as const, fullFormat: "opentype" },
  { label: "otf-思源黑体", fontPath: "font/temp/SourceHanSans-Regular.otf", fontName: "思源黑体", text: "天地玄黄宇宙洪法海波", sourceType: "otf" as const, outType: "woff2" as const, fullFormat: "opentype" },

  /** ===== 小字号渲染（size=24，守护 SSIM 在小字号下不退化） ===== */
  { label: "小字号-8字", fontPath: "font/令东齐伋复刻体.ttf", fontName: "令东齐伋复刻体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype", fontSize: 24 },
  { label: "小字号-篆体", fontPath: "font/temp/YiShanBeiZhuanTi.ttf", fontName: "Yi山碑篆体", text: "天地玄黄宇宙洪荒", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype", fontSize: 24 },

  /**
   * ===== D:\字体资源 多字体扩展覆盖 =====
   * 用「汉字+标点」混合文本，最能暴露 GPOS 标点压缩丢失问题。
   * 覆盖不同 GPOS lookup 类型：得意黑仅 PairPos(完全支持)，霞鹜文楷含 ChainedContextPos(type8，降级)，
   * 思源宋体(OTF)含 MarkBasePos(type4，降级)。降级时保留原始 GPOS 字节，验证不劣于子集化前。
   */
  { label: "得意黑-汉字标点", fontPath: "/mnt/d/字体资源/得意黑/SmileySans-Oblique.ttf", fontName: "得意黑", text: "你好，世界！今天天气不错。", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "霞鹜文楷-汉字标点", fontPath: "/mnt/d/字体资源/霞鹜文楷/LXGWWenKai-Regular.ttf", fontName: "霞鹜文楷", text: "你好，世界！今天天气不错。", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** 初夏明朝（TTF，宋体/明朝风格衬线字，含标点压缩） */
  { label: "初夏明朝-汉字标点", fontPath: "/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf", fontName: "初夏明朝", text: "你好，世界！今天天气不错。", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "霞鹜文楷-纯标点", fontPath: "/mnt/d/字体资源/霞鹜文楷/LXGWWenKai-Regular.ttf", fontName: "霞鹜文楷", text: "，。！？、；：“”‘’", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "初夏明朝-纯标点", fontPath: "/mnt/d/字体资源/初夏明朝/初夏明朝-Regular.ttf", fontName: "初夏明朝", text: "，。！？、；：“”‘’", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  { label: "得意黑-纯标点", fontPath: "/mnt/d/字体资源/得意黑/SmileySans-Oblique.ttf", fontName: "得意黑", text: "，。！？、；：“”‘’", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** 鸿蒙黑体（TTF，现代无衬线，GPOS 仅 SinglePos/PairPos） */
  { label: "鸿蒙黑体-汉字标点", fontPath: "/mnt/d/字体资源/鸿蒙字体/HarmonyOS_Sans_SC_Black.ttf", fontName: "鸿蒙黑体", text: "你好，世界！今天天气不错。", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** 优设标题黑（TTF，艺术黑体） */
  { label: "优设标题黑-汉字标点", fontPath: "/mnt/d/字体资源/优设标题黑/优设标题黑.ttf", fontName: "优设标题黑", text: "你好，世界！今天天气不错。", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
  /** FiraCode（拉丁等宽，GPOS 做 ligature，非 CJK 标点，验证降级路径不破坏拉丁字体） */
  { label: "FiraCode-代码", fontPath: "/mnt/d/字体资源/FiraCode/FiraCode-Medium.ttf", fontName: "FiraCode", text: "=> !== >= <= ===", sourceType: "ttf" as const, outType: "woff2" as const, fullFormat: "truetype" },
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

    /** 渲染完整字体（fontSize 可选，默认 48；小字号用例用于守护 SSIM 在低分辨率下不退化） */
    const renderSize = tc.fontSize ?? 48;
    const fullResult = await renderTextViaBrowser(page, baseUrl, fullKey, tc.text, renderSize, tc.fullFormat);

    /**
     * 渲染子集字体：format 必须与 outType 匹配。
     * woff2 字节若用 format("truetype") 声明，Chrome 嗅探解码时序下可能未及时应用 GPOS
     * （CJK 全角标点的标点压缩依赖 GPOS lookup），导致连续标点宽度变大、与原始字体人眼不一致。
     * 改为按实际 outType 声明 format，确保 GPOS 等 layout 表被正确加载。
     */
    const subsetFormat = tc.outType === "woff2" ? "woff2" : "truetype";
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
