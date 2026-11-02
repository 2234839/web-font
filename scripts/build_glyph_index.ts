/**
 * 全量预建字形索引：遍历字体目录，逐字体构建 .gidx（走内存闸门，一次一个）。
 * 用法：pnpm exec tsx scripts/build_glyph_index.ts
 */
import "../backend/server/node";
import { readdir } from "../backend/interface";
import { fontDirs } from "../backend/config";
import { buildGlyphIndex } from "../backend/font_util/glyph_index";

async function main() {
  const started = Date.now();
  let built = 0;
  let failed = 0;
  for (const dir of fontDirs) {
    let entries: { name: string; isFile: () => boolean }[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ttf|otf)$/i.test(entry.name)) continue;
      const fontPath = `${dir}/${entry.name}`;
      try {
        const ok = await buildGlyphIndex(fontPath);
        if (ok) {
          built++;
          console.log(`[${built}] ${entry.name} ✓`);
        } else {
          failed++;
          console.log(`[skip] ${entry.name} 无有效字形`);
        }
      } catch (err) {
        failed++;
        console.error(`[fail] ${entry.name}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  console.log(`完成：构建 ${built}，失败 ${failed}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();
