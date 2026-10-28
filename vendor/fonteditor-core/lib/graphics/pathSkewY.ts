/**
 * @file 按Y轴平移变换, 变换中心为图像中心点
 * @author mengke01(kekee000@gmail.com)
 */
import { computePath } from "./computeBoundingBox";

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
 *
 * @return contour 坐标点
 */
export default function pathSkewY(
  /** 坐标点 */
  contour: PathPoint[],
  /** 角度 */
  angle?: number
): PathPoint[] {
  angle = angle === undefined ? 0 : angle;
  const bound = computePath(contour);
  if (!bound) {
    return contour;
  }
  const x = bound.x;
  const tan = Math.tan(angle);

  // y 平移
  for (const p of contour) {
    p.y += tan * (p.x - x);
  }
  return contour;
}
