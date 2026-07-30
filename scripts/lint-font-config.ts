/**
 * lint-font-config.ts
 *
 * 检查 font/font-config.json 中每个字体的文本字段（previewText / charsetPreview）
 * 是否都被该字体实际包含。如果有不支持的字符，输出警告并标记失败。
 *
 * 用法：pnpm lint:font-config
 *
 * 修改 font-config.json 中任何文本字段后应运行此脚本验证。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { extractCodePoints } from "../backend/font_util/font_meta.ts";

interface FontUserConfig {
  displayName?: string;
  previewText?: string;
  charsetPreview?: string;
}

/** 需要检查的文本字段及显示名 */
const TEXT_FIELDS: Array<{ key: keyof FontUserConfig; label: string }> = [
  { key: "previewText", label: "previewText" },
  { key: "charsetPreview", label: "charsetPreview" },
];

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

  /** 字体 codepoints 缓存（同一字体只解析一次） */
  const cpCache = new Map<string, Set<number>>();

  let hasError = false;

  /** 检查 font/ 目录下所有字体是否都在 config 中有配置 */
  for (const fontFile of fontPathMap.keys()) {
    if (!config[fontFile]) {
      console.error(`❌ [${fontFile}] 字体文件存在但 font-config.json 中没有配置`);
      hasError = true;
    }
  }

  for (const [fileName, cfg] of Object.entries(config)) {
    const fontPath = fontPathMap.get(fileName);
    if (!fontPath) {
      console.warn(`⚠️  [${fileName}] 字体文件不存在，跳过`);
      continue;
    }

    /** 检查必填字段是否都配置了 */
    const missingFields = TEXT_FIELDS.filter(({ key }) => !cfg[key]);
    if (missingFields.length > 0) {
      const displayName = cfg.displayName ?? fileName;
      hasError = true;
      console.error(
        `❌ [${displayName}] 缺少字段：${missingFields.map((f) => f.label).join(", ")}`,
      );
      continue;
    }

    /** 读取字体 codepoints（有缓存则复用） */
    let supportedCps = cpCache.get(fileName);
    if (!supportedCps) {
      const raw = await readFile(fontPath);
      const fontBuffer = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      );
      supportedCps = extractCodePoints(fontBuffer);
      cpCache.set(fileName, supportedCps);
    }

    const displayName = cfg.displayName ?? fileName;
    let fontHasError = false;

    /** 逐字段检查 */
    for (const { key, label } of TEXT_FIELDS) {
      const text = cfg[key];
      if (!text) continue;

      const chars = [...text];
      const missing: string[] = [];
      for (const ch of chars) {
        /** 空白字符不检查 */
        if (/\s/.test(ch)) continue;
        const cp = ch.codePointAt(0)!;
        if (!supportedCps!.has(cp)) {
          missing.push(ch);
        }
      }

      if (missing.length > 0) {
        fontHasError = true;
        hasError = true;
        console.error(
          `❌ [${displayName}] ${label} 含 ${missing.length} 个不支持的字符：${missing.join(" ")}`,
        );
        console.error(`   ${label}: "${text}"`);
      }
    }

    if (!fontHasError) {
      console.log(`✅ [${displayName}] (${fileName}) 所有文本字段检查通过`);
    }
  }

  if (hasError) {
    console.error("\n💔 存在不支持的字符，请修正相关文本字段");
    process.exit(1);
  } else {
    console.log("\n🎉 所有文本字段检查通过");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
