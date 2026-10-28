/**
 * 路径坐标缩放和平移（graphics/pathAdjust.js 的类型声明）
 */
declare function pathAdjust(
  /** 轮廓点数组 */
  contour: object[],
  /** x 缩放比例 */
  scaleX?: number,
  /** y 缩放比例 */
  scaleY?: number,
  /** x 偏移 */
  offsetX?: number,
  /** y 偏移 */
  offsetY?: number
): object[];

export default pathAdjust;
