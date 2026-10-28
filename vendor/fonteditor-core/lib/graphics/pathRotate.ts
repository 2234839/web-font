/**
 * @file 路径旋转
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
export default function pathRotate(
  /** 坐标点 */
  contour: PathPoint[],
  /** 角度 */
  angle?: number,
  /** x偏移 */
  centerX?: number,
  /** y偏移 */
  centerY?: number
): PathPoint[] {
  angle = angle === undefined ? 0 : angle;
  const x = centerX || 0;
  const y = centerY || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let px: number;
  let py: number;
  let p: PathPoint;

  // x1=cos(angle)*x-sin(angle)*y;
  // y1=cos(angle)*y+sin(angle)*x;
  for (let i = 0, l = contour.length; i < l; i++) {
    p = contour[i];
    px = cos * (p.x - x) - sin * (p.y - y);
    py = cos * (p.y - y) + sin * (p.x - x);
    p.x = px + x;
    p.y = py + y;
  }
  return contour;
}
