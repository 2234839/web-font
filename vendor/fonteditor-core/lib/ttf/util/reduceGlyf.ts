import reducePath from "../../graphics/reducePath";

/**
 * @file 缩减glyf大小，去除冗余节点
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 缩减glyf，去除冗余节点
 *
 * @param glyf glyf对象
 * @return glyf对象
 */
export default function reduceGlyf(glyf: any): any {
  const contours = glyf.contours;
  /* 优化66: 扁平格式下 contour.length 是点的3倍 */
  const isFlat = glyf._flatContours;
  const minLen = isFlat ? 6 : 2;
  /** 优化: 使用 writeIdx 替代 splice，O(n) 替代 O(n*m) */
  let writeIdx = 0;
  for (let j = 0, cl = contours.length; j < cl; j++) {
    const contour = reducePath(contours[j]);
    if (contour.length > minLen) {
      contours[writeIdx++] = contour;
    }
  }
  contours.length = writeIdx;
  if (0 === writeIdx) {
    glyf.contours = null;
  }
  return glyf;
}
