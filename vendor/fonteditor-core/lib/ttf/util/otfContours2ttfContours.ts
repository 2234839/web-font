import { bezierCubic2Q2Raw, bezierCubic2Q2PushRounded } from "../../math/bezierCubic2Q2";

/**
 * @file otf轮廓转ttf轮廓
 * @author mengke01(kekee000@gmail.com)
 *
 * CFF Type 2 charstring 解析后的 contour 扁平格式：
 *   - [x, y, flag, x, y, flag, ...]  flag=1 onCurve, flag=0 offCurve
 *   - 每个 cubic bezier 段由 2 个 offCurve + 1 个 onCurve 组成
 *   - 连续的 offCurve 点之间，隐含端点为两者的中点
 *
 * 优化178: 全流程扁平数组，消除对象分配
 */

/**
 * 优化178: 直接消费扁平数组 normalizeContour，返回扁平数组
 *
 * @param arr 扁平轮廓数组 [x, y, flag, ...]
 * @return 标准化后的扁平轮廓数组
 */
function normalizeContourFlat(arr: number[]): number[] {
  const len = arr.length;
  if (len < 6) return arr;

  /** 检查第一个点是否 onCurve */
  const firstOnCurve = !!arr[2];
  let prependX: number | null = null;
  let prependY: number | null = null;

  if (!firstOnCurve) {
    const lastIdx = len - 3;
    const lastOnCurve = !!arr[lastIdx + 2];
    if (lastOnCurve) {
      prependX = arr[lastIdx];
      prependY = arr[lastIdx + 1];
    } else {
      prependX = (arr[0] + arr[lastIdx]) * 0.5;
      prependY = (arr[1] + arr[lastIdx + 1]) * 0.5;
    }
  }

  /** 检查是否有连续 offCurve 点 */
  let hasConsecutiveOff = false;
  if (!firstOnCurve) hasConsecutiveOff = true;
  else {
    for (let j = 0; j < len - 3; j += 3) {
      if (!arr[j + 2] && j + 5 < len && !arr[j + 5]) {
        hasConsecutiveOff = true;
        break;
      }
    }
    /** 也检查最后一个和第一个 */
    if (!hasConsecutiveOff && len >= 6 && !arr[len - 1] && !arr[2]) {
      hasConsecutiveOff = true;
    }
  }

  if (!hasConsecutiveOff && firstOnCurve) return arr;

  /** 优化192: 预分配结果数组，索引赋值替代 push，消除动态扩容 */
  const maxLen = len + ((len / 3) | 0) * 3 + 6;
  const result = new Array<number>(maxLen);
  let ri = 0;
  if (prependX != null && prependY != null) {
    result[ri++] = prependX;
    result[ri++] = prependY;
    result[ri++] = 1;
  }
  for (let k = 0; k < len; k += 3) {
    result[ri++] = arr[k];
    result[ri++] = arr[k + 1];
    result[ri++] = arr[k + 2];
    if (!arr[k + 2] && k + 5 < len && !arr[k + 5]) {
      result[ri++] = (arr[k] + arr[k + 3]) * 0.5;
      result[ri++] = (arr[k + 1] + arr[k + 4]) * 0.5;
      result[ri++] = 1;
    }
  }
  /** 检查 wrap-around 连续 offCurve */
  if (prependX == null && len >= 6 && !arr[len - 1] && !arr[2]) {
    result[ri++] = (arr[len - 3] + arr[0]) * 0.5;
    result[ri++] = (arr[len - 2] + arr[1]) * 0.5;
    result[ri++] = 1;
  }
  result.length = ri;
  return result;
}

/**
 * 转换已标准化的轮廓，全扁平数组操作
 * 优化178: 输入和输出都是扁平数组 [x, y, flag, ...]
 * 优化285: 就地取整 + bbox 同步计算，消除最后的 Math.round 遍历
 *
 * @param arr 扁平轮廓数组 [x, y, flag, ...]
 * @return 转换结果与包围盒，轮廓点数不足返回 null
 */
function transformContourFlat(arr: number[]): { contour: number[]; xMin: number; yMin: number; xMax: number; yMax: number } | null {
  const normalized = normalizeContourFlat(arr);
  if (normalized.length < 6) return null;

  /** 优化196: 预分配 contour 数组，最坏情况每点变成两段二次贝塞尔（6元素） */
  const estimatedMax = normalized.length * 2 + 6;
  const contour = new Array<number>(estimatedMax);
  let ci = 0;

  /** 优化285: 首点取整，后续 lastX/lastY 始终为取整值 */
  const firstX = normalized[0], firstY = normalized[1];
  let rX = Math.round(firstX), rY = Math.round(firstY);
  contour[ci++] = rX; contour[ci++] = rY; contour[ci++] = 1;
  let xMin = rX, xMax = rX, yMin = rY, yMax = rY;
  let lastX = firstX, lastY = firstY;

  let i = 3;
  const nLen = normalized.length;
  /** 优化291: 预分配 bboxArr，循环中复用避免每次 cubic 曲线分配新数组 */
  const bboxArr = [xMin, xMax, yMin, yMax];

  while (i < nLen) {
    const isOnCurve = normalized[i + 2];
    if (isOnCurve) {
      /** 线段：取整后添加 onCurve 端点，同步 bbox */
      const px = normalized[i], py = normalized[i + 1];
      rX = Math.round(px); rY = Math.round(py);
      contour[ci++] = rX; contour[ci++] = rY; contour[ci++] = 1;
      lastX = px; lastY = py;
      if (rX < xMin) xMin = rX; else if (rX > xMax) xMax = rX;
      if (rY < yMin) yMin = rY; else if (rY > yMax) yMax = rY;
      i += 3;
    } else {
      /** offCurve 点 */
      const c1x = normalized[i], c1y = normalized[i + 1];
      const nextIdx = i + 3;
      if (nextIdx < nLen && !normalized[nextIdx + 2]) {
        /** 第二个点也是 offCurve → 三次贝塞尔曲线 */
        const c2x = normalized[nextIdx], c2y = normalized[nextIdx + 1];
        const endIdx = nextIdx + 3;
        let endX: number, endY: number;
        if (endIdx < nLen) {
          endX = normalized[endIdx]; endY = normalized[endIdx + 1];
        } else {
          endX = firstX; endY = firstY;
        }
        i = endIdx + 3;

        /** 优化291: 复用 bboxArr，避免每次 cubic 曲线分配新数组 */
        bboxArr[0] = xMin; bboxArr[1] = xMax; bboxArr[2] = yMin; bboxArr[3] = yMax;
        ci = bezierCubic2Q2PushRounded(lastX, lastY, c1x, c1y, c2x, c2y, endX, endY, contour, ci, bboxArr);
        lastX = endX;
        lastY = endY;
        xMin = bboxArr[0]; xMax = bboxArr[1]; yMin = bboxArr[2]; yMax = bboxArr[3];
      } else {
        /** 单个 offCurve → 二次贝塞尔曲线 */
        let endX2: number, endY2: number;
        if (nextIdx < nLen && normalized[nextIdx + 2]) {
          endX2 = normalized[nextIdx]; endY2 = normalized[nextIdx + 1];
        } else {
          endX2 = firstX; endY2 = firstY;
        }
        i = nextIdx + 3;
        /** 控制点也取整 */
        const rc1x = Math.round(c1x), rc1y = Math.round(c1y);
        rX = Math.round(endX2); rY = Math.round(endY2);
        contour[ci++] = rc1x; contour[ci++] = rc1y; contour[ci++] = 0;
        contour[ci++] = rX; contour[ci++] = rY; contour[ci++] = 1;
        lastX = endX2;
        lastY = endY2;
        if (rc1x < xMin) xMin = rc1x; else if (rc1x > xMax) xMax = rc1x;
        if (rc1y < yMin) yMin = rc1y; else if (rc1y > yMax) yMax = rc1y;
        if (rX < xMin) xMin = rX; else if (rX > xMax) xMax = rX;
        if (rY < yMin) yMin = rY; else if (rY > yMax) yMax = rY;
      }
    }
  }

  contour.length = ci;

  return { contour, xMin, yMin, xMax, yMax };
}

/**
 * 兼容旧对象数组格式 [onCurve, offCurve, ...]
 *
 * @param otfContour 对象格式轮廓
 * @return ttf 轮廓（扁平三元组数组）
 */
function transformContourObj(otfContour: any[]): any[] {
  if (otfContour.length < 2) return [];

  const contour: any[] = [];
  const p0 = otfContour[0];
  contour.push({ x: (p0.x + 0.5) | 0, y: (p0.y + 0.5) | 0, onCurve: true });

  let i = 1;
  const nLen = otfContour.length;
  while (i < nLen) {
    const cur = otfContour[i];
    if (cur.onCurve) {
      contour.push({ x: (cur.x + 0.5) | 0, y: (cur.y + 0.5) | 0, onCurve: true });
      i++;
    } else {
      const c1 = cur;
      const c2 = i + 1 < nLen ? otfContour[i + 1] : null;
      let end: any;

      if (c2 && !c2.onCurve) {
        end = i + 2 < nLen ? otfContour[i + 2] : otfContour[0];
        i += 3;
      } else if (c2 && c2.onCurve) {
        end = c2;
        i += 2;
      } else {
        end = otfContour[0];
        i++;
      }

      const bezierFlat = bezierCubic2Q2Raw(contour[contour.length - 1].x, contour[contour.length - 1].y, c1.x, c1.y, (c2 || c1).x, (c2 || c1).y, end.x, end.y);
      for (let bi = 0, bl = bezierFlat.length; bi < bl; bi += 4) {
        contour.push({ x: (bezierFlat[bi] + 0.5) | 0, y: (bezierFlat[bi + 1] + 0.5) | 0 });
        contour.push({ x: (bezierFlat[bi + 2] + 0.5) | 0, y: (bezierFlat[bi + 3] + 0.5) | 0, onCurve: true });
      }
    }
  }

  return contour;
}

/**
 * otf轮廓转ttf轮廓，同时计算包围盒
 * 优化178: 支持扁平数组输入 [x, y, flag, ...]，直接构建扁平数组输出
 *
 * @param otfContours otf轮廓数组
 * @return 转换后的ttf轮廓与包围盒
 */
export default function otfContours2ttfContours(otfContours: any[]): any {
  if (!otfContours || !otfContours.length) {
    return { contours: otfContours };
  }
  /** 优化200: 预分配 contours 数组 */
  const contours = new Array<any>(otfContours.length);
  let cLen = 0;
  /** 优化221: 用 Infinity 初始化，消除 found 分支 */
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  /** 优化221: 提升 isFlat 检测到循环外，同一 glyph 的所有 contour 格式一致 */
  const isFlat = otfContours[0] && (otfContours[0]._flatContours || (typeof otfContours[0][0] === "number" && typeof otfContours[0][1] === "number"));
  for (let i = 0, l = otfContours.length; i < l; i++) {
    const otfContour = otfContours[i];
    if (!otfContour || otfContour.length < 6) continue;

    let contour: any[];
    let contourBbox: { xMin: number; yMin: number; xMax: number; yMax: number } | undefined;
    if (isFlat) {
      const result = transformContourFlat(otfContour);
      if (!result) continue;
      contour = result.contour;
      contourBbox = result;
    } else {
      contour = transformContourObj(otfContour);
    }
    if (contour.length < 3) continue;
    contours[cLen++] = contour;

    /** 计算包围盒 */
    if (contourBbox) {
      /** 优化: bbox 已在 transformContourFlat 中计算，直接合并 */
      if (contourBbox.xMin < left) left = contourBbox.xMin;
      if (contourBbox.xMax > right) right = contourBbox.xMax;
      if (contourBbox.yMin < top) top = contourBbox.yMin;
      if (contourBbox.yMax > bottom) bottom = contourBbox.yMax;
    } else {
      for (let ci = 0, cl = contour.length; ci < cl; ci++) {
        const p = contour[ci];
        if (p.x < left) left = p.x; else if (p.x > right) right = p.x;
        if (p.y < top) top = p.y; else if (p.y > bottom) bottom = p.y;
      }
    }
  }
  contours.length = cLen;
  return {
    contours,
    xMin: left,
    yMin: top,
    xMax: right,
    yMax: bottom
  };
}

/**
 * 就地写入版本：直接将转换结果写入 target 对象，避免创建中间返回对象
 * 优化291: 消除每个 glyph 一次 { contours, xMin, yMin, xMax, yMax } 对象分配
 *
 * @param otfContours otf轮廓数组
 * @param target 写入目标 glyf 对象
 */
export function otfContours2ttfContoursInPlace(otfContours: any[], target: any): void {
  if (!otfContours || !otfContours.length) {
    return;
  }
  const contours = new Array<any>(otfContours.length);
  let cLen = 0;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  const isFlat = otfContours[0] && (otfContours[0]._flatContours || (typeof otfContours[0][0] === "number" && typeof otfContours[0][1] === "number"));
  for (let i = 0, l = otfContours.length; i < l; i++) {
    const otfContour = otfContours[i];
    if (!otfContour || otfContour.length < 6) continue;

    let contour: any[];
    let contourBbox: { xMin: number; yMin: number; xMax: number; yMax: number } | undefined;
    if (isFlat) {
      const result = transformContourFlat(otfContour);
      if (!result) continue;
      contour = result.contour;
      contourBbox = result;
    } else {
      contour = transformContourObj(otfContour);
    }
    if (contour.length < 3) continue;
    contours[cLen++] = contour;

    if (contourBbox) {
      if (contourBbox.xMin < left) left = contourBbox.xMin;
      if (contourBbox.xMax > right) right = contourBbox.xMax;
      if (contourBbox.yMin < top) top = contourBbox.yMin;
      if (contourBbox.yMax > bottom) bottom = contourBbox.yMax;
    } else {
      for (let ci = 0, cl = contour.length; ci < cl; ci++) {
        const p = contour[ci];
        if (p.x < left) left = p.x; else if (p.x > right) right = p.x;
        if (p.y < top) top = p.y; else if (p.y > bottom) bottom = p.y;
      }
    }
  }
  contours.length = cLen;
  target.contours = contours;
  target._flatContours = true;
  if (left !== Infinity) {
    target.xMin = left;
    target.yMin = top;
    target.xMax = right;
    target.yMax = bottom;
  } else {
    target.xMin = 0;
    target.yMin = 0;
    target.xMax = 0;
    target.yMax = 0;
  }
}
