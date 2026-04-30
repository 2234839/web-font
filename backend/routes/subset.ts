import { fontSubset } from "../font_util/font";
import type { FontEditor } from "../../vendor/fonteditor-core/lib/ttf/font.js";
import { parseUrl, jsonResponse, stats, subsetCache, findFontPath, readFontBuffer } from "../shared";

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
  const cacheKey = `${fontPath}:${outType}:${text}`;
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
