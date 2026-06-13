import { fontSubset } from "../font_util/font";
import type { FontEditor } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import { parseUrl, jsonResponse, stats, subsetCache, findFontPath, readFontBuffer } from "../shared";

/**
 * 子集化版本指纹
 *
 * 纳入 subsetCache 的 key，让旧缓存条目在以下两种场景自动失效，无需手动清缓存：
 *  - 生产：发版 bump package.json 的 version（构建期由 tsdown define 注入），旧缓存自然过期
 *  - 开发：pnpm dev 重启进程时 process.uptime() 变化，内存缓存整体重置
 *
 * 杜绝「子集化代码已修但缓存返回旧错误结果」的陷阱。
 *
 * 注意：不用 createRequire(import.meta.url) 读 package.json —— 该写法经 tsdown 打包为 CJS 后
 * 会引入 __filename，而 LLRT 运行时不提供 __filename，导致 ReferenceError。
 */
declare const PACKAGE_VERSION: string;
const SUBSET_CACHE_KEY = `${PACKAGE_VERSION}:${process.uptime()}`;

/** GET /api?font=...&text=... — 字体裁剪 */
export async function handleFontSubset(req: Request, res: Response) {
  const url = parseUrl(req);
  const params = new URLSearchParams(url.search);
  const font = params.get("font") || "";
  const text = params.get("text") || "";
  if (text.length === 0) {
    return { req, res };
  }

  const fontPath = await findFontPath(font);
  if (!fontPath) {
    return {
      req,
      res: new Response(`Font not found: ${font}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  /** 默认 ttf（兼容性最好） */
  const outTypeParam = params.get("outType") || "";
  const outType = (outTypeParam === "woff2" || outTypeParam === "ttf") ? outTypeParam : "ttf";

  /** 查询裁剪结果缓存 */
  /** 版本指纹纳入 key：代码变更后旧缓存自动失效 */
  const cacheKey = `${SUBSET_CACHE_KEY}:${fontPath}:${outType}:${text}`;
  stats.subsetRequests++;
  stats.totalChars += text.length;
  const cached = subsetCache.get(cacheKey);
  if (cached) {
    stats.subsetCacheHits++;
    const contentTypes: Record<string, string> = { ttf: "font/ttf", woff2: "font/woff2" };
    return {
      req,
      res: new Response(cached, {
        status: 200,
        headers: {
          "Content-Type": contentTypes[outType] || "font/ttf",
          "Cache-Control": "public, max-age=86400",
          "X-Cache": "HIT",
        },
      }),
    };
  }

  const fontType = fontPath.split(".").pop() as FontEditor.FontType;
  let oldFontBuffer: ArrayBuffer;
  try {
    oldFontBuffer = await readFontBuffer(fontPath);
  } catch {
    return {
      req,
      res: new Response(`Font read error: ${font}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  const newFont = await fontSubset(oldFontBuffer, text, {
    outType: outType,
    sourceType: fontType,
  });

  /** 写入裁剪结果缓存 */
  subsetCache.set(cacheKey, newFont as ArrayBuffer);

  const contentTypes: Record<string, string> = { ttf: "font/ttf", woff2: "font/woff2" };

  return {
    req,
    res: new Response(newFont, {
      status: 200,
      headers: {
        "Content-Type": contentTypes[outType] || "font/ttf",
        "Cache-Control": "public, max-age=86400",
        "X-Cache": "MISS",
      },
    }),
  };
}
