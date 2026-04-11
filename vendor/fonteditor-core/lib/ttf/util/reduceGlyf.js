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
  /* 优化66: 扁平格式下 contour.length 是点的3倍 */
  var isFlat = glyf._flatContours;
  var minLen = isFlat ? 6 : 2;
  /** 优化: 使用 writeIdx 替代 splice，O(n) 替代 O(n*m) */
  var writeIdx = 0;
  for (var j = 0, cl = contours.length; j < cl; j++) {
    var contour = (0, _reducePath.default)(contours[j]);
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