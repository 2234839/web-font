"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = optimizettf;
var _reduceGlyf = _interopRequireDefault(require("./reduceGlyf"));
var _pathCeil = _interopRequireDefault(require("../../graphics/pathCeil"));
var _reducePathFlat = _interopRequireDefault(require("../../graphics/reducePathFlat"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 对ttf对象进行优化，查找错误，去除冗余点
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化17+66: 扁平格式单次遍历 pathCeil + reducePath
 * 先四舍五入坐标，再去除冗余点，一次循环完成
 */
function ceilAndReduceFlat(glyf) {
  var contours = glyf.contours;
  for (var j = contours.length - 1; j >= 0; j--) {
    var contour = contours[j];
    /* 先原地四舍五入 */
    for (var i = 0, l = contour.length; i < l; i += 3) {
      contour[i] = Math.round(contour[i]);
      contour[i + 1] = Math.round(contour[i + 1]);
    }
    /* 再去除冗余点 */
    contour = (0, _reducePathFlat.default)(contour);
    /* 空轮廓：扁平格式 <= 6 元素（2个点） */
    if (contour.length <= 6) {
      contours.splice(j, 1);
    } else {
      contours[j] = contour;
    }
  }
  if (0 === contours.length) {
    delete glyf.contours;
  }
  return glyf;
}

/**
 * 对ttf对象进行优化
 *
 * @param  {Object} ttf ttf对象
 * @return {true|Object} 错误信息
 */
function optimizettf(ttf) {
  var checkUnicodeRepeat = {};
  var repeatList = [];
  /* 优化2+45+62: for 循环替代 forEach，只对 length>1 的 unicode 排序 */
  var glyfs = ttf.glyf;
  for (var index = 0, gl = glyfs.length; index < gl; index++) {
    var glyf = glyfs[index];
    if (glyf.unicode) {
      /* 优化2: 删除第一次默认排序，只保留数字排序 */
      if (glyf.unicode.length > 1) {
        glyf.unicode.sort(function (a, b) { return a - b; });
      }
      var unicode = glyf.unicode;
      for (var ui = 0, ul = unicode.length; ui < ul; ui++) {
        var u = unicode[ui];
        if (checkUnicodeRepeat[u]) {
          repeatList.push(index);
        } else {
          checkUnicodeRepeat[u] = true;
        }
      }
    }
    if (!glyf.compound && glyf.contours) {
      if (glyf._flatContours) {
        ceilAndReduceFlat(glyf);
      } else {
        glyf.contours.forEach(function (contour) {
          (0, _pathCeil.default)(contour);
        });
        (0, _reduceGlyf.default)(glyf);
      }
    }

    glyf.xMin = Math.round(glyf.xMin || 0);
    glyf.xMax = Math.round(glyf.xMax || 0);
    glyf.yMin = Math.round(glyf.yMin || 0);
    glyf.yMax = Math.round(glyf.yMax || 0);
    glyf.leftSideBearing = Math.round(glyf.leftSideBearing || 0);
    glyf.advanceWidth = Math.round(glyf.advanceWidth || 0);
  }

  /* 过滤无轮廓字体 */
  var hasCompound = false;
  for (var fi = 0, fl = glyfs.length; fi < fl; fi++) {
    if (glyfs[fi].compound) { hasCompound = true; break; }
  }
  if (!hasCompound) {
    var filtered = [glyfs[0]];
    for (var gi = 1; gi < gl; gi++) {
      if (glyfs[gi].contours && glyfs[gi].contours.length) {
        filtered.push(glyfs[gi]);
      }
    }
    ttf.glyf = filtered;
  }
  if (!repeatList.length) {
    return true;
  }
  return {
    repeat: repeatList
  };
}