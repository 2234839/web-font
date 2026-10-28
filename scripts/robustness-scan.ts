/**
 * 多字体鲁棒性扫描：全生产字体 × 多文本样本 × ttf/woff2
 * 三层校验：
 *   1. 头合法性：sfnt（version/numTables/表目录）或 woff2 魔数
 *   2. 确定性：同输入两次 sha256 一致
 *   3. OTS 真实加载：puppeteer FontFace.load()（第 18 轮实证头校验抓不住
 *      woff2 spec 盲区——空 glyf 解码合法但 OTS 拒载，必须真加载验证）
 * 原字体缺字（子集字形数少）不算失败；崩溃/非法输出/不确定性/OTS 拒载算失败
 * 用法：pnpx tsx scripts/robustness-scan.ts（仓库根目录执行，需 headless chrome）
 */
import { fontSubset } from "../backend/font_util/font.js";
import { readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import puppeteer from "puppeteer";
import type { Page } from "puppeteer";

/** 扫描文本样本：CJK 常用 / 标点 / 拉丁数字 / 代理对（BMP 外）/ 符号 */
const texts = [
  "天地玄黄宇宙洪荒",
  "你好，世界！测试标点。",
  "The quick brown fox 0123456789",
  "𠮷野家 emoji 🎉",
  "①②③→★♀♂",
];

/** 校验 ttf 输出：sfnt 头合法、表目录可读 */
function validateSfnt(buf: Uint8Array): string | null {
  if (buf.length < 12) return "过短";
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sfntVersion = dv.getUint32(0, false);
  if (sfntVersion !== 0x00010000 && sfntVersion !== 0x4f54544f /* OTTO */) {
    return `sfntVersion 非法: 0x${sfntVersion.toString(16)}`;
  }
  const numTables = dv.getUint16(4, false);
  if (numTables === 0 || numTables > 100) return `numTables 异常: ${numTables}`;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (off + 16 > buf.length) return "表目录越界";
    const length = dv.getUint32(off + 12, false)!;
    if (length === 0) return `表 ${i} length=0`;
  }
  return null;
}

/** 校验 woff2 输出：魔数 + 长度字段 */
function validateWoff2(buf: Uint8Array): string | null {
  if (buf.length < 44) return "过短";
  if (buf[0] !== 0x77 || buf[1] !== 0x4f || buf[2] !== 0x46 || buf[3] !== 0x32) {
    return "wOF2 魔数非法";
  }
  return null;
}

/**
 * OTS 真实加载校验：FontFace.load() 拒载即失败
 * 字节经 base64 传入（evaluate 走 JSON 序列化，Uint8Array 会被打散成对象）
 */
async function otsValidate(page: Page, base64: string): Promise<string | null> {
  return page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const face = new FontFace("__robustness_scan__", bytes.buffer);
    try {
      await face.load();
      return null;
    } catch (e) {
      return String(e);
    } finally {
      document.fonts.delete(face);
    }
  }, base64);
}

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("about:blank");

  const fonts = readdirSync("font").filter((f) => /\.(ttf|otf)$/i.test(f));
  let pass = 0;
  let fail = 0;
  let otsChecked = 0;
  for (const fontFile of fonts) {
    const path = `font/${fontFile}`;
    let buf: ArrayBuffer;
    try {
      const raw = readFileSync(path);
      buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    } catch (e) {
      console.log(`✗ ${fontFile}: 读取失败 ${e}`);
      fail++;
      continue;
    }
    const sourceType = fontFile.toLowerCase().endsWith(".otf") ? "otf" : "ttf";
    for (const text of texts) {
      try {
        const ttf = fontSubset(buf, text, { sourceType, outType: "ttf" }) as Uint8Array;
        const ttfErr = validateSfnt(ttf);
        const woff2 = fontSubset(buf, text, { sourceType, outType: "woff2" }) as Uint8Array;
        const w2Err = validateWoff2(woff2);
        // 确定性：ttf 再跑一次比对 sha
        const ttf2 = fontSubset(buf, text, { sourceType, outType: "ttf" }) as Uint8Array;
        const sha1 = createHash("sha256").update(ttf).digest("hex").slice(0, 12);
        const sha2 = createHash("sha256").update(ttf2).digest("hex").slice(0, 12);
        const problems: string[] = [];
        if (ttfErr) problems.push(`ttf: ${ttfErr}`);
        if (w2Err) problems.push(`woff2: ${w2Err}`);
        if (sha1 !== sha2) problems.push(`不确定: ${sha1} vs ${sha2}`);
        // OTS 真实加载：ttf 与 woff2 产物分别验证
        if (!ttfErr) {
          const ttfOts = await otsValidate(page, Buffer.from(ttf).toString("base64"));
          otsChecked++;
          if (ttfOts) problems.push(`ttf OTS 拒载: ${ttfOts}`);
        }
        if (!w2Err) {
          const w2Ots = await otsValidate(page, Buffer.from(woff2).toString("base64"));
          otsChecked++;
          if (w2Ots) problems.push(`woff2 OTS 拒载: ${w2Ots}`);
        }
        if (problems.length) {
          console.log(`✗ ${fontFile} "${text.slice(0, 6)}": ${problems.join("; ")}`);
          fail++;
        } else {
          pass++;
        }
      } catch (e) {
        console.log(`✗ ${fontFile} "${text.slice(0, 6)}": 崩溃 ${(e as Error).message}`);
        fail++;
      }
    }
    console.log(`  ${fontFile}: 完成`);
  }
  await browser.close();
  console.log(`\n== 结果: ${pass} PASS / ${fail} FAIL（字体 ${fonts.length} 个 × 文本 ${texts.length}，OTS 加载验证 ${otsChecked} 个产物）`);
}

main();
