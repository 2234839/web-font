/**
 * @file 矩形转换成轮廓
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 矩形转换成轮廓
 *
 * @param x 左上角x
 * @param y 左上角y
 * @param width 宽度
 * @param height 高度
 * @return 轮廓数组
 */
export default function rect2contour(x: number | string, y: number | string, width: number | string, height: number | string): any[] {
  const nx = +x;
  const ny = +y;
  const nw = +width;
  const nh = +height;
  return [
    {
      x: nx,
      y: ny,
      onCurve: true
    },
    {
      x: nx + nw,
      y: ny,
      onCurve: true
    },
    {
      x: nx + nw,
      y: ny + nh,
      onCurve: true
    },
    {
      x: nx,
      y: ny + nh,
      onCurve: true
    }
  ];
}
