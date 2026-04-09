"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = reduceGlyf;
var _reducePath = _interopRequireDefault(require("../../graphics/reducePath"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 缩减glyf大小，去除冗余节点
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 缩减glyf，去除冗余节点
 *
 * @param {Object} glyf glyf对象
 * @return {Object} glyf对象
 */
function reduceGlyf(glyf) {
  var contours = glyf.contours;
  var contour;
  /* 优化66: 扁平格式下 contour.length 是点的3倍 */
  var isFlat = glyf._flatContours;
  var minLen = isFlat ? 6 : 2;
  for (var j = contours.length - 1; j >= 0; j--) {
    contour = (0, _reducePath.default)(contours[j]);

    /* 空轮廓：扁平格式 <= 6 元素（2个点），对象格式 <= 2 个点 */
    if (contour.length <= minLen) {
      contours.splice(j, 1);
      continue;
    }
  }
  if (0 === glyf.contours.length) {
    delete glyf.contours;
  }
  return glyf;
}