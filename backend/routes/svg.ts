import { parseUrl, stats, subsetCache, findFontPath, markStatsDirty } from "../shared";
import { markFontUsed } from "../temp_cleaner";
import { withMemoryGate } from "../subset_queue";
import { estimateSubsetMemory, subsetFontFile } from "../font_util/subset_file";
import { SUBSET_CACHE_KEY } from "./subset";
import { readGlyphContoursNormalized } from "../font_util/glyph_bitmap";
import { subsetQueueTimeoutSeconds } from "../config";

/**
 * GET /api/svg?font=...&text=...&size=64&color=333333
 *
 * 把文字转成「字形矢量轮廓」的 SVG（文字不是 <text>，而是 <path>）。
 * 用途：README / 网页中 <img> 直接展示字体效果——SVG 作为图片加载时无法引用
 * 外部 @font-face（GitHub camo 代理与浏览器安全策略双重限制），矢量路径是唯一
 * 可在任意上下文渲染的形态，且体积只有几 KB。
 *
 * 实现复用裁剪管线：先按 text 裁出小子集，再从内存 ttf 对象读取每个字形的
 * 二次贝塞尔轮廓（subset 模式下 compound 已展开为 simple），拼接为 SVG path。
 * OTF（CFF）源字体裁剪管线返回内存对象为 null，返回 422 提示不支持。
 */

/** 二次贝塞尔轮廓点（TrueType 字形坐标，y 向上） */
type GlyphPoint = { x: number; y: number; onCurve: boolean };

/** 单条轮廓转 SVG path 片段（M/L/Q/Z，含 TrueType 隐含中点 on-curve 语义） */
function contourToPath(contour: GlyphPoint[], parts: string[]): void {
  if (contour.length < 2) return;
  const mid = (a: GlyphPoint, b: GlyphPoint): GlyphPoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    onCurve: true,
  });
  const n = contour.length;
  /** 找 on-curve 起点；全 off-curve（极罕见）用首尾中点作隐含起点 */
  let startIdx = contour.findIndex((p) => p.onCurve);
  let start: GlyphPoint;
  if (startIdx === -1) {
    start = mid(contour[n - 1]!, contour[0]!);
    startIdx = 0;
  } else {
    start = contour[startIdx]!;
  }
  parts.push(`M ${start.x} ${start.y}`);
  /** 上一段终点的 on-curve 点（作为潜在 Q 的起点） */
  let prev = start;
  /** 悬挂中的 off-curve 控制点（连续 off-curve 时逐段消耗） */
  let ctrl: GlyphPoint | null = null;
  for (let k = 1; k <= n; k++) {
    const p = contour[(startIdx + k) % n]!;
    if (p.onCurve) {
      if (ctrl) {
        parts.push(`Q ${ctrl.x} ${ctrl.y} ${p.x} ${p.y}`);
        ctrl = null;
      } else {
        parts.push(`L ${p.x} ${p.y}`);
      }
      prev = p;
    } else {
      if (ctrl) {
        /** 连续 off-curve：前控制点与本控制点的中点是隐含 on-curve 终点 */
        const implied = mid(ctrl, p);
        parts.push(`Q ${ctrl.x} ${ctrl.y} ${implied.x} ${implied.y}`);
        prev = implied;
      }
      ctrl = p;
    }
  }
  /** 收尾：悬挂控制点指回起点 */
  if (ctrl) parts.push(`Q ${ctrl.x} ${ctrl.y} ${start.x} ${start.y}`);
  parts.push("Z");
}

/** 参数安全化：颜色仅允许 3/6 位十六进制，防 SVG 注入 */
function sanitizeColor(input: string | null): string {
  const v = (input ?? "").replace(/[^0-9a-fA-F]/g, "");
  return /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(v) ? v : "333333";
}

/** GET /api/svg — 文字 → 字形矢量路径 SVG */
export async function handleFontSvg(req: Request, res: Response) {
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

  /** 输出像素字号（决定 viewBox 缩放）与填充色 */
  const size = Math.min(Math.max(Number(params.get("size")) || 64, 12), 400);
  const color = sanitizeColor(params.get("color"));

  markFontUsed(fontPath);
  stats.totalRequests++;
  stats.subsetRequests++;
  stats.totalChars += text.length;
  markStatsDirty();

  /** 与裁剪接口同一缓存命名空间：SVG 输出确定性，可长缓存 */
  const cacheKey = `${SUBSET_CACHE_KEY}:svg:${fontPath}:${size}:${color}:${text}`;
  const cached = subsetCache.get(cacheKey);
  if (cached) {
    stats.subsetCacheHits++;
    markStatsDirty();
    return {
      req,
      res: new Response(cached.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
          "X-Cache": "HIT",
        },
      }),
    };
  }

  const memoryBytes = await estimateSubsetMemory(fontPath);
  const subsetResult = await withMemoryGate(
    () => subsetFontFile(fontPath, text, "ttf"),
    subsetQueueTimeoutSeconds * 1000,
    memoryBytes,
  );
  if (subsetResult === null) {
    return {
      req,
      res: new Response("Server busy, please retry", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" },
      }),
    };
  }
  const ttf = subsetResult.ttf as {
    head: { unitsPerEm: number };
    glyf: Array<{ unicode?: number | number[]; advanceWidth?: number; contours?: unknown; compound?: unknown }>;
  } | null;
  if (!ttf) {
    return {
      req,
      res: new Response("SVG output is not supported for this font (CFF/OTF outline)", {
        status: 422,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  const upem = ttf.head.unitsPerEm || 1000;
  /** 子集 glyf 自带 unicode 标注 → codepoint → 新 gid 映射（与 glyph-match 同法） */
  const cmap: Record<number, number> = {};
  for (const [index, glyph] of ttf.glyf.entries()) {
    if (!glyph.unicode) continue;
    for (const cp of Array.isArray(glyph.unicode) ? glyph.unicode : [glyph.unicode]) {
      if (!(cp in cmap)) cmap[cp] = index;
    }
  }

  /** 逐字符取轮廓拼 path；缺字跳过（与 .notdef 等价的降级是空占位） */
  const paths: Array<{ d: string; dx: number }> = [];
  const codePoints: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++;
    codePoints.push(cp);
  }
  /** 水平布局游标（字体单位） */
  let penX = 0;
  for (const cp of codePoints) {
    const gid = cmap[cp];
    if (gid === undefined) {
      penX += upem / 2;
      continue;
    }
    const glyph = ttf.glyf[gid]!;
    const parts: string[] = [];
    for (const contour of readGlyphContoursNormalized(ttf, glyph)) contourToPath(contour, parts);
    if (parts.length > 0) paths.push({ d: parts.join(" "), dx: penX });
    penX += glyph.advanceWidth ?? upem;
  }

  /** 高度行框按字体单位 1.3 倍（含 ascender/descender 余量），y 翻转由 group transform 完成 */
  const ascent = upem * 1.05;
  const descent = upem * 0.25;
  const totalW = penX;
  const scale = size / upem;
  const svgW = Math.max(totalW * scale, 1).toFixed(2);
  const svgH = (size * (ascent + descent) / upem).toFixed(2);
  const body = paths
    .map((p) => `<path transform="translate(${p.dx} ${ascent}) scale(1 -1)" d="${p.d}"/>`)
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${ascent + descent}" ` +
    `width="${svgW}" height="${svgH}" fill="#${color}">${body}</svg>`;

  const svgBytes = new TextEncoder().encode(svg);
  subsetCache.set(cacheKey, { bytes: svgBytes, ttf: null });
  return {
    req,
    res: new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "X-Cache": "MISS",
      },
    }),
  };
}
