/**
 * 候选字体比对引擎 —— 渲染侧
 *
 * 服务端在 /api/glyph-match 流式比对时逐字体裁剪一次，并把 woff2 随事件下发；
 * 本模块用该 woff2 加载 FontFace → canvas 渲染每个字 → 生成归一化预览。
 * 不再发起第二轮裁剪请求。
 */
import {
  imageToMask,
  maskToNormalizedRGBA,
  rgbaToDataURL,
  smartSegment,
  deskewMask,
  type Mask,
} from "./segmenter";

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

/** base64 → Uint8Array（流事件中的 woff2 载荷） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 用 woff2 字节加载临时 FontFace（独立 family，用完即删）
 * 字节来自流式接口的同一份裁剪结果，不再发第二轮裁剪请求
 */
async function loadFontFaceFromBytes(bytes: Uint8Array): Promise<FontFace> {
  /** 拷贝出独立 ArrayBuffer，避免复用底层缓冲破后续读取 */
  const buf = bytes.slice().buffer as ArrayBuffer;
  const family = `ff-match-${Math.random().toString(36).slice(2, 10)}`;
  const face = new FontFace(family, buf);
  await face.load();
  document.fonts.add(face);
  return face;
}

/**
 * 用流事件携带的 woff2 生成各字符的归一化预览
 * 每个字体只裁剪一次，预览复用同一份裁剪结果
 */
export async function renderSubsetGlyphPreviews(woff2: Uint8Array, chars: string[]): Promise<Map<string, string>> {
  const previews = new Map<string, string>();
  if (!chars.length) return previews;
  const face = await loadFontFaceFromBytes(woff2);
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
