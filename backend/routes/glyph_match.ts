/**
 * POST /api/glyph-match —— 逐字体裁剪、逐字评分，并以 NDJSON 流式返回。
 *
 * 每个候选字体只经过一次现有裁剪管线；同一份 woff2 同时供前端预览。
 * 不缓存完整字体对象，也不为了生成预览再发起第二轮全库裁剪。
 */
import { Font } from "../../vendor/fonteditor-core/lib/ttf/font";
import { jsonResponse, findFontPath } from "../shared";
import { readdir } from "../interface";
import { fontDirs, subsetQueueTimeoutSeconds } from "../config";
import { getGlyphBitmap, glyphSimilarity, hasGlyph, type SubsetTtfObject } from "../font_util/glyph_bitmap";
import { estimateSubsetMemory, subsetFontFile } from "../font_util/subset_file";
import { withMemoryGate } from "../subset_queue";
/** 单个查询字形 */
interface QueryGlyph {
  char: string;
  bitmap: string;
}

interface ParsedQueryGlyph {
  char: string;
  bitmap: Uint8Array;
  queryIndex: number;
}

/** 流式响应事件 */
type GlyphMatchEvent =
  | { type: "start"; total: number }
  | { type: "font"; font: string; subset: string }
  | { type: "glyph"; font: string; glyph: { char: string; score: number; queryIndex: number } | null; missing: boolean }
  | { type: "fontDone"; font: string }
  | { type: "done" };

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

/** 小字体转 base64，随流交给浏览器渲染，无需再次请求裁剪接口 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** 解析裁剪产物；OTF（CFF）等无内存 ttf 对象的路径不参与字形评分 */
function readSubsetObject(bytes: Uint8Array): SubsetTtfObject {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return Font.create(buffer, { type: "ttf", hinting: false }).get();
}

/**
 * 裁剪管线的内存 ttf 对象中 glyf 已是子集但 cmap 仍是原始 gid 映射，
 * 按字形自带的 unicode 标注重建 codepoint→新 gid 映射。
 * 返回浅拷贝视图（glyf 共享引用），不修改原对象以免影响序列化。
 */
function buildSubsetCmapView(ttf: Record<string, unknown>): SubsetTtfObject {
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

/** 依次产出事件；每次只保留下一个候选字体的数据，浏览器背压会自然暂停后续裁剪 */
async function* streamMatches(
  fonts: string[],
  queryGlyphs: ParsedQueryGlyph[],
): AsyncGenerator<GlyphMatchEvent> {
  yield { type: "start", total: fonts.length };
  const text = queryGlyphs.map((glyph) => glyph.char).join("");

  for (const font of fonts) {
    try {
      const fontPath = await findFontPath(font);
      if (!fontPath) {
        yield { type: "fontDone", font };
        continue;
      }
      const memoryBytes = await estimateSubsetMemory(fontPath);
      const subset = await withMemoryGate(
        () => subsetFontFile(fontPath, text, "ttf"),
        subsetQueueTimeoutSeconds * 1000,
        memoryBytes,
      );
      if (!subset) throw new Error(`字体裁剪排队超时：${font}`);

      /** 优先用裁剪管线返回的内存 ttf 对象（重建子集 cmap），免去序列化再解析（部分字体 re-parse 会失败） */
      const ttf = subset.ttf ? buildSubsetCmapView(subset.ttf) : readSubsetObject(subset.bytes);
      let started = false;
      let hasMatch = false;
      for (const query of queryGlyphs) {
        const codePoint = query.char.codePointAt(0)!;
        if (!hasGlyph(ttf, codePoint)) {
          if (started) yield { type: "glyph", font, glyph: null, missing: true };
          continue;
        }
        if (!started) {
          started = true;
          yield { type: "font", font, subset: bytesToBase64(subset.bytes) };
        }
        const candidate = getGlyphBitmap(ttf, codePoint);
        if (!candidate) {
          yield { type: "glyph", font, glyph: null, missing: true };
          continue;
        }
        hasMatch = true;
        yield {
          type: "glyph",
          font,
          glyph: { char: query.char, score: glyphSimilarity(query.bitmap, candidate), queryIndex: query.queryIndex },
          missing: false,
        };
      }
      /** 全部缺字的候选不展示，但仍计入完成进度 */
      if (started && !hasMatch) yield { type: "glyph", font, glyph: null, missing: true };
    } catch (err) {
      /** 单个字体裁剪/解析失败不拖垮整个搜索流，记录后继续下一个 */
      console.error(`[glyph-match] ${font} 处理失败:`, err instanceof Error ? err.message : err);
    }
    yield { type: "fontDone", font };
  }
  yield { type: "done" };
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
    .map((glyph, queryIndex) => ({
      char: typeof glyph?.char === "string" ? glyph.char : "",
      bitmap: parseBitmap(glyph?.bitmap),
      queryIndex,
    }))
    .filter((glyph): glyph is ParsedQueryGlyph => glyph.char.length > 0 && glyph.bitmap !== null);

  if (queryGlyphs.length === 0) {
    return { req, res: jsonResponse({ error: "glyphs required (char + 64x64 bitmap)" }, 400) };
  }

  const fonts = await listCandidateFonts();
  const encoder = new TextEncoder();
  const events = streamMatches(fonts, queryGlyphs);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  /** LLRT 的 Response 不支持 ReadableStream body（body 会变 undefined），流挂在附加属性上由 HTTP 层写出 */
  const res = new Response(null, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "Connection": "close",
    },
  });
  (res as Response & { _stream?: ReadableStream<Uint8Array> })._stream = stream;
  return { req, res };
}
