"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = pathCeil;
/**
 * @file 对路径进行四舍五入
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 对path坐标进行调整
 *
 * @param {Array} contour 轮廓点数组（对象格式或扁平格式 [x, y, onCurve, ...]）
 * @param {number} point 四舍五入的点数
 * @return {Object} contour 坐标点
 */
function pathCeil(contour, point) {
  if (!contour.length) {
    return contour;
  }
  /* 优化66: 检测扁平格式 - 第一个元素是 number 则为扁平格式 */
  if (typeof contour[0] === 'number') {
    for (var i = 0, l = contour.length; i < l; i += 3) {
      if (!point) {
        contour[i] = Math.round(contour[i]);
        contour[i + 1] = Math.round(contour[i + 1]);
      } else {
        contour[i] = Number(contour[i].toFixed(point));
        contour[i + 1] = Number(contour[i + 1].toFixed(point));
      }
    }
  } else {
    for (var i = 0, l = contour.length; i < l; i++) {
      var p = contour[i];
      if (!point) {
        p.x = Math.round(p.x);
        p.y = Math.round(p.y);
      } else {
        p.x = Number(p.x.toFixed(point));
        p.y = Number(p.y.toFixed(point));
      }
    }
  }
  return contour;
}