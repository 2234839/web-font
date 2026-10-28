/**
 * @file 计算曲线包围盒
 * @author mengke01(kekee000@gmail.com)
 *
 * modify from:
 * zrender
 * https://github.com/ecomfe/zrender/blob/master/src/tool/computeBoundingBox.js
 */
import pathIterator from "./pathIterator";

/** 路径点 */
interface PathPoint {
  /** 水平坐标 */
  x: number;
  /** 垂直坐标 */
  y: number;
  /** 是否曲线端点 */
  onCurve?: boolean;
}

/** 包围盒 */
export interface BoundBox {
  /** 水平最小值 */
  x: number;
  /** 垂直最小值 */
  y: number;
  /** 宽度 */
  width: number;
  /** 高度 */
  height: number;
}

/**
 * 计算包围盒
 */
export function computeBoundingBox(
  /** 点集 */
  points: PathPoint[]
): BoundBox | false {
  if (points.length === 0) {
    return false;
  }
  const p0 = points[0];
  let left = p0.x;
  let right = p0.x;
  let top = p0.y;
  let bottom = p0.y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < left) {
      left = p.x;
    }
    if (p.x > right) {
      right = p.x;
    }
    if (p.y < top) {
      top = p.y;
    }
    if (p.y > bottom) {
      bottom = p.y;
    }
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

/**
 * 计算二阶贝塞尔曲线的包围盒
 * http://pissang.net/blog/?p=91
 */
function computeQuadraticBezierBoundingBox(
  /** p0 */
  p0: PathPoint,
  /** p1 */
  p1: PathPoint,
  /** p2 */
  p2: PathPoint
): BoundBox | false {
  // Find extremities, where derivative in x dim or y dim is zero
  let tmp = p0.x + p2.x - 2 * p1.x;
  // p1 is center of p0 and p2 in x dim
  let t1: number;
  if (tmp === 0) {
    t1 = 0.5;
  } else {
    t1 = (p0.x - p1.x) / tmp;
  }
  tmp = p0.y + p2.y - 2 * p1.y;
  // p1 is center of p0 and p2 in y dim
  let t2: number;
  if (tmp === 0) {
    t2 = 0.5;
  } else {
    t2 = (p0.y - p1.y) / tmp;
  }
  t1 = Math.max(Math.min(t1, 1), 0);
  t2 = Math.max(Math.min(t2, 1), 0);
  const ct1 = 1 - t1;
  const ct2 = 1 - t2;
  const x1 = ct1 * ct1 * p0.x + 2 * ct1 * t1 * p1.x + t1 * t1 * p2.x;
  const y1 = ct1 * ct1 * p0.y + 2 * ct1 * t1 * p1.y + t1 * t1 * p2.y;
  const x2 = ct2 * ct2 * p0.x + 2 * ct2 * t2 * p1.x + t2 * t2 * p2.x;
  const y2 = ct2 * ct2 * p0.y + 2 * ct2 * t2 * p1.y + t2 * t2 * p2.y;
  return computeBoundingBox([p0, p2, {
    x: x1,
    y: y1
  }, {
    x: x2,
    y: y2
  }]);
}

/**
 * 计算曲线点边界（内联展开版，消除中间 points 数组和临时对象分配）
 * 直接在遍历过程中维护 left/right/top/bottom 四个边界值
 */
function computePathBoundingBox(
  /** 坐标点集，支持多个path */
  ...contours: PathPoint[][]
): BoundBox | false {
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  let found = false;

  function updateBounds(
    /** 水平坐标 */
    x: number,
    /** 垂直坐标 */
    y: number
  ): void {
    if (!found) {
      left = right = x;
      top = bottom = y;
      found = true;
    } else {
      if (x < left) left = x;
      else if (x > right) right = x;
      if (y < top) top = y;
      else if (y > bottom) bottom = y;
    }
  }

  function updateBoundsQ(p0: PathPoint, p1: PathPoint, p2: PathPoint): void {
    /* 内联二次贝塞尔包围盒计算，避免创建中间对象 */
    let tmp = p0.x + p2.x - 2 * p1.x;
    let t1 = tmp === 0 ? 0.5 : (p0.x - p1.x) / tmp;
    tmp = p0.y + p2.y - 2 * p1.y;
    let t2 = tmp === 0 ? 0.5 : (p0.y - p1.y) / tmp;
    t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
    t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
    const ct1 = 1 - t1;
    const ct2 = 1 - t2;
    /* 计算 4 个极值点: p0, p2, (t1), (t2) */
    updateBounds(p0.x, p0.y);
    updateBounds(p2.x, p2.y);
    updateBounds(ct1 * ct1 * p0.x + 2 * ct1 * t1 * p1.x + t1 * t1 * p2.x,
                 ct1 * ct1 * p0.y + 2 * ct1 * t1 * p1.y + t1 * t1 * p2.y);
    updateBounds(ct2 * ct2 * p0.x + 2 * ct2 * t2 * p1.x + t2 * t2 * p2.x,
                 ct2 * ct2 * p0.y + 2 * ct2 * t2 * p1.y + t2 * t2 * p2.y);
  }

  function processContour(contour: PathPoint[]): void {
    pathIterator(contour, (c, p0, p1, p2) => {
      if (c === "L") {
        updateBounds(p0.x, p0.y);
        updateBounds(p1.x, p1.y);
      } else if (c === "Q" && typeof p2 !== "number") {
        updateBoundsQ(p0, p1, p2);
      }
    });
  }

  for (const contour of contours) {
    processContour(contour);
  }

  if (!found) {
    return false;
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

/**
 * 计算曲线点边界（内联展开版，避免中间对象分配）
 */
export function computePathBox(
  /** path对象，支持多个path */
  ...contours: (PathPoint[] | undefined | null)[]
): BoundBox {
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  let found = false;

  for (const contour of contours) {
    if (!contour || !contour.length) continue;

    for (const p of contour) {
      if (!found) {
        left = right = p.x;
        top = bottom = p.y;
        found = true;
      } else {
        if (p.x < left) left = p.x;
        else if (p.x > right) right = p.x;
        if (p.y < top) top = p.y;
        else if (p.y > bottom) bottom = p.y;
      }
    }
  }

  if (!found) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

export { computeQuadraticBezierBoundingBox as quadraticBezier };
export { computePathBoundingBox as computePath };
export { computeBoundingBox as computeBounding };
