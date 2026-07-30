/**
 * lint-font-config.ts
 *
 * 检查 font/font-config.json 中每个字体的 previewText 是否都被该字体实际包含。
 * 如果 previewText 中有字体不支持的字符，输出警告并标记失败。
 *
 * 用法：pnpm tsx scripts/lint-font-config.ts
 *
 * 修改 font-config.json 的 previewText 字段后应运行此脚本验证。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { extractCodePoints } from "../backend/font_util/font_meta.ts";

interface FontUserConfig {
  displayName?: string;
  previewText?: string;
}

type FontConfig = Record<string, FontUserConfig>;

const FONT_DIR = "font";
const CONFIG_PATH = "font/font-config.json";

async function main() {
  /** 读取配置 */
  const configRaw = await readFile(CONFIG_PATH, "utf-8");
  const config = JSON.parse(configRaw) as FontConfig;

  /** 扫描字体目录，建立 文件名→路径 映射 */
  const fontFiles = await readdir(FONT_DIR);
  const fontPathMap = new Map<string, string>();
  for (const f of fontFiles) {
    if (/\.(ttf|otf|TTF|OTF)$/i.test(f)) {
      fontPathMap.set(f, join(FONT_DIR, f));
    }
  }

  let hasError = false;

  for (const [fileName, cfg] of Object.entries(config)) {
    const previewText = cfg.previewText;
    if (!previewText) {
      /** 没配 previewText，跳过（用默认值，无法检查） */
      continue;
    }

    const fontPath = fontPathMap.get(fileName);
    if (!fontPath) {
      console.warn(`⚠️  [${fileName}] 字体文件不存在，跳过`);
      continue;
    }

    /** 读取字体并提取 codepoints */
    const raw = await readFile(fontPath);
    const fontBuffer = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    );
    const supportedCps = extractCodePoints(fontBuffer);

    /** 逐字符检查 previewText */
    const chars = [...previewText];
    /** 空格/换行等空白字符不检查（字体通常都有，但即使没有也不影响预览） */
    const missing: string[] = [];
    for (const ch of chars) {
      if (/\s/.test(ch)) continue;
      const cp = ch.codePointAt(0)!;
      if (!supportedCps.has(cp)) {
        missing.push(ch);
      }
    }

    const displayName = cfg.displayName ?? fileName;
    if (missing.length > 0) {
      hasError = true;
      console.error(
        `❌ [${displayName}] (${fileName}) previewText 含 ${missing.length} 个不支持的字符：${missing.join(" ")}`,
      );
      console.error(`   previewText: "${previewText}"`);
    } else {
      console.log(`✅ [${displayName}] (${fileName}) previewText 检查通过`);
    }
  }

  if (hasError) {
    console.error("\n💔 存在不支持的字符，请修正 previewText");
    process.exit(1);
  } else {
    console.log("\n🎉 所有 previewText 检查通过");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
