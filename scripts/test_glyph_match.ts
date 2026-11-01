/**
 * 截图找字体 —— 服务端比对自测（无需浏览器，直接测核心算法）
 *
 * 自测方法（self-consistent 验证）：
 *  1. 走共享裁剪入口 subsetFontFile 裁出「思源黑体」的目标字小字体
 *  2. getGlyphBitmap 渲染出 64x64 归一化位图，当作「用户截图切分后的查询输入」
 *  3. 全库每个字体同样只裁一次，跑 glyphSimilarity 比对，
 *     思源黑体必须排第一（自渲自比，满分 1.0）
 *
 * 与线上 /api/glyph-match 走同一裁剪管线，无完整字体对象缓存。
 */
import "../backend/server/node";
import { Font } from "../vendor/fonteditor-core/lib/ttf/font";
import { getGlyphBitmap, glyphSimilarity, hasGlyph, type SubsetTtfObject } from "../backend/font_util/glyph_bitmap";
import { findFontPath } from "../backend/shared";
import { readdir } from "../backend/interface";
import { fontDirs } from "../backend/config";
import { subsetFontFile } from "../backend/font_util/subset_file";

const TARGET_FONT = "思源黑体.ttf";
const TEXT = "天地玄黄";
/** 覆盖「借」的内部封闭留白回归 */
const HOLLOW_TEXT = "借";

/** 统计不与位图边缘连通的白色像素，用于验证字形内部镂空仍然存在 */
function countEnclosedWhitePixels(bitmap: Uint8Array): number {
  const visited = new Uint8Array(bitmap.length);
  let enclosedTotal = 0;
  for (let start = 0; start < bitmap.length; start++) {
    if (bitmap[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let size = 0;
    let enclosed = true;
    while (stack.length) {
      const index = stack.pop()!;
      const x = index % 64;
      const y = Math.floor(index / 64);
      size++;
      if (x === 0 || y === 0 || x === 63 || y === 63) enclosed = false;
      const neighbors = [index - 1, index + 1, index - 64, index + 64];
      for (const next of neighbors) {
        if (next < 0 || next >= bitmap.length || bitmap[next] || visited[next]) continue;
        if ((x === 0 && next === index - 1) || (x === 63 && next === index + 1)) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (enclosed) enclosedTotal += size;
  }
  return enclosedTotal;
}

/**
 * 裁剪并返回内存子集 ttf 对象（与 glyph_match.ts 相同口径）。
 * 内存对象中 glyf 已是子集但 cmap 仍是原始 gid，按字形 unicode 重建映射。
 */
async function loadSubsetObject(fontName: string, text: string): Promise<SubsetTtfObject | null> {
  const fontPath = await findFontPath(fontName);
  if (!fontPath) return null;
  const subset = await subsetFontFile(fontPath, text, "ttf");
  const ttf = subset.ttf;
  if (!ttf) return null;
  const glyf = ttf.glyf as Array<{ unicode?: number | number[] }>;
  const cmap: Record<number, number> = {};
  for (const [index, glyph] of glyf.entries()) {
    if (!glyph.unicode) continue;
    for (const cp of Array.isArray(glyph.unicode) ? glyph.unicode : [glyph.unicode]) {
      if (!(cp in cmap)) cmap[cp] = index;
    }
  }
  return { ...ttf, cmap } as unknown as SubsetTtfObject;
}

async function main() {
  console.log("=== 服务端字形比对自测 ===");

  /** 1. 裁剪目标字体并渲染查询位图（模拟截图切分输入） */
  const ttf = await loadSubsetObject(TARGET_FONT, TEXT + HOLLOW_TEXT);
  if (!ttf) throw new Error(`无法加载目标字体 ${TARGET_FONT}`);

  /** 「借」的「日」有两个封闭留白，不能因轮廓填充错误变成实心 */
  const jieBitmap = getGlyphBitmap(ttf, "借".codePointAt(0)!);
  const enclosed = jieBitmap ? countEnclosedWhitePixels(jieBitmap) : 0;
  console.log(`  借: 封闭留白像素=${enclosed}`);
  if (enclosed < 8) throw new Error(`${TARGET_FONT} 的「借」内部留白丢失`);

  const queryBitmaps: Uint8Array[] = [];
  for (const ch of TEXT) {
    const cp = ch.codePointAt(0)!;
    if (!hasGlyph(ttf, cp)) throw new Error(`${TARGET_FONT} 缺 ${ch}`);
    const bm = getGlyphBitmap(ttf, cp);
    if (!bm) throw new Error(`${TARGET_FONT} 渲染 ${ch} 失败（返回空位图）`);
    const ink = bm.reduce((a, b) => a + b, 0);
    console.log(`  ${ch} (U+${cp.toString(16)}): 位图墨点数=${ink}`);
    if (ink < 20) throw new Error(`${ch} 位图墨点过少，光栅化可能有问题`);
    queryBitmaps.push(bm);
  }
  console.log(`✓ 目标字体 ${TARGET_FONT} 的「${TEXT}」渲染成功\n`);

  /** 2. 遍历全库字体，每个只裁一次，用同样的字做 glyphSimilarity 比对 */
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
    /** 单个字体裁剪/解析失败不中断全库比对（如缺字导致空 glyf 的小字体） */
    const f = await loadSubsetObject(font, TEXT).catch(() => null);
    if (!f) {
      console.log(`  ${font}: 解析失败，跳过`);
      continue;
    }
    const perChar: number[] = [];
    let sum = 0;
    let missing = false;
    let index = 0;
    for (const ch of TEXT) {
      const cp = ch.codePointAt(0)!;
      if (!hasGlyph(f, cp)) {
        missing = true;
        index++;
        continue;
      }
      const cand = getGlyphBitmap(f, cp);
      if (!cand) {
        missing = true;
        index++;
        continue;
      }
      const s = glyphSimilarity(queryBitmaps[index]!, cand);
      perChar.push(s);
      sum += s;
      index++;
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
