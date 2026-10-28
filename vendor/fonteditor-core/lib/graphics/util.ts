/**
 * @file grahpics点相关工具箱
 * @author mengke01(kekee000@gmail.com)
 */

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
interface BoundBox {
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
 * 将点进行误差舍入
 *
 * @param p 点对象
 * @return 点
 */
export function ceilPoint(
  /** 点对象 */
  p: PathPoint
): PathPoint {
  let t = p.x;

  // 处理形如 4.99999 = 5, 5.00001 = 5的情况
  if (Math.abs(Math.round(t) - t) < 0.00002) {
    p.x = Math.round(t);
  } else {
    p.x = Math.round(p.x * 100000) / 100000;
  }

  t = p.y;
  if (Math.abs(Math.round(t) - t) < 0.00005) {
    p.y = Math.round(t);
  } else {
    p.y = Math.round(p.y * 100000) / 100000;
  }

  return p;
}

/**
 * 将数值进行误差舍入
 *
 * @param x 数值
 * @return 点
 */
export function ceil(
  /** 数值 */
  x: number
): number {
  if (Math.abs(Math.round(x) - x) < 0.00002) {
    return Math.round(x);
  }
  return Math.round(x * 100000) / 100000;
}

/**
 * 判断点是否在bounding box内部
 *
 * @param bound bounding box对象
 * @param p 点对象
 * @param fixed 是否四舍五入
 * @return 是否
 */
export function isPointInBound(
  /** bounding box对象 */
  bound: BoundBox,
  /** 点对象 */
  p: PathPoint,
  /** 是否四舍五入 */
  fixed?: boolean
): boolean {
  if (fixed) {
    return (
      ceil(p.x) <= ceil(bound.x + bound.width) &&
      ceil(p.x) >= ceil(bound.x) &&
      ceil(p.y) <= ceil(bound.y + bound.height) &&
      ceil(p.y) >= ceil(bound.y)
    );
  }
  return (
    p.x <= bound.x + bound.width &&
    p.x >= bound.x &&
    p.y <= bound.y + bound.height &&
    p.y >= bound.y
  );
}

/**
 * 判断点是否重合
 *
 * @param p0 p0
 * @param p1 p1
 * @return 是否
 */
export function isPointOverlap(
  /** p0 */
  p0: PathPoint,
  /** p1 */
  p1: PathPoint
): boolean {
  return ceil(p0.x) === ceil(p1.x) && ceil(p0.y) === ceil(p1.y);
}

/**
 * 获取点的hash值
 *
 * @param p p
 * @return 哈希值
 */
export function getPointHash(
  /** p */
  p: PathPoint
): number {
  return Math.floor(7 * Math.floor(p.x * 10) + 131 * Math.floor(p.y * 100));
}
