/**
 * 截图找字体 —— 服务端比对自测（无需浏览器，直接测核心算法）
 *
 * 自测方法（self-consistent 验证）：
 *  1. 用 getGlyphBitmap 渲染「思源黑体」的目标字，得到 64x64 归一化位图
 *  2. 把这些位图当作「用户截图切分后的查询输入」
 *  3. 跑全库 glyphSimilarity 比对，思源黑体必须排第一（自渲自比，满分 1.0）
 *
 * 这一步验证的是服务端光栅化 + 比对的核心链路正确性。
 * 前端二值化/切分用另一组注入测试覆盖。
 */
import "../backend/server/node";
import { loadFontObject, getGlyphBitmap, glyphSimilarity } from "../backend/font_util/glyph_bitmap";
import { findFontPath, readFontBuffer } from "../backend/shared";
import { readdir } from "../backend/interface";
import { fontDirs } from "../backend/config";

const TARGET_FONT = "思源黑体.ttf";
const TEXT = "天地玄黄";

async function main() {
  console.log("=== 服务端字形比对自测 ===");

  /** 1. 渲染目标字体的查询位图（模拟截图切分输入） */
  const ttf = await loadFontObject(TARGET_FONT, async (name) => {
    const p = await findFontPath(name);
    return p ? readFontBuffer(p) : null;
  });
  if (!ttf) throw new Error(`无法加载目标字体 ${TARGET_FONT}`);

  const queryBitmaps: Uint8Array[] = [];
  for (const ch of TEXT) {
    const cp = ch.codePointAt(0)!;
    const bm = getGlyphBitmap(ttf, TARGET_FONT, cp);
    if (!bm) throw new Error(`${TARGET_FONT} 渲染 ${ch} 失败（返回空位图）`);
    const ink = bm.reduce((a, b) => a + b, 0);
    console.log(`  ${ch} (U+${cp.toString(16)}): 位图墨点数=${ink}`);
    if (ink < 20) throw new Error(`${ch} 位图墨点过少，光栅化可能有问题`);
    queryBitmaps.push(bm);
  }
  console.log(`✓ 目标字体 ${TARGET_FONT} 的「${TEXT}」渲染成功\n`);

  /** 2. 遍历全库字体，用同样的字做 glyphSimilarity 比对 */
  const fontNames: string[] = [];
  for (const dir of fontDirs) {
    try {
      for (const e of await readdir(dir)) {
        if (e.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(e.name)) fontNames.push(e.name);
      }
    } catch {}
  }
  console.log(`全库共 ${fontNames.length} 个字体，开始比对…`);

  const results: Array<{ font: string; score: number; perChar: number[] }> = [];
  for (const font of fontNames) {
    const f = await loadFontObject(font, async (name) => {
      const p = await findFontPath(name);
      return p ? readFontBuffer(p) : null;
    });
    if (!f) continue;
    const perChar: number[] = [];
    let sum = 0;
    let missing = false;
    for (let i = 0; i < TEXT.length; i++) {
      const cp = TEXT.codePointAt(i)!;
      const cand = getGlyphBitmap(f, font, cp);
      if (!cand) {
        missing = true;
        continue;
      }
      const s = glyphSimilarity(queryBitmaps[i]!, cand);
      perChar.push(s);
      sum += s;
    }
    results.push({ font, score: perChar.length ? sum / perChar.length : 0, perChar });
    if (missing) console.log(`  ${font}: 缺字`);
  }

  results.sort((a, b) => b.score - a.score);
  console.log("\n=== 比对结果（Top 10）===");
  for (const r of results.slice(0, 10)) {
    console.log(
      `${r.score.toFixed(4)}  ${r.font}  [${r.perChar.map((s) => s.toFixed(3)).join(", ")}]`,
    );
  }

  /** 3. 断言：目标字体必须排第一，且分数接近 1.0 */
  const top = results[0]!;
  if (top.font !== TARGET_FONT) {
    console.error(`\n❌ FAIL: 目标字体 ${TARGET_FONT} 应排第一，实际第一是 ${top.font}`);
    const targetRank = results.findIndex((r) => r.font === TARGET_FONT);
    const target = results[targetRank];
    console.error(`   目标字体实际排第 ${targetRank + 1}，分数 ${target?.score.toFixed(4)}`);
    process.exit(1);
  }
  if (top.score < 0.95) {
    console.error(`\n❌ FAIL: 目标字体自渲自比分数应接近 1.0，实际 ${top.score.toFixed(4)}`);
    process.exit(1);
  }
  console.log(`\n✅ PASS: ${TARGET_FONT} 正确排第一，分数 ${top.score.toFixed(4)}（自渲自比）`);
}

main().catch((err) => {
  console.error("自测异常:", err);
  process.exit(1);
});
