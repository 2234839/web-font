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
 * 优化15+66+197: 扁平格式单次遍历 pathTransform + pathCeil
 * 优化197: 使用 +0.5|0 替代 Math.round，避免函数调用开销
 */
function transformAndCeilFlat(contour, a, b, c, d, e, f) {
  for (var i = 0, l = contour.length; i < l; i += 3) {
    var x = contour[i];
    var y = contour[i + 1];
    contour[i] = (x * a + y * c + e + 0.5) | 0;
    contour[i + 1] = (x * b + y * d + f + 0.5) | 0;
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
  /* 优化: forEach → for 循环，消除闭包分配 */
  var glyfs = glyf.glyfs;
  for (var gi = 0, gl = glyfs.length; gi < gl; gi++) {
    var g = glyfs[gi];
    var glyph = ttf.glyf[g.glyphIndex];
    if (!glyph || glyph === glyf) {
      continue;
    }

    // 递归转换contours
    if (glyph.compound && !contoursList[g.glyphIndex]) {
      transformGlyfContours(glyph, ttf, contoursList, g.glyphIndex);
    }

    var sourceContours = glyph.compound ? contoursList[g.glyphIndex] || [] : glyph.contours;
    /* 优化259: 提升 transform 属性到局部变量，消除每次迭代的属性链查找 */
    var t = g.transform;
    var ta = t.a, tb = t.b, tc = t.c, td = t.d, te = t.e, tf = t.f;

    if (sourceContours.length && typeof sourceContours[0][0] === 'number') {
      /* 优化14+15+66: 扁平格式 - 浅拷贝 + 单次遍历 transform+ceil */
      for (var i = 0, l = sourceContours.length; i < l; i++) {
        var contour = sourceContours[i].slice();
        compoundContours.push(transformAndCeilFlat(contour, ta, tb, tc, td, te, tf));
      }
    } else {
      /* 传统对象格式 - 深拷贝 + 分别调用 transform+ceil */
      var contours = (0, _lang.clone)(sourceContours);
      for (var i = 0, l = contours.length; i < l; i++) {
        (0, _pathTransform.default)(contours[i], ta, tb, tc, td, te, tf);
        compoundContours.push((0, _pathCeil.default)(contours[i]));
      }
    }
  }

  // eslint-disable-next-line eqeqeq
  if (null != glyfIndex) {
    contoursList[glyfIndex] = compoundContours;
  }
  return compoundContours;
}