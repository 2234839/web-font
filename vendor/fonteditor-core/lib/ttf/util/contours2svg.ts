import contour2svg from "./contour2svg";

/**
 * @file 将ttf字形转换为svg路径`d`
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * contours轮廓转svgpath
 *
 * @param contours 轮廓list
 * @param precision 精确度
 * @return path字符串
 */
export default function contours2svg(contours: any[], precision?: number): string {
  if (!contours.length) {
    return "";
  }
  /** 优化293: map+join 替换为 for 循环字符串拼接，消除中间数组分配和闭包 */
  let path = "";
  for (let i = 0, l = contours.length; i < l; i++) {
    path += contour2svg(contours[i], precision);
  }
  return path;
}
