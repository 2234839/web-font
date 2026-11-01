/**
 * POST /api/glyph-match —— 截图找字体：一次请求对全库字体做字形相似度比对
 *
 * 请求体：{ glyphs: [{ char: string, bitmap: string }] }
 *   bitmap 为 4096 字符的 01 串（64x64 归一化二值位图，前端 segmenter 产线）
 * 响应：{ results: [{ font, score, missing, glyphs: [{ char, score, bitmap, queryIndex }] }] }
 *   按平均分降序；bitmap 为该字体渲染的归一化位图（01 串，前端画预览小图）
 *   queryIndex 对应该字在请求 glyphs 中的位置，候选字体缺字时仍能保持预览对应关系
 *
 * 性能：字形位图按 字体×字符 进程内缓存（首次请求某字时惰性光栅化），
 * 之后每次比对只计算归一化位图相似度。
 */
import { jsonResponse, findFontPath, readFontBuffer } from "../shared";
import { readdir } from "../interface";
import { fontDirs } from "../config";
import { loadFontObject, getGlyphBitmap, glyphSimilarity } from "../font_util/glyph_bitmap";

/** 单个查询字形 */
interface QueryGlyph {
  char: string;
  bitmap: string;
}

/** 响应中的单字形结果 */
interface GlyphResult {
  char: string;
  score: number;
  bitmap: string;
  queryIndex: number;
}

/** 响应中的单字体结果 */
interface FontResult {
  font: string;
  score: number;
  missing: boolean;
  glyphs: GlyphResult[];
}

/** 01 串 → Uint8Array；非法输入返回 null */
function parseBitmap(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length !== 64 * 64) return null;
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 48 && c !== 49) return null;
    out[i] = c - 48;
  }
  return out;
}

/** Uint8Array 位图 → 01 串 */
function encodeBitmap(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i] ? "1" : "0";
  return s;
}

/** 遍历字体目录收集候选字体文件名（含临时上传） */
async function listCandidateFonts(): Promise<string[]> {
  const names: string[] = [];
  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(entry.name)) {
          names.push(entry.name);
        }
      }
    } catch {}
  }
  return names;
}

export async function handleGlyphMatch(req: Request, _res: Response) {
  let body: { glyphs?: QueryGlyph[] };
  try {
    /** 项目 HTTP 服务把请求体放在 _bodyBuffer，不能直接调用 Request.json() */
    const buf = (req as Request & { _bodyBuffer?: ArrayBuffer })._bodyBuffer;
    if (!buf || buf.byteLength === 0) {
      return { req, res: jsonResponse({ error: "request body required" }, 400) };
    }
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return { req, res: jsonResponse({ error: "invalid json" }, 400) };
  }
  const queryGlyphs = (body.glyphs ?? [])
    .map((g, queryIndex) => ({
      char: typeof g?.char === "string" ? g.char : "",
      bitmap: parseBitmap(g?.bitmap),
      queryIndex,
    }))
    .filter((g): g is { char: string; bitmap: Uint8Array; queryIndex: number } =>
      g.char.length > 0 && g.bitmap !== null,
    );

  if (queryGlyphs.length === 0) {
    return { req, res: jsonResponse({ error: "glyphs required (char + 64x64 bitmap)" }, 400) };
  }

  const fonts = await listCandidateFonts();
  const results: FontResult[] = [];

  for (const font of fonts) {
    const fontPath = await findFontPath(font);
    if (!fontPath) continue;
    const ttf = await loadFontObject(font, async (name) => {
      const p = await findFontPath(name);
      if (!p) return null;
      return readFontBuffer(p);
    });
    if (!ttf) continue;

    const glyphResults: GlyphResult[] = [];
    let missing = false;
    let scoreSum = 0;
    for (const q of queryGlyphs) {
      const cp = q.char.codePointAt(0)!;
      const candidate = getGlyphBitmap(ttf, font, cp);
      if (!candidate) {
        missing = true;
        continue;
      }
      const score = glyphSimilarity(q.bitmap, candidate);
      scoreSum += score;
      glyphResults.push({ char: q.char, score, bitmap: encodeBitmap(candidate), queryIndex: q.queryIndex });
    }
    if (glyphResults.length === 0) continue;
    results.push({
      font,
      score: scoreSum / glyphResults.length,
      missing,
      glyphs: glyphResults,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return { req, res: jsonResponse({ results }) };
}
