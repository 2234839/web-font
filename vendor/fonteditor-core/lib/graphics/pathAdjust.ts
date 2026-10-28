/**
 * @file 调整路径缩放和平移
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

/**
 * 对path坐标进行调整
 */
export default function pathAdjust(
  /** 坐标点 */
  contour: PathPoint[],
  /** x缩放比例 */
  scaleX?: number,
  /** y缩放比例 */
  scaleY?: number,
  /** x偏移 */
  offsetX?: number,
  /** y偏移 */
  offsetY?: number
): PathPoint[] {
  scaleX = scaleX === undefined ? 1 : scaleX;
  scaleY = scaleY === undefined ? 1 : scaleY;
  const x = offsetX || 0;
  const y = offsetY || 0;
  let p: PathPoint;
  for (let i = 0, l = contour.length; i < l; i++) {
    p = contour[i];
    p.x = scaleX * (p.x + x);
    p.y = scaleY * (p.y + y);
  }
  return contour;
}
