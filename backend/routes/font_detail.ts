/**
 * 字体详情页 SSR —— 读取 SSG 模板 HTML，替换占位符后返回
 *
 * 流程：
 * 1. 从路由参数提取字体 slug
 * 2. 查询字体元数据（是否存在、是否临时等）
 * 3. 读取 dist/fonts/__FONT_NAME__/index.html 模板
 * 4. 替换所有占位符为实际值
 * 5. 返回完整 HTML
 */
import { readFile, stat } from "../interface";
import { path_join } from "../interface";
import { fontDirs } from "../config";
import { FONT_NAME, FONT_SLUG, type PlaceholderValues } from "../../src/placeholders";

const ROOT_DIR = "dist";

/** 模板缓存：避免每次请求都读文件 */
let templateCache: Uint8Array | null = null;

/** 读取 SSG 模板 HTML（带缓存） */
async function getTemplate(): Promise<Uint8Array> {
  if (templateCache) return templateCache;
  const templatePath = path_join(ROOT_DIR, "fonts", FONT_NAME, "index.html");
  templateCache = await readFile(templatePath);
  return templateCache;
}

/**
 * 查询字体是否存在及其元数据
 *
 * @returns 如果字体存在返回元数据，不存在返回 null
 */
async function getFontMeta(slug: string): Promise<{ exists: boolean; temporary: boolean } | null> {
  for (const dir of fontDirs) {
    try {
      const filePath = path_join(dir, slug);
      const s = await stat(filePath);
      if (s.isFile()) {
        return { exists: true, temporary: dir === "font/temp" };
      }
    } catch {}
  }
  return null;
}

/**
 * 处理 /fonts/:slug 请求 —— SSR 返回字体详情页 HTML
 *
 * @returns Response 或 null（模板不存在时返回 null，交给 fallback）
 */
export async function handleFontDetail(pathname: string): Promise<Response | null> {
  /** 提取 slug：/fonts/令东齐伋复刻体.ttf → 令东齐伋复刻体.ttf */
  const slug = decodeURIComponent(pathname.slice("/fonts/".length).replace(/\/$/, ""));

  /** 读取 SSG 模板 */
  let template: Uint8Array;
  try {
    template = await getTemplate();
  } catch {
    /** 模板不存在（SSG 未构建），交给 SPA fallback */
    return null;
  }

  /** 查询字体元数据 */
  const meta = await getFontMeta(slug);

  /** 占位符 → 实际值 */
  const values: PlaceholderValues = {
    [FONT_NAME]: slug,
    [FONT_SLUG]: slug,
  };

  /** 解码模板为字符串，替换所有占位符 */
  const decoder = new TextDecoder();
  let html = decoder.decode(template);

  for (const [placeholder, value] of Object.entries(values)) {
    html = html.replaceAll(placeholder, value);
  }

  /** 字体不存在时，在 body 开头注入 noindex 标签防止搜索引擎收录 */
  if (meta && !meta.exists) {
    html = html.replace("</head>", '<meta name="robots" content="noindex"></head>');
  }

  const encoder = new TextEncoder();
  const htmlBytes = encoder.encode(html);

  return new Response(htmlBytes, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": `${htmlBytes.byteLength}`,
    },
  });
}
