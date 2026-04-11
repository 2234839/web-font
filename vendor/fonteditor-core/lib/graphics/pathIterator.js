"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = pathIterator;
/**
 * @file 遍历路径的路径集合，包括segment和 bezier curve
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 遍历路径的路径集合，包括segment和 bezier curve
 *
 * @param {Array} contour 坐标点集
 * @param {Function} callBack 回调函数，参数集合：command, p0, p1, p2, i
 * p0, p1, p2 直线或者贝塞尔曲线参数
 * i 当前遍历的点
 * 其中command = L 或者 Q，表示直线或者贝塞尔曲线
 */
function pathIterator(contour, callBack) {
  var curPoint;
  var prevPoint;
  var nextPoint;
  var cursorPoint; // cursorPoint 为当前单个绘制命令的起点

  /* 优化: 复用临时对象，避免每次分配 */
  var tmpPoint = { x: 0, y: 0 };

  for (var i = 0, l = contour.length; i < l; i++) {
    curPoint = contour[i];
    prevPoint = i === 0 ? contour[l - 1] : contour[i - 1];
    nextPoint = i === l - 1 ? contour[0] : contour[i + 1];

    // 起始坐标
    if (i === 0) {
      if (curPoint.onCurve) {
        cursorPoint = curPoint;
      } else if (prevPoint.onCurve) {
        cursorPoint = prevPoint;
      } else {
        tmpPoint.x = (prevPoint.x + curPoint.x) * 0.5;
        tmpPoint.y = (prevPoint.y + curPoint.y) * 0.5;
        cursorPoint = tmpPoint;
      }
    }

    // 直线
    if (curPoint.onCurve && nextPoint.onCurve) {
      if (false === callBack('L', curPoint, nextPoint, 0, i)) {
        break;
      }
      cursorPoint = nextPoint;
    } else if (!curPoint.onCurve) {
      if (nextPoint.onCurve) {
        if (false === callBack('Q', cursorPoint, curPoint, nextPoint, i)) {
          break;
        }
        cursorPoint = nextPoint;
      } else {
        tmpPoint.x = (curPoint.x + nextPoint.x) * 0.5;
        tmpPoint.y = (curPoint.y + nextPoint.y) * 0.5;
        if (false === callBack('Q', cursorPoint, curPoint, tmpPoint, i)) {
          break;
        }
        cursorPoint = tmpPoint;
      }
    }
  }
}
