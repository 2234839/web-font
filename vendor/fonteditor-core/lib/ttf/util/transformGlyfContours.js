"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = transformGlyfContours;
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 转换复合字形的contours，以便于显示
 * @author mengke01(kekee000@gmail.com)
 */

/** 简单字形的 ON_CURVE 位（glyFlag.ONCURVE = 0x01） */
var _ON_CURVE = 0x01;

/**
 * 从紧凑格式（_xArr/_yArr/_flags/endPtsOfContours）即时构建扁平 contours。
 *
 * 复合字形的 component 在 subset 阶段（resolveGlyf → compound2simpleglyf → 本函数）
 * 被访问时尚未经过 optimize，simple component 仅解析出紧凑坐标数据而无 contours 字段。
 * 正常 codepoint 子集不会保留无 unicode 的连字 target（compound），故不触发此路径；
 * 当 extraSubsetGids 注入连字 target（如 FiraCode 的 greater_equal.liga）时，
 * 其 component 为紧凑 simple 字形，需在此即时展开为扁平 contours 供仿射变换使用。
 *
 * 扁平格式：contour = [x0,y0,onCurve0, x1,y1,onCurve1, ...]（与 transformAndCeilFlat 一致）。
 */
function buildFlatContoursFromCompact(glyph) {
  var xArr = glyph._xArr;
  var yArr = glyph._yArr;
  var flags = glyph._flags;
  var endPts = glyph.endPtsOfContours;
  if (!xArr || !yArr || !flags || !endPts) {
    return [];
  }
  var contours = new Array(endPts.length);
  var ptStart = 0;
  for (var ci = 0, cl = endPts.length; ci < cl; ci++) {
    var ptEnd = endPts[ci];
    var ptCount = ptEnd - ptStart + 1;
    var contour = new Array(ptCount * 3);
    for (var pi = 0; pi < ptCount; pi++) {
      var pIdx = ptStart + pi;
      contour[pi * 3] = xArr[pIdx];
      contour[pi * 3 + 1] = yArr[pIdx];
      contour[pi * 3 + 2] = (flags[pIdx] & _ON_CURVE) ? 1 : 0;
    }
    contours[ci] = contour;
    ptStart = ptEnd + 1;
  }
  return contours;
}

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
    /* 紧凑 simple component（无 contours，仅有 _xArr/_yArr/_flags/endPtsOfContours）：
     * subset 阶段尚未 optimize，连字 target 的 component 需即时展开为扁平 contours。 */
    if (!sourceContours && glyph._xArr) {
      sourceContours = buildFlatContoursFromCompact(glyph);
    }
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
      /* 优化265: 浅拷贝 contour 数组 + 内联 transform+ceil，消除 deep clone 开销 */
      for (var i = 0, l = sourceContours.length; i < l; i++) {
        var srcContour = sourceContours[i];
        var newContour = new Array(srcContour.length);
        for (var pi = 0, pl = srcContour.length; pi < pl; pi++) {
          var p = srcContour[pi];
          var px = p.x * ta + p.y * tc + te;
          var py = p.x * tb + p.y * td + tf;
          newContour[pi] = { x: (px + 0.5) | 0, y: (py + 0.5) | 0, onCurve: p.onCurve };
        }
        compoundContours.push(newContour);
      }
    }
  }

  // eslint-disable-next-line eqeqeq
  if (null != glyfIndex) {
    contoursList[glyfIndex] = compoundContours;
  }
  return compoundContours;
}