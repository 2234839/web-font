/**
 * 字形切分与归一化 —— 截图找字体的图像处理层
 *
 * 流程：截图选区 → 灰度 + Otsu 二值化 → 垂直投影切分单字 → 紧致裁剪 →
 * 等比缩放居中到固定尺寸网格。渲染侧（canvas 画的候选字形）走同一条
 * mask → normalize 路径，保证两侧特征空间一致，SSIM 才有意义。
 */

/** 归一化网格边长（64px 足够保留笔画结构，SSIM 11px 窗口也有约 5x5 个窗口） */
export const GRID = 64;

/** 二值化掩码：1 = 笔画（前景），0 = 背景 */
export interface Mask {
  /** 掩码数据，长度 w*h */
  data: Uint8Array;
  /** 宽 */
  w: number;
  /** 高 */
  h: number;
}

/**
 * Otsu 大津法求二值化阈值
 * 输入为灰度直方图（256 桶），返回使类间方差最大的阈值
 */
export function otsuThreshold(hist: Float64Array): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 128;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;

  let sumBg = 0;
  let weightBg = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBg += hist[t]!;
    if (weightBg === 0) continue;
    const weightFg = total - weightBg;
    if (weightFg === 0) break;
    sumBg += t * hist[t]!;
    const meanBg = sumBg / weightBg;
    const meanFg = (sumAll - sumBg) / weightFg;
    const between = weightBg * weightFg * (meanBg - meanFg) * (meanBg - meanFg);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * RGBA 图像数据 → 二值掩码（墨色 = 前景）—— 照片级鲁棒版
 *
 * 三层防线应对拍照场景：
 *  1. 双通道择优：彩色文字（如金色压暗背景）在亮度通道可能无对比度，
 *     同时算「亮度」和「HSV 明度 V」两个通道的掩码，取前景占比更接近
 *     正文文字典型值（~12%）的那个
 *  2. Sauvola 自适应局部阈值：光照渐变/材质纹理下全局 Otsu 会整片误判，
 *     局部窗口（15px）按邻域均值+方差逐像素求阈值，积分图加速
 *  3. 连通域去噪：8 邻域 flood fill，扢掉面积小于主组件 1/20 的孤立噪声
 */
export function imageToMask(image: ImageData): Mask {
  const { width: w, height: h, data } = image;
  const n = w * h;
  const lum = new Uint8Array(n);
  const val = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const r = data[idx]!, g = data[idx + 1]!, b = data[idx + 2]!;
    lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    val[i] = Math.max(r, g, b);
  }

  const lumMask = sauvolaMask(lum, w, h);
  const valMask = sauvolaMask(val, w, h);
  /** 前景占比（文字通常 5%~30%，取更接近 12% 的通道） */
  const frac = (m: Uint8Array) => {
    let c = 0;
    for (let i = 0; i < n; i++) c += m[i]!;
    return c / n;
  };
  const fl = frac(lumMask);
  const fv = frac(valMask);
  const better = Math.abs(fl - 0.12) <= Math.abs(fv - 0.12) ? lumMask : valMask;

  const mask = new Uint8Array(n);
  mask.set(better);
  /** 极性反转：亮字暗底（霓虹/反光材质）时前景占比会 >50%，文字恒为少数側 → 取反 */
  const f = frac(mask);
  if (f > 0.5) {
    for (let i = 0; i < n; i++) mask[i] = mask[i] ? 0 : 1;
  }
  despeckleInPlace(mask, w, h);
  return { data: mask, w, h };
}

/**
 * Sauvola 局部自适应阈值二值化（墨暗前提交路）
 * t(x,y) = m * (1 + k * (s/R - 1))，窗口 15、k=0.2、R=128
 */
function sauvolaMask(gray: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  /** 积分图（sum / sum^2），尺寸 (w+1)*(h+1) */
  const w1 = w + 1;
  const isum = new Float64Array(w1 * (h + 1));
  const isq = new Float64Array(w1 * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x]!;
      const ip = (y + 1) * w1 + x + 1;
      isum[ip] = v + isum[ip - 1]! + isum[ip - w1]! - isum[ip - w1 - 1]!;
      isq[ip] = v * v + isq[ip - 1]! + isq[ip - w1]! - isq[ip - w1 - 1]!;
    }
  }
  const WIN = 15;
  const r = WIN >> 1;
  const K = 0.2;
  const R = 128;
  const out = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - r), y2 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - r), x2 = Math.min(w, x + r + 1);
      const cnt = (x2 - x1) * (y2 - y1);
      const s = isum[y2 * w1 + x2]! - isum[y1 * w1 + x2]! - isum[y2 * w1 + x1]! + isum[y1 * w1 + x1]!;
      const sq = isq[y2 * w1 + x2]! - isq[y1 * w1 + x2]! - isq[y2 * w1 + x1]! + isq[y1 * w1 + x1]!;
      const m = s / cnt;
      const sd = Math.sqrt(Math.max(0, sq / cnt - m * m));
      const t = m * (1 + K * (sd / R - 1));
      out[y * w + x] = gray[y * w + x]! <= t ? 1 : 0;
    }
  }
  return out;
}

/**
 * 连通域去噪（4 邻域洪泛）
 * 以最大组件为基准，面积 < max(4, 主组件/20) 的组件视为噪声抹除。
 * 栈式 flood fill，避免递归爆栈；扫描线式访问保证缓存友好。
 */
function despeckleInPlace(mask: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const visited = new Uint8Array(n);
  const components: Array<{ area: number; pixels: number[] }> = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || visited[i]) continue;
    const pixels: number[] = [];
    stack.push(i);
    visited[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const px = p % w;
      const py = (p - px) / w;
      const neighbors = [
        px > 0 ? p - 1 : -1,
        px < w - 1 ? p + 1 : -1,
        py > 0 ? p - w : -1,
        py < h - 1 ? p + w : -1,
      ];
      for (const q of neighbors) {
        if (q >= 0 && mask[q] && !visited[q]) {
          visited[q] = 1;
          stack.push(q);
        }
      }
    }
    components.push({ area: pixels.length, pixels });
  }
  if (components.length < 2) return;
  const maxArea = Math.max(...components.map((c) => c.area));
  const minKeep = Math.max(4, Math.floor(maxArea / 20));
  for (const c of components) {
    if (c.area < minKeep) {
      for (const p of c.pixels) mask[p] = 0;
    }
  }
}

/**
 * 倾角自动校正 —— 拍照旋转/倾斜 {-12°..12°} 内找使行投影方差最大的角度
 * （文字行水平时横画笔画在同一行堆叠，投影最「尖」；歪斜时被拉平）。
 * 粗扫步进 1.5°，最优点附近 0.25° 细扫。返回校正后的新掩码。
 */
export function deskewMask(mask: Mask): Mask {
  const { data, w, h } = mask;
  /** 墨点坐标收集 */
  const xs: number[] = [];
  const ys: number[] = [];
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x]) {
        xs.push(x);
        ys.push(y);
        cx += x;
        cy += y;
      }
    }
  }
  if (xs.length < 8) return mask;
  cx /= xs.length;
  cy /= ys.length;

  /** 给定角度的行投影方差（以中心为轴旋转） */
  const profileVariance = (angle: number): number => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rows = new Float64Array(h + 1);
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i]! - cx;
      const dy = ys[i]! - cy;
      const ry = Math.round(sin * dx + cos * dy + cy);
      if (ry >= 0 && ry <= h) rows[ry]!++;
    }
    let mean = 0;
    for (const v of rows) mean += v;
    mean /= rows.length;
    let vr = 0;
    for (const v of rows) vr += (v - mean) * (v - mean);
    return vr / rows.length;
  };

  /** 粗扫 + 细扫 */
  let best = 0;
  let bestV = -1;
  for (let a = -12; a <= 12; a += 1.5) {
    const v = profileVariance((a * Math.PI) / 180);
    if (v > bestV) {
      bestV = v;
      best = a;
    }
  }
  for (let a = best - 1.5; a <= best + 1.5; a += 0.25) {
    const v = profileVariance((a * Math.PI) / 180);
    if (v > bestV) {
      bestV = v;
      best = a;
    }
  }
  /** 校正量过小则不动（避免无谓的重采样损失） */
  if (Math.abs(best) < 0.3) return mask;

  /** 反向旋转回正（最近邻采样），并紧致裁剪 */
  const rad = (-best * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = w, maxX = -1, minY = h, maxY = -1;
  const nx: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - cx;
    const dy = ys[i]! - cy;
    const x = Math.round(cos * dx - sin * dy + cx);
    const y = Math.round(sin * dx + cos * dy + cy);
    nx.push(x);
    ny.push(y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0 || maxY < 0) return mask;
  const cw = Math.min(w, maxX - minX + 1);
  const chh = Math.min(h, maxY - minY + 1);
  const out = new Uint8Array(cw * chh);
  for (let i = 0; i < nx.length; i++) {
    const x = nx[i]! - minX;
    const y = ny[i]! - minY;
    if (x >= 0 && x < cw && y >= 0 && y < chh) out[y * cw + x] = 1;
  }
  return { data: out, w: cw, h: chh };
}

/**
 * 宽段低谷递归切分 —— 处理字间笔画粘连/字间隙过窄的段
 *
 * 纯零列切分要求间隙连续且够宽；拍照场景（抗锯齿、笔画搭接）字间隙常只有
 * 1~2 列甚至完全粘连，此时一个段会包含多个字。CJK 方块字宽约等于行高，
 * 段宽超过 1.6 倍行高即视为多字粘连段，在其墨量投影上找「低谷」下刀：
 * 低谷 = 墨量 ≤ 段内峰值 15% 的连续区，取最靠近段中心者（避开字内笔画间隙）。
 * 递归直到段宽收敛或找不到低谷。
 */
function splitWideByValley(
  data: Uint8Array, w: number, h: number,
  x1: number, x2: number, out: Array<[number, number]>,
): void {
  const segW = x2 - x1 + 1;
  /** CJK 单字宽约等于行高（含少量出血余量）；1.35 倍行高以上判定为多字粘连段 */
  const maxSingle = Math.max(16, h * 1.35);
  if (segW <= maxSingle) {
    out.push([x1, x2]);
    return;
  }
  const colInk = new Uint32Array(segW);
  let peak = 0;
  for (let x = 0; x < segW; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) c += data[y * w + x1 + x]!;
    colInk[x] = c;
    if (c > peak) peak = c;
  }
  if (peak === 0) {
    out.push([x1, x2]);
    return;
  }
  /** 低谷阈值：峰值的 15%（至少容忍 2 墨点，抗二值化残点） */
  const threshold = Math.max(2, peak * 0.15);
  /** 找最靠近段中心的低谷列 */
  const center = (segW - 1) / 2;
  let best = -1;
  let bestDist = Infinity;
  for (let x = 1; x < segW - 1; x++) {
    if (colInk[x]! <= threshold) {
      const dist = Math.abs(x - center);
      if (dist < bestDist) {
        bestDist = dist;
        best = x;
      }
    }
  }
  /** 无低谷（真连体字）则不再切，按原段返回 */
  if (best < 1) {
    out.push([x1, x2]);
    return;
  }
  const cut = x1 + best;
  splitWideByValley(data, w, h, x1, cut - 1, out);
  splitWideByValley(data, w, h, cut + 1, x2, out);
}

/**
 * 垂直投影切分单字（适用于横向排版的等高文字行）
 * 按列是否有笔画分界；过窄的段并入相邻段（笔画断裂/粘连兜底）；
 * 过宽的段（字间粘连/间隙过窄）按墨量低谷递归切分
 */
export function segmentByProjection(mask: Mask, options?: { minGap?: number; minArea?: number }): Mask[] {
  const { data, w, h } = mask;
  const minGap = options?.minGap ?? 1;
  const minArea = options?.minArea ?? Math.max(8, Math.round(w * h * 0.0005));
  const colHasInk = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (data[y * w + x]) {
        colHasInk[x] = 1;
        break;
      }
    }
  }
  /** 初始切分：连续有墨列段，允许 minGap 宽度的间隙跨过 */
  const segments: Array<[number, number]> = [];
  let start = -1;
  let gapRun = 0;
  for (let x = 0; x < w; x++) {
    if (colHasInk[x]) {
      if (start === -1) start = x;
      gapRun = 0;
    } else if (start !== -1) {
      gapRun++;
      if (gapRun > minGap) {
        segments.push([start, x - gapRun]);
        start = -1;
      }
    }
  }
  if (start !== -1) segments.push([start, w - 1]);

  /** 宽段低谷切分（多字粘连段按字宽拆开） */
  const splitSegments: Array<[number, number]> = [];
  for (const [sx1, sx2] of segments) {
    splitWideByValley(data, w, h, sx1, sx2, splitSegments);
  }

  /** 逐段紧致裁剪 + 噪声过滤 */
  const result: Mask[] = [];
  for (const [x1, x2] of splitSegments) {
    let top = h, bottom = -1, area = 0;
    for (let y = 0; y < h; y++) {
      for (let x = x1; x <= x2; x++) {
        if (data[y * w + x]) {
          area++;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (bottom < 0 || area < minArea) continue;
    const cw = x2 - x1 + 1;
    const ch = bottom - top + 1;
    const crop = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        crop[y * cw + x] = data[(y + top) * w + (x1 + x)]!;
      }
    }
    result.push({ data: crop, w: cw, h: ch });
  }
  return result;
}

/**
 * 按指定字数切分掩码 —— 方块字（CJK）专用切分策略
 *
 * 垂直投影切分在「字间笔画粘连」时失效（如行楷/美术字「乾坤」连成一个墨块），
 * 而中文本质是等宽方块字，按字数等分选区更可靠：
 *  1. 先找出整行笔画的包围盒（左右顶紧，避免两侧空白稀释单元格宽度）
 *  2. 按字数 N 把包围盒均分为 N 个等宽单元格
 *  3. 每格边界在局部 ±20% 区间内微调：寻找投影墨量最小的 x 作为切线
 *     （优先沿字间隙切，粘连时也最多切到笔画细处，而非硬切主笔）
 *  4. 每格独立紧致裁剪（含上下方向）
 */
export function segmentByCount(mask: Mask, count: number): Mask[] {
  if (count <= 0) return [];
  if (count === 1) {
    const segs = segmentByProjection(mask, { minGap: mask.w });
    return segs.slice(0, 1);
  }
  const { data, w, h } = mask;

  /** 整行包围盒 */
  let left = w, right = -1;
  const colInk = new Uint32Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) c += data[y * w + x]!;
    colInk[x] = c;
    if (c > 0) {
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) return [];

  const totalW = right - left + 1;
  const cellW = totalW / count;
  /** 微调窗口：单元格宽度的 20%（粘连字最多允许 ±20% 的切线偏移） */
  const adjustRange = Math.max(1, Math.round(cellW * 0.2));

  /** 计算 N+1 条切线的 x 坐标：首尾贴包围盒，中间按局部墨量最小微调 */
  const cuts: number[] = [left];
  for (let i = 1; i < count; i++) {
    const ideal = Math.round(left + i * cellW);
    let bestX = ideal;
    let bestInk = Infinity;
    for (let x = Math.max(left + 1, ideal - adjustRange); x <= Math.min(right, ideal + adjustRange); x++) {
      const ink = colInk[x]!;
      if (ink < bestInk) {
        bestInk = ink;
        bestX = x;
      }
    }
    cuts.push(bestX);
  }
  cuts.push(right + 1);

  /** 逐单元格紧致裁剪 */
  const result: Mask[] = [];
  for (let i = 0; i < count; i++) {
    const x1 = cuts[i]!;
    const x2 = cuts[i + 1]! - 1;
    let top = h, bottom = -1;
    for (let y = 0; y < h; y++) {
      for (let x = x1; x <= x2; x++) {
        if (data[y * w + x]) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    /** 空单元格（该字全空白）仍占位返回 1x1 空掩码，保持与输入文字的下标对齐 */
    if (bottom < 0) {
      result.push({ data: new Uint8Array(1), w: 1, h: 1 });
      continue;
    }
    const cw = x2 - x1 + 1;
    const ch = bottom - top + 1;
    const crop = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        crop[y * cw + x] = data[(y + top) * w + (x1 + x)]!;
      }
    }
    result.push({ data: crop, w: cw, h: ch });
  }
  return result;
}

/**
 * 智能切分：投影切分与按字数切分择优
 * 已知字数时用 segmentByCount（方块字粘连场景），未知时用投影切分
 */
export function smartSegment(mask: Mask, count?: number): Mask[] {
  if (count && count > 0) return segmentByCount(mask, count);
  return segmentByProjection(mask);
}

/**
 * 掩码归一化到 GRID x GRID 的 RGBA 像素（供 SSIM 与预览共用）
 * 等比缩放、居中放置，四周留白约 12%；输出灰度图：笔画 0（黑）、背景 255（白）
 */
export function maskToNormalizedRGBA(mask: Mask): Uint8Array {
  const { data, w, h } = mask;
  /** 有效绘制区（留 12% 边距，笔画贴边时 SSIM 窗口越界补偿） */
  const margin = Math.round(GRID * 0.12);
  const inner = GRID - margin * 2;
  const scale = Math.min(inner / w, inner / h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const ox = Math.round((GRID - dw) / 2);
  const oy = Math.round((GRID - dh) / 2);

  /** 目标网格先落 0/1，再转灰度 RGBA */
  const grid = new Uint8Array(GRID * GRID);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      if (data[sy * w + sx]) grid[(y + oy) * GRID + (x + ox)] = 1;
    }
  }
  const out = new Uint8Array(GRID * GRID * 4);
  for (let i = 0; i < GRID * GRID; i++) {
    const v = grid[i] ? 0 : 255;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** 归一化 RGBA 转DataURL，用于结果预览小图 */
export function rgbaToDataURL(rgba: Uint8Array): string {
  const canvas = document.createElement("canvas");
  canvas.width = GRID;
  canvas.height = GRID;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(GRID, GRID);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}
