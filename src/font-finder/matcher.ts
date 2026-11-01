/**
 * 候选字体比对引擎 —— 渲染侧
 *
 * 对每个候选字体：经后端 subset API 拿到只含目标字符的最小 woff2（服务端有缓存，
 * 同字符组合只裁一次）→ FontFace 加载 → canvas 渲染每个字 → 与截图切出的字形
 * 归一化后逐一 SSIM，取平均分。
 *
 * 竞态安全：每个字体用独立 family 名（`ff-match-<序号>-<随机>`），
 * 比对完立即 delete() 释放，不污染全局字体空间。
 */
import { calculateSSIM } from "./ssim";
import {
  imageToMask,
  maskToNormalizedRGBA,
  rgbaToDataURL,
  smartSegment,
  deskewMask,
  type Mask,
} from "./segmenter";

/** 单个候选字形的比对结果 */
export interface GlyphMatch {
  /** 识别用的字符 */
  char: string;
  /** 截图字形归一化预览（DataURL） */
  queryPreview: string;
  /** 候选字体渲染字形归一化预览（DataURL） */
  candidatePreview: string;
  /** 该字的 SSIM 得分 0~1 */
  score: number;
}

/** 单个字体的比对结果 */
export interface FontMatchResult {
  /** 字体文件名（后端 font 名） */
  font: string;
  /** 所有字形平均 SSIM 得分 */
  score: number;
  /** 逐字明细 */
  glyphs: GlyphMatch[];
  /** 该字体缺字（subset 后渲染不出目标字符） */
  missing: boolean;
  /** 比对耗时 ms */
  elapsed: number;
}

/**
 * 渲染缓冲 canvas 尺寸 —— 远大于归一化网格，保证小笔画细节在降采样前已充分光栅化
 */
const RENDER_SIZE = 128;

/** 共享渲染 canvas（同步使用，无并发问题） */
let renderCanvas: HTMLCanvasElement | null = null;

/**
 * 用指定 family 渲染单个字符，返回紧致掩码
 * 用 alpha 通道做掩码（不依赖填色），字墨即前景
 */
function renderCharMask(char: string, family: string, fontSize: number): Mask | null {
  if (!renderCanvas) renderCanvas = document.createElement("canvas");
  const canvas = renderCanvas;
  canvas.width = RENDER_SIZE;
  canvas.height = RENDER_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, RENDER_SIZE, RENDER_SIZE);
  ctx.font = `${fontSize}px ${family}, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = "#000";
  ctx.fillText(char, RENDER_SIZE / 2, RENDER_SIZE / 2);

  const image = ctx.getImageData(0, 0, RENDER_SIZE, RENDER_SIZE);
  const { width: w, height: h, data } = image;
  /** alpha > 32 视为笔画 */
  const mask = new Uint8Array(w * h);
  let area = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3]! > 32) {
      mask[i] = 1;
      area++;
    }
  }
  if (area < 4) return null;
  return { data: mask, w, h };
}

/**
 * 从完整掩码中紧致裁剪出笔画包围盒子掩码
 *（渲染的 mask 四周有大量空白，与截图切分产物的紧致形态对齐）
 */
function tightCrop(mask: Mask): Mask {
  const { data, w, h } = mask;
  let left = w, right = -1, top = h, bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x]) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return mask;
  const cw = right - left + 1;
  const ch = bottom - top + 1;
  const crop = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      crop[y * cw + x] = data[(y + top) * w + (x + left)]!;
    }
  }
  return { data: crop, w: cw, h: ch };
}

/**
 * 加载候选字体子集 —— 走后端 subset API（GET /api?font=&text=&outType=woff2）
 * 只请求目标字符，传输量极小且命中服务端 subset 缓存
 */
async function loadSubsetFontFace(font: string, text: string): Promise<FontFace> {
  const url = `/api?font=${encodeURIComponent(font)}&text=${encodeURIComponent(text)}&outType=woff2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`subset failed: ${font} HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const family = `ff-match-${font.replace(/[^a-z0-9]/gi, "")}-${Math.random().toString(36).slice(2, 8)}`;
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  (face as FontFace & { _family?: string })._family = family;
  return face;
}

/** 一次裁剪指定字体所需字符，并用浏览器生成各字符的归一化预览 */
export async function renderSubsetGlyphPreviews(font: string, chars: string[]): Promise<Map<string, string>> {
  const face = await loadSubsetFontFace(font, [...new Set(chars)].join(""));
  const previews = new Map<string, string>();
  try {
    for (const char of new Set(chars)) {
      const rawMask = renderCharMask(char, face.family, 96);
      if (rawMask) {
        previews.set(char, rgbaToDataURL(maskToNormalizedRGBA(tightCrop(rawMask))));
      }
    }
  } finally {
    document.fonts.delete(face);
  }
  return previews;
}

/**
 * 对单个候选字体执行比对
 *
 * @param font 字体文件名
 * @param text 用户确认的选区文字（与 queryMasks 一一对应）
 * @param queryMasks 截图切分出的归一化 RGBA 字形序列
 */
export async function matchFont(
  font: string,
  text: string,
  queryMasks: Uint8Array[],
  previews: string[],
): Promise<FontMatchResult> {
  const t0 = performance.now();
  const glyphs: GlyphMatch[] = [];
  let missing = false;
  let face: FontFace | null = null;
  try {
    face = await loadSubsetFontFace(font, text);
    const family = (face as FontFace & { _family?: string })._family!;
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      const rawMask = renderCharMask(char, family, 96);
      if (!rawMask) {
        missing = true;
        continue;
      }
      const candidateRGBA = maskToNormalizedRGBA(tightCrop(rawMask));
      const score = calculateSSIM(queryMasks[i]!, candidateRGBA, 64, 64);
      glyphs.push({
        char,
        queryPreview: previews[i]!,
        candidatePreview: rgbaToDataURL(candidateRGBA),
        score,
      });
    }
    const score = glyphs.length ? glyphs.reduce((s, g) => s + g.score, 0) / glyphs.length : 0;
    return { font, score, glyphs, missing, elapsed: performance.now() - t0 };
  } finally {
    if (face) document.fonts.delete(face);
  }
}

/** 截图 ImageData → 归一化 RGBA 序列 + 预览
 * 管线：自适应二值化 → 去噪 → 倾角校正 → 切分 → 归一化
 * 已知字数时按方块字等分切分（字间粘连也能切开）；未知时用投影切分
 */
export function prepareQueryGlyphs(image: ImageData, count?: number): { masks: Uint8Array[]; previews: string[] } {
  const raw = imageToMask(image);
  const mask = deskewMask(raw);
  const segments = smartSegment(mask, count);
  const masks = segments.map((s) => maskToNormalizedRGBA(s));
  const previews = masks.map((m) => rgbaToDataURL(m));
  return { masks, previews };
}
