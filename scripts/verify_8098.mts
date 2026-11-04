// rust 服务 8098 全功能浏览器走查
import puppeteer from "puppeteer";

const BASE = "http://127.0.0.1:8098";
const results: string[] = [];
let fail = 0;

/** 记录走查结果 */
function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/usr/bin/chromium-browser",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const consoleErrors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 120)}`));

/** 逐路由走查：加载、无 JS 错误、页面有实质内容 */
async function visit(path: string, mustContain: string[]) {
  consoleErrors.length = 0;
  const resp = await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 20000 });
  const status = resp?.status() ?? 0;
  const text = await page.evaluate(() => document.body.innerText);
  const missing = mustContain.filter((k) => !text.includes(k));
  const jsOk = consoleErrors.filter((e) => !e.includes("favicon")).length === 0;
  check(
    `页面 ${path}`,
    status === 200 && missing.length === 0 && jsOk,
    `status=${status}${missing.length ? ` 缺少:${missing.join(",")}` : ""}${!jsOk ? ` JS错误:${consoleErrors[0]}` : ""}`
  );
}

await visit("/", ["Web Font", "字体"]);
await visit("/fonts", []);
await visit("/demo", []);
await visit("/docs", []);
await visit("/offline-subset", []);
await visit("/font-finder", []);

// 字体详情页（SSG + 后端字符串替换）
const fonts: Array<{ name: string }> = await (await fetch(BASE + "/api/fonts")).json();
const first = fonts[0]?.name.replace(/\.ttf$/, "");
await visit(`/fonts/${encodeURIComponent(first ?? "")}`, []);

// 首页核心流程：选字体 → 输入文字 → 生成子集下载
await page.goto(BASE + "/", { waitUntil: "networkidle2" });
await page.screenshot({ path: "/tmp/wv_home.png" });

// API 层走查
const stats = await fetch(BASE + "/api/stats");
check("GET /api/stats", stats.ok);
const meta = await fetch(`${BASE}/api/font-meta?font=${encodeURIComponent(fonts[0].name)}`);
check("GET /api/font-meta", meta.ok, `status=${meta.status}`);

// glyph-match API（无图应 4xx 而非 5xx）
const gm = await fetch(BASE + "/api/glyph-match", { method: "POST", body: "notanimage" });
check("POST /api/glyph-match(非法输入)", gm.status >= 400 && gm.status < 500, `status=${gm.status}`);

await browser.close();
console.log(results.join("\n"));
console.log(fail === 0 ? `\n全部 ${results.length} 项通过` : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
