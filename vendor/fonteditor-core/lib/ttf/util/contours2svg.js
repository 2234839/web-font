"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = contours2svg;
var _contour2svg = _interopRequireDefault(require("./contour2svg"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 将ttf字形转换为svg路径`d`
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * contours轮廓转svgpath
 *
 * @param {Array} contours 轮廓list
 * @param {number} precision 精确度
 * @return {string} path字符串
 */
function contours2svg(contours, precision) {
  if (!contours.length) {
    return '';
  }
  /** 优化293: map+join 替换为 for 循环字符串拼接，消除中间数组分配和闭包 */
  var path = '';
  for (var i = 0, l = contours.length; i < l; i++) {
    path += (0, _contour2svg.default)(contours[i], precision);
  }
  return path;
}