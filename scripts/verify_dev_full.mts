// dev 5174 完整验收：7 路由 + 首页交互 + fonts 懒加载 + 详情页
import puppeteer from "puppeteer";
const BASE = "http://127.0.0.1:5174";
const results: string[] = [];
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
}
const browser = await puppeteer.launch({ headless: true, executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox", "--no-proxy-server"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
let errors: string[] = [];
let failed: string[] = [];
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text().slice(0, 150)); });
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 150)}`));
page.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
page.on("response", (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`); });

/** WSL2 网卡抖动会中断 Chromium 请求（ERR_NETWORK_CHANGED），导航与失败请求统一重试 */
async function gotoRetry(route: string) {
  for (let i = 0; ; i++) {
    try { return await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
}

/** 单页检查 */
async function visit(route: string, tag: string, mustContain: string[] = []) {
  errors = []; failed = [];
  const resp = await gotoRetry(route);
  await new Promise(r => setTimeout(r, 3500));
  const text = await page.evaluate(() => document.body.innerText);
  const missing = mustContain.filter(k => !text.includes(k));
  const ok = resp?.status() === 200 && missing.length === 0 && errors.length === 0 && failed.length === 0;
  check(`页面 ${route}`, ok, `${!ok ? [missing.length ? `缺:${missing.join(",")}` : "", errors.length ? `err:${errors[0]}` : "", failed.length ? `net:${failed[0]}` : ""].filter(Boolean).join(" ") : ""}`);
  await page.screenshot({ path: `/tmp/vd_${tag}.png` });
}

// 1. 全路由
await visit("/", "home", ["Web Font", "选择字体"]);
await visit("/fonts", "fonts", ["所有字体", "鸿蒙黑体"]);
await visit("/demo", "demo", ["静心"]);
await visit("/docs", "docs", ["SDK"]);
await visit("/offline-subset", "offline", ["离线字体裁剪"]);
await visit("/font-finder", "finder", ["截图找字体"]);

// 2. /fonts 懒加载：滚动到底，全部卡片预览字体化
await gotoRetry("/fonts");
for (let i = 0; i < 12; i++) { await page.evaluate(() => window.scrollBy(0, 700)); await new Promise(r => setTimeout(r, 500)); }
await new Promise(r => setTimeout(r, 3000));
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: "/tmp/vd_fonts_bottom.png" });
check("/fonts 滚动懒加载", errors.length === 0 && failed.length === 0, failed[0] ?? errors[0] ?? "");

// 3. 详情页（SSG+替换）
const fonts: Array<{ name: string }> = await (await fetch(BASE + "/api/fonts")).json();
await visit(`/fonts/${encodeURIComponent(fonts[0].name.replace(/\.ttf$/, ""))}`, "detail", [fonts[0].name.replace(/\.ttf$/, "")]);

// 4. 首页交互：切字体 → 输文字 → 验证预览字体已应用 → 下载子集
await gotoRetry("/");
await new Promise(r => setTimeout(r, 3000));
await page.evaluate(() => {
  const sel = document.querySelector("select") as HTMLSelectElement | null;
  if (sel) { sel.value = "思源黑体.ttf"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
});
await new Promise(r => setTimeout(r, 2500));
const previewInfo = await page.evaluate(() => {
  /** 首页预览是 textarea（文字在 value 里，textContent 为空）+ 上方渲染层 */
  const ta = document.querySelector("textarea");
  const layers = [...document.querySelectorAll("*")]
    .filter((n) => n.children.length === 0 && (n.textContent ?? "").includes("天地无极"))
    .map((n) => getComputedStyle(n).fontFamily);
  return { ta: ta ? getComputedStyle(ta).fontFamily : "(无)", layers: layers.join("|") || "(无)" };
});
check(
  "首页切字体+预览 fontFamily",
  [previewInfo.ta, previewInfo.layers].some((s) => s.includes("CustomFont") || s.includes("思源")),
  `textarea=${previewInfo.ta.slice(0, 40)} 层=${previewInfo.layers.slice(0, 60)}`,
);

// 下载子集（ttf 魔数校验）
const dl = await fetch(`${BASE}/api?font=${encodeURIComponent("思源黑体.ttf")}&text=${encodeURIComponent("天地无极")}&outType=ttf`);
const buf = Buffer.from(await dl.arrayBuffer());
check("子集下载 ttf 魔数", dl.status === 200 && buf.slice(0, 4).toString("hex") === "00010000", `status=${dl.status} head=${buf.slice(0, 4).toString("hex")}`);

await browser.close();
console.log(results.join("\n"));
console.log(fail === 0 ? `\n全部 ${results.length} 项通过` : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
