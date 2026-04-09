"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = transformGlyfContours;
var _pathCeil = _interopRequireDefault(require("../../graphics/pathCeil"));
var _pathTransform = _interopRequireDefault(require("../../graphics/pathTransform"));
var _lang = require("../../common/lang");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 转换复合字形的contours，以便于显示
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化15+66: 扁平格式单次遍历 pathTransform + pathCeil
 * 先仿射变换坐标，再四舍五入，一次循环完成
 */
function transformAndCeilFlat(contour, a, b, c, d, e, f) {
  for (var i = 0, l = contour.length; i < l; i += 3) {
    var x = contour[i];
    var y = contour[i + 1];
    contour[i] = Math.round(x * a + y * c + e);
    contour[i + 1] = Math.round(x * b + y * d + f);
  }
  return contour;
}

/**
 * 转换复合字形轮廓，结果保存在contoursList中，并返回当前glyf的轮廓
 *
 * @param  {Object} glyf glyf对象
 * @param  {Object} ttf ttfObject对象
 * @param  {Object=} contoursList 保存转换中间生成的contours
 * @param  {number} glyfIndex glyf对象当前的index
 * @return {Array} 转换后的轮廓
 */
function transformGlyfContours(glyf, ttf) {
  var contoursList = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  var glyfIndex = arguments.length > 3 ? arguments[3] : undefined;
  if (!glyf.glyfs) {
    return glyf;
  }
  var compoundContours = [];
  glyf.glyfs.forEach(function (g) {
    var glyph = ttf.glyf[g.glyphIndex];
    if (!glyph || glyph === glyf) {
      return;
    }

    // 递归转换contours
    if (glyph.compound && !contoursList[g.glyphIndex]) {
      transformGlyfContours(glyph, ttf, contoursList, g.glyphIndex);
    }

    var sourceContours = glyph.compound ? contoursList[g.glyphIndex] || [] : glyph.contours;
    var transform = g.transform;

    if (sourceContours.length && typeof sourceContours[0][0] === 'number') {
      /* 优化14+15+66: 扁平格式 - 浅拷贝 + 单次遍历 transform+ceil */
      for (var i = 0, l = sourceContours.length; i < l; i++) {
        var contour = sourceContours[i].slice();
        compoundContours.push(transformAndCeilFlat(contour, transform.a, transform.b, transform.c, transform.d, transform.e, transform.f));
      }
    } else {
      /* 传统对象格式 - 深拷贝 + 分别调用 transform+ceil */
      var contours = (0, _lang.clone)(sourceContours);
      for (var i = 0, l = contours.length; i < l; i++) {
        (0, _pathTransform.default)(contours[i], transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
        compoundContours.push((0, _pathCeil.default)(contours[i]));
      }
    }
  });

  // eslint-disable-next-line eqeqeq
  if (null != glyfIndex) {
    contoursList[glyfIndex] = compoundContours;
  }
  return compoundContours;
}