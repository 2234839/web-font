/**
 * @file 对轮廓进行transform变换
 * @author mengke01(kekee000@gmail.com)
 *
 * 参考资料：
 * http://blog.csdn.net/henren555/article/details/9699449
 *
 *  |X|    |a      c       e|    |x|
 *  |Y| =  |b      d       f| *  |y|
 *  |1|    |0      0       1|    |1|
 *
 *  X = x * a + y * c + e
 *  Y = x * b + y * d + f
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

/** 轮廓：对象格式或扁平格式 [x, y, onCurve, ...] */
export type Contour = PathPoint[] | number[];

/**
 * 判断轮廓是否为扁平格式
 */
function isFlatContour(contour: Contour): contour is number[] {
  /* 检测扁平格式 - 第一个元素是 number 则为扁平格式 */
  return typeof contour[0] === 'number';
}

/**
 * 图形仿射矩阵变换
 *
 * @param contour 轮廓点（对象格式或扁平格式 [x, y, onCurve, ...]）
 * @param a m11
 * @param b m12
 * @param c m21
 * @param d m22
 * @param e dx
 * @param f dy
 * @return contour 轮廓点
 */
export default function transform(
  /** 轮廓点 */
  contour: Contour,
  /** m11 */
  a: number,
  /** m12 */
  b: number,
  /** m21 */
  c: number,
  /** m22 */
  d: number,
  /** dx */
  e: number,
  /** dy */
  f: number
): Contour {
  if (!contour.length) {
    return contour;
  }

  if (isFlatContour(contour)) {
    let i = 0;
    while (i < contour.length) {
      const x = contour[i];
      const y = contour[i + 1];
      contour[i] = x * a + y * c + e;
      contour[i + 1] = x * b + y * d + f;
      i += 3;
    }
  } else {
    for (const p of contour) {
      const x = p.x;
      const y = p.y;
      p.x = x * a + y * c + e;
      p.y = x * b + y * d + f;
    }
  }
  return contour;
}
