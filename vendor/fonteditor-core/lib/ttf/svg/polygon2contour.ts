import parseParams from "./parseParams";

/**
 * @file 多边形转换成轮廓
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 多边形转换成轮廓
 *
 * @param points 多边形点集合
 * @return contours
 */
export default function polygon2contour(points: string): any[] | null {
  if (!points || !points.length) {
    return null;
  }
  const contours: any[] = [];
  const segments = parseParams(points);
  for (let i = 0, l = segments.length; i < l; i += 2) {
    contours.push({
      x: segments[i],
      y: segments[i + 1],
      onCurve: true
    });
  }
  return contours;
}
