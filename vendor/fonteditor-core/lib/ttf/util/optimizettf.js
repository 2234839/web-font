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
  var checkUnicodeRepeat = {}; // 检查是否有重复代码点
  var repeatList = [];
  ttf.glyf.forEach(function (glyf, index) {
    if (glyf.unicode) {
      glyf.unicode = glyf.unicode.sort();

      // 将glyf的代码点按小到大排序
      glyf.unicode.sort(function (a, b) {
        return a - b;
      }).forEach(function (u) {
        if (checkUnicodeRepeat[u]) {
          repeatList.push(index);
        } else {
          checkUnicodeRepeat[u] = true;
        }
      });
    }
    if (!glyf.compound && glyf.contours) {
      if (glyf._flatContours) {
        /* 优化17+66: 扁平格式单次遍历 pathCeil + reduceGlyf */
        ceilAndReduceFlat(glyf);
      } else {
        /* 整数化 */
        glyf.contours.forEach(function (contour) {
          (0, _pathCeil.default)(contour);
        });
        /* 缩减glyf */
        (0, _reduceGlyf.default)(glyf);
      }
    }

    // 整数化
    glyf.xMin = Math.round(glyf.xMin || 0);
    glyf.xMax = Math.round(glyf.xMax || 0);
    glyf.yMin = Math.round(glyf.yMin || 0);
    glyf.yMax = Math.round(glyf.yMax || 0);
    glyf.leftSideBearing = Math.round(glyf.leftSideBearing || 0);
    glyf.advanceWidth = Math.round(glyf.advanceWidth || 0);
  });

  // 过滤无轮廓字体，如果存在复合字形不进行过滤
  if (!ttf.glyf.some(function (a) {
    return a.compound;
  })) {
    ttf.glyf = ttf.glyf.filter(function (glyf, index) {
      return index === 0 || glyf.contours && glyf.contours.length;
    });
  }
  if (!repeatList.length) {
    return true;
  }
  return {
    repeat: repeatList
  };
}