/**
 * @file glyf的缩放和平移调整
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 简单字形的缩放和平移调整
 *
 * @param g glyf对象
 * @param scaleX x缩放比例
 * @param scaleY y缩放比例
 * @param offsetX x偏移
 * @param offsetY y偏移
 * @param useCeil 是否对字形设置取整，默认取整
 * @return 调整后的glyf对象
 */
export default function glyfAdjust(
  g: any,
  scaleX: number = 1,
  scaleY: number = 1,
  offsetX: number = 0,
  offsetY: number = 0,
  useCeil: boolean = true
): any {
  const contours = g.contours;
  const needScale = scaleX !== 1 || scaleY !== 1;
  const needOffset = offsetX !== 0 || offsetY !== 0;
  const needCeil = useCeil !== false;
  const needTransform = needScale || needOffset || needCeil;
  /** 优化270: 合并 scale+offset+ceil 为单次点遍历，内联 computePathBox 消除 .apply() 参数展开开销 */
  const needComputeBound =
    undefined === g.xMin || undefined === g.yMax || undefined === g.leftSideBearing || undefined === g.advanceWidth;
  if (contours && contours.length) {
    if (needTransform || needComputeBound) {
      let left = 0, right = 0, top = 0, bottom = 0;
      let found = false;
      for (let ci = 0, cl = contours.length; ci < cl; ci++) {
        const contour = contours[ci];
        if (!contour || !contour.length) continue;
        for (let i = 0, l = contour.length; i < l; i++) {
          const p = contour[i];
          if (needTransform) {
            let nx = needScale ? scaleX * p.x : p.x;
            let ny = needScale ? scaleY * p.y : p.y;
            if (needOffset) {
              nx += offsetX;
              ny += offsetY;
            }
            if (needCeil) {
              nx = Math.round(nx);
              ny = Math.round(ny);
            }
            p.x = nx;
            p.y = ny;
          }
          if (needComputeBound) {
            if (!found) {
              left = right = p.x;
              top = bottom = p.y;
              found = true;
            } else {
              if (p.x < left) left = p.x;
              else if (p.x > right) right = p.x;
              if (p.y < top) top = p.y;
              else if (p.y > bottom) bottom = p.y;
            }
          }
        }
      }
      if (needComputeBound) {
        g.xMin = found ? left : 0;
        g.xMax = found ? right : 0;
        g.yMin = found ? top : 0;
        g.yMax = found ? bottom : 0;
        g.leftSideBearing = g.xMin;
        const advanceWidth = g.advanceWidth;
        if (undefined !== advanceWidth) {
          g.advanceWidth = Math.round(advanceWidth * scaleX + offsetX);
        } else {
          g.advanceWidth = found ? right + Math.abs(left) : 0;
        }
        return g;
      }
    }
  } else if (needComputeBound) {
    g.xMin = 0;
    g.xMax = 0;
    g.yMin = 0;
    g.yMax = 0;
    g.leftSideBearing = 0;
    const advanceWidth2 = g.advanceWidth;
    g.advanceWidth = undefined !== advanceWidth2 ? Math.round(advanceWidth2 * scaleX + offsetX) : 0;
    return g;
  }
  if (needComputeBound) return g;
  g.xMin = Math.round(g.xMin * scaleX + offsetX);
  g.xMax = Math.round(g.xMax * scaleX + offsetX);
  g.yMin = Math.round(g.yMin * scaleY + offsetY);
  g.yMax = Math.round(g.yMax * scaleY + offsetY);
  g.leftSideBearing = Math.round(g.leftSideBearing * scaleX + offsetX);
  g.advanceWidth = Math.round(g.advanceWidth * scaleX + offsetX);
  return g;
}
