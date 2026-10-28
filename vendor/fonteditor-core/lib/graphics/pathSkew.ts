/**
 * @file path倾斜变换
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
 * path倾斜变换
 *
 * @param contour 坐标点
 * @param angle 角度
 * @param offsetX x偏移
 * @param offsetY y偏移
 *
 * @return contour 坐标点
 */
export default function pathSkew(
  /** 坐标点 */
  contour: PathPoint[],
  /** 角度 */
  angle?: number,
  /** x偏移 */
  offsetX?: number,
  /** y偏移 */
  offsetY?: number
): PathPoint[] {
  angle = angle === undefined ? 0 : angle;
  const x = offsetX || 0;
  const tan = Math.tan(angle);

  // x 平移
  if (x === 0) {
    for (const p of contour) {
      p.x += tan * (p.y - offsetY!);
    }
  }
  // y平移
  else {
    for (const p of contour) {
      p.y += tan * (p.x - offsetX!);
    }
  }
  return contour;
}
