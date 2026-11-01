/**
 * 服务端字形位图光栅化 + IoU 比对 —— 截图找字体的服务端比对核心
 *
 * 不依赖任何 canvas / DOM：直接取 fonteditor 解析出的 glyf 二次贝塞尔轮廓，
 * 扁平化为多边形后扫描线填充（奇偶规则），再紧致归一化到 64x64 二值网格。
 * 归一化算法与前端 segmenter 完全一致（留 12% 边距、等比缩放、居中、
 * 像素中心采样），保证两侧特征空间相同，位图可直接 IoU 比对。
 *
 * 缓存两层：字体对象（解析一次）+ 字形位图（字体×字符），进程内常驻。
 */
import { Font } from "../../vendor/fonteditor-core/lib/ttf/font";
import transformGlyfContours from "../../vendor/fonteditor-core/lib/ttf/util/transformGlyfContours";

/** 归一化网格边长（与前端 segmenter.GRID 一致） */
const GRID = 64;
/** 归一化留边比例（与前端一致：12%） */
const MARGIN_RATIO = 0.12;

/** 字体对象缓存：字体名 → 解析后的 ttfObject（含 glyf/cmap） */
const fontObjectCache = new Map<string, ReturnType<ReturnType<typeof Font.create>["get"]>>();
/** 字形位图缓存：字体名 → 码点 → 64x64 位图（01 串）；值为 null 表示该字体缺此字 */
const glyphBitmapCache = new Map<string, Map<number, Uint8Array | null>>();

/**
 * 按魔数探测字体类型（woff2 'wOF2' / woff 'wOFF' / otf 'OTTO' / 其余按 ttf）
 */
function detectType(buf: ArrayBuffer): "ttf" | "otf" | "woff" | "woff2" {
  const b = new Uint8Array(buf, 0, 4);
  if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32) return "woff2";
  if (b[0] === 0x77 && b[1] === 0x4f) return "woff";
  if (b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f) return "otf";
  return "ttf";
}

/**
 * 解析字体（带进程内缓存）
 * 传入读取字体文件的函数，避免本模块直接依赖 shared/interface 的 IO 层
 */
export function loadFontObject(
  fontName: string,
  readBuffer: (name: string) => Promise<ArrayBuffer | null>,
): Promise<ReturnType<ReturnType<typeof Font.create>["get"]> | null> {
  const hit = fontObjectCache.get(fontName);
  if (hit) return Promise.resolve(hit);
  return readBuffer(fontName).then((buf) => {
    if (!buf) return null;
    const ttf = Font.create(buf, { type: detectType(buf) }).get();
    fontObjectCache.set(fontName, ttf);
    return ttf;
  });
}

/** 二维点（已扁平化的多边形顶点，y 已翻转） */
interface Pt {
  x: number;
  y: number;
}

/** 字体轮廓点（TrueType 曲线标志） */
interface GlyphPoint extends Pt {
  onCurve: boolean;
}

/** fonteditor 可能返回对象点或 [x, y, onCurve] 三元组 */
type RawContour = Array<GlyphPoint | number>;

/** 读取一个字形的轮廓，兼容优化后的紧凑坐标与复合字形 */
function readGlyphContours(ttf: any, glyf: any): RawContour[] {
  if (!glyf) return [];
  if (glyf.compound) return transformGlyfContours(glyf, ttf);
  if (Array.isArray(glyf.contours) && Array.isArray(glyf.contours[0])) return glyf.contours;

  const xArr = glyf._xArr;
  const yArr = glyf._yArr;
  const flags = glyf._flags;
  const endPts = glyf.endPtsOfContours;
  if (!xArr || !yArr || !flags || !endPts) return [];

  const contours: RawContour[] = [];
  let start = 0;
  for (const end of endPts) {
    const contour: GlyphPoint[] = [];
    for (let i = start; i <= end; i++) {
      contour.push({ x: xArr[i], y: yArr[i], onCurve: (flags[i] & 1) !== 0 });
    }
    contours.push(contour);
    start = end + 1;
  }
  return contours;
}

/** 把对象点或扁平三元组统一成对象点 */
function normalizeContour(contour: RawContour): GlyphPoint[] {
  const points: GlyphPoint[] = [];
  for (let i = 0; i < contour.length;) {
    const value = contour[i]!;
    if (typeof value !== "number") {
      points.push(value);
      i++;
      continue;
    }
    const y = contour[i + 1];
    const onCurve = contour[i + 2];
    if (typeof y === "number" && typeof onCurve === "number") {
      points.push({ x: value, y, onCurve: onCurve !== 0 });
    }
    i += 3;
  }
  return points;
}

/**
 * 单条轮廓（含二次贝塞尔控制点）扁平化为多边形顶点序列
 * fonteditor 的轮廓点序列是 TrueType 规范：连续 off-curve 点之间隐含中点 on-curve。
 * y 轴翻转（字形坐标 y 向上，位图 y 向下）；二次曲线细分 4 段足够 64 网格精度。
 */
function flattenContour(rawContour: RawContour): Pt[] {
  const contour = normalizeContour(rawContour);
  if (contour.length < 2) return [];
  const MID_STEPS = 4;
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const quad = (p0: Pt, pc: Pt, p1: Pt, out: Pt[]) => {
    for (let i = 1; i <= MID_STEPS; i++) {
      const t = i / MID_STEPS;
      const mt = 1 - t;
      out.push({
        x: mt * mt * p0.x + 2 * mt * t * pc.x + t * t * p1.x,
        y: mt * mt * p0.y + 2 * mt * t * pc.y + t * t * p1.y,
      });
    }
  };

  /** 先把轮廓规整为 on-curve 起点 */
  const pts = contour.map((p) => ({ x: p.x, y: -p.y }));
  let startIdx = pts.findIndex((_, i) => contour[i]!.onCurve);
  /** 全 off-curve（极罕见）：首尾中点为隐含起点 */
  if (startIdx === -1) {
    const n = pts.length;
    const startPt = mid(pts[n - 1]!, pts[0]!);
    const poly: Pt[] = [startPt];
    for (let i = 0; i < n; i++) {
      const cur = pts[i]!;
      const next = pts[(i + 1) % n]!;
      if (contour[i]!.onCurve) {
        poly.push(cur);
      } else {
        const end = contour[(i + 1) % n]!.onCurve ? next : mid(cur, next);
        quad(poly[poly.length - 1]!, cur, end, poly);
      }
    }
    return poly;
  }

  /** 正常路径：从 on-curve 起点绕一圈 */
  const n = pts.length;
  const poly: Pt[] = [];
  let prevOn = pts[startIdx]!;
  poly.push(prevOn);
  for (let k = 1; k <= n; k++) {
    const i = (startIdx + k) % n;
    const cur = pts[i]!;
    if (contour[i]!.onCurve) {
      poly.push(cur);
      prevOn = cur;
    } else {
      const nextIdx = (i + 1) % n;
      const end = contour[nextIdx]!.onCurve ? pts[nextIdx]! : mid(cur, pts[nextIdx]!);
      quad(prevOn, cur, end, poly);
      /** off-curve 段结束后的隐含 on-curve 点也要成为下一段的起点 */
      poly.push(end);
      prevOn = end;
    }
  }
  return poly;
}

/**
 * 扫描线按非零环绕规则填充多边形集合
 * polys 顶点已是目标网格坐标系（含翻转与缩放）。
 * 必须合并全部轮廓的交点：外轮廓与内轮廓方向相反，内轮廓处的环绕数归零，
 * 从而保留「借」「日」等字形的封闭留白。
 */
function scanlineFill(polys: Pt[][]): Uint8Array {
  const grid = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    const sy = y + 0.5;
    const crossings: Array<{ x: number; winding: number }> = [];
    for (const poly of polys) {
      if (poly.length < 3) continue;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        if (a.y === b.y) continue;
        if ((sy >= a.y && sy < b.y) || (sy >= b.y && sy < a.y)) {
          crossings.push({
            x: a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x),
            winding: a.y < b.y ? 1 : -1,
          });
        }
      }
    }
    crossings.sort((a, b) => a.x - b.x);
    let winding = 0;
    for (let i = 0; i + 1 < crossings.length; i++) {
      winding += crossings[i]!.winding;
      if (winding === 0) continue;
      const x0 = Math.max(0, Math.ceil(crossings[i]!.x - 0.5));
      const x1 = Math.min(GRID - 1, Math.floor(crossings[i + 1]!.x - 0.5));
      for (let x = x0; x <= x1; x++) grid[y * GRID + x] = 1;
    }
  }
  return grid;
}

/**
 * 紧致裁剪 + 归一化多边形到 64x64 内框（与前端 maskToNormalizedRGBA 同参）
 * 直接对多边形坐标做变换（而非对位图二次采样），避免双重采样损失
 */
function normalizePolys(polys: Pt[][]): Pt[][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const w = maxX - minX;
  const h = maxY - minY;
  /** 退化（空轮廓/纯水平线）保护 */
  if (!(w > 0) || !(h > 0)) return [];

  const margin = GRID * MARGIN_RATIO;
  const inner = GRID - margin * 2;
  const scale = Math.min(inner / w, inner / h);
  const dw = w * scale;
  const dh = h * scale;
  const ox = (GRID - dw) / 2 - minX * scale;
  const oy = (GRID - dh) / 2 - minY * scale;
  return polys.map((poly) => poly.map((p) => ({ x: p.x * scale + ox, y: p.y * scale + oy })));
}

/**
 * 取字体的指定码点字形归一化位图（带缓存；缺字返回 null）
 */
export function getGlyphBitmap(
  ttf: ReturnType<ReturnType<typeof Font.create>["get"]>,
  fontName: string,
  codePoint: number,
): Uint8Array | null {
  let byFont = glyphBitmapCache.get(fontName);
  if (!byFont) {
    byFont = new Map();
    glyphBitmapCache.set(fontName, byFont);
  }
  if (byFont.has(codePoint)) return byFont.get(codePoint)!;

  let bitmap: Uint8Array | null = null;
  try {
    /** cmap 的 key 是码点的十进制值；无 cmap 时按 glyf.unicode 兜底扫描 */
    let gid = ttf.cmap?.[codePoint as unknown as number] as number | undefined;
    if (gid === undefined && ttf.glyf) {
      for (let i = 0; i < ttf.glyf.length; i++) {
        const u = ttf.glyf[i]!.unicode;
        if (u === codePoint || (Array.isArray(u) && u.includes(codePoint))) {
          gid = i;
          break;
        }
      }
    }
    const glyf = typeof gid === "number" ? ttf.glyf?.[gid] : undefined;
    const contours = readGlyphContours(ttf, glyf);
    if (contours.length > 0) {
      const polys = contours.map(flattenContour).filter((p) => p.length >= 3);
      const normalized = normalizePolys(polys);
      bitmap = normalized.length > 0 ? scanlineFill(normalized) : null;
      /** 全空位图视为缺字 */
      if (bitmap && !bitmap.some((v) => v)) bitmap = null;
    }
  } catch {
    bitmap = null;
  }
  byFont.set(codePoint, bitmap);
  return bitmap;
}

/**
 * IoU（交并比）—— 两个 64x64 二值位图的相似度
 * 严格交集版本，对 1px 级错位敏感；容错场景用 glyphSimilarity
 */
export function bitmapIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    if (va | vb) union++;
    if (va & vb) inter++;
  }
  return union === 0 ? 0 : inter / union;
}

/**
 * 距离变换（Chamfer 3-4 两遍扫描）—— 每个 0 像素到最近 1 像素的距离
 * 用于容错比对：拍照残余错切/字重差异下笔画不完全重合，
 * 用「笔画像素到对方笔画的平均距离」替代硬交集
 */
function distanceTransform(mask: Uint8Array): Float32Array {
  const INF = 1e9;
  const dt = new Float32Array(GRID * GRID);
  for (let i = 0; i < dt.length; i++) dt[i] = mask[i] ? 0 : INF;
  /** 正向扫描（左上 → 右下） */
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = y * GRID + x;
      let v = dt[i]!;
      if (x > 0) v = Math.min(v, dt[i - 1]! + 3);
      if (y > 0) v = Math.min(v, dt[i - GRID]! + 3);
      if (x > 0 && y > 0) v = Math.min(v, dt[i - GRID - 1]! + 4);
      if (x < GRID - 1 && y > 0) v = Math.min(v, dt[i - GRID + 1]! + 4);
      dt[i] = v;
    }
  }
  /** 反向扫描（右下 → 左上） */
  for (let y = GRID - 1; y >= 0; y--) {
    for (let x = GRID - 1; x >= 0; x--) {
      const i = y * GRID + x;
      let v = dt[i]!;
      if (x < GRID - 1) v = Math.min(v, dt[i + 1]! + 3);
      if (y < GRID - 1) v = Math.min(v, dt[i + GRID]! + 3);
      if (x < GRID - 1 && y < GRID - 1) v = Math.min(v, dt[i + GRID + 1]! + 4);
      if (x > 0 && y < GRID - 1) v = Math.min(v, dt[i + GRID - 1]! + 4);
      dt[i] = v;
    }
  }
  return dt;
}

/** a 的笔画像素在 dtB 距离场上的平均距离（越近越像）；空掩码返回 -1 */
function meanDistance(a: Uint8Array, dtB: Float32Array, dx: number, dy: number): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < GRID; y++) {
    const sy = y + dy;
    if (sy < 0 || sy >= GRID) continue;
    for (let x = 0; x < GRID; x++) {
      if (!a[y * GRID + x]) continue;
      const sx = x + dx;
      if (sx < 0 || sx >= GRID) continue;
      sum += dtB[sy * GRID + sx]!;
      count++;
    }
  }
  return count === 0 ? -1 : sum / count / 3; /** 除以 3 归一到像素单位 */
}

/**
 * 容错字形相似度 —— 对称 Chamfer 距离 + ±2px 平移搜索
 *
 * 拍照字形经倾角校正后仍可能残余 1~2px 平移/错切，且截图字重与字体
 * 实际字重常有差异（加粗/材质晕染）。距离场打分对此不敏感：
 *   score = exp(-max(meanDist(a→B), meanDist(b→A)) / σ)，σ=4px
 * 平移搜索取 25 个偏移中的最优值，覆盖亚像素级残余错位。
 * 每字形开销约 2 次距离变换 + 25 次均值遍历（~100k 整数/浮点运算），仍为微秒~亚毫秒级。
 */
export function glyphSimilarity(a: Uint8Array, b: Uint8Array): number {
  const dtA = distanceTransform(a);
  const dtB = distanceTransform(b);
  let worst = Infinity;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dAB = meanDistance(a, dtB, dx, dy);
      const dBA = meanDistance(b, dtA, -dx, -dy);
      if (dAB < 0 || dBA < 0) continue;
      const m = Math.max(dAB, dBA);
      if (m < worst) worst = m;
    }
  }
  if (!isFinite(worst)) return 0;
  return Math.exp(-worst / 4);
}
