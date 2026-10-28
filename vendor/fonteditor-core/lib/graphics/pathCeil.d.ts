/**
 * 路径坐标四舍五入（graphics/pathCeil.js 的类型声明）
 */
declare function pathCeil(
  /** 轮廓点数组（对象格式或扁平格式 [x, y, onCurve, ...]） */
  contour: object[],
  /** 四舍五入的小数位数 */
  point?: number
): object[];

export default pathCeil;
