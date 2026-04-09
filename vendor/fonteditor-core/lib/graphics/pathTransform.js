"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = transform;
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

/**
 * 图形仿射矩阵变换
 *
 * @param {Array} contour 轮廓点（对象格式或扁平格式 [x, y, onCurve, ...]）
 * @param {number} a m11
 * @param {number} b m12
 * @param {number} c m21
 * @param {number} d m22
 * @param {number} e dx
 * @param {number} f dy
 * @return {Array} contour 轮廓点
 */
function transform(contour, a, b, c, d, e, f) {
  if (!contour.length) {
    return contour;
  }
  /* 优化66: 检测扁平格式 - 第一个元素是 number 则为扁平格式 */
  if (typeof contour[0] === 'number') {
    for (var i = 0, l = contour.length; i < l; i += 3) {
      var x = contour[i];
      var y = contour[i + 1];
      contour[i] = x * a + y * c + e;
      contour[i + 1] = x * b + y * d + f;
    }
  } else {
    for (var i = 0, l = contour.length; i < l; i++) {
      var p = contour[i];
      var x = p.x;
      var y = p.y;
      p.x = x * a + y * c + e;
      p.y = x * b + y * d + f;
    }
  }
  return contour;
}