/**
 * 字体裁剪验证 — 裁剪多种字体并保存为文件
 * 运行: pnpm tsx scripts/test_font_valid.ts
 */
import { Font } from "../vendor/fonteditor-core/lib/ttf/font.js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const OUTPUT_DIR = "benchmark_results/font_test";
await mkdir(OUTPUT_DIR, { recursive: true });

/** 在所有字体目录中查找字体 */
import { stat } from "node:fs/promises";
const fontDirs = ["font/admin", "font", "font/temp"];
async function findFonts(): Promise<Array<{ name: string; path: string }>> {
  const all: Array<{ name: string; path: string }> = [];
  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const name = typeof entry === "string" ? entry : entry.name;
        if (/\.(ttf|otf|woff|woff2)$/i.test(name)) {
          const fullPath = `${dir}/${name}`;
          try {
            const s = await stat(fullPath);
            if (s.isFile()) {
              all.push({ name, path: fullPath });
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  return all;
}

const fonts = await findFonts();
const testText = "你好世界";
const codePoints = [...testText].map(c => c.codePointAt(0)!);

console.log("\n=== 字体裁剪验证 ===\n");
console.log(`测试文本: "${testText}"\n`);

for (const f of fonts) {
  try {
    const raw = await readFile(f.path);
    const buf = new Uint8Array(raw).buffer;

    const font = Font.create(buf, { type: "ttf", subset: codePoints });
    const optimized = font.optimize().sort();
    const result = optimized.write({ type: "ttf" });

    const data = typeof result === "string"
      ? new TextEncoder().encode(result)
      : new Uint8Array(result);

    const outPath = `${OUTPUT_DIR}/${f.name.replace(/\.[^.]+$/, "")}_subset.ttf`;
    await writeFile(outPath, data);

    /** 检查 TTF 文件头 */
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sfVersion = view.getUint32(0, false);
    const numTables = view.getUint16(4, false);

    console.log(`  ${f.name}: ${data.length.toLocaleString()} bytes, sfVersion=0x${sfVersion.toString(16)}, numTables=${numTables}`);
  } catch (e: any) {
    console.log(`  ${f.name}: ERROR - ${e.message}`);
  }
}

console.log(`\n输出目录: ${OUTPUT_DIR}/`);
console.log("请在 Windows 字体查看器中打开验证");
