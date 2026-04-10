"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = otfContours2ttfContours;
var _bezierCubic2Q = require("../../math/bezierCubic2Q2");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file otf轮廓转ttf轮廓
 * @author mengke01(kekee000@gmail.com)
 *
 * CFF Type 2 charstring 解析后的 contour 扁平格式：
 *   - [x, y, flag, x, y, flag, ...]  flag=1 onCurve, flag=0 offCurve
 *   - 每个 cubic bezier 段由 2 个 offCurve + 1 个 onCurve 组成
 *   - 连续的 offCurve 点之间，隐含端点为两者的中点
 *
 * 优化178: 全流程扁平数组，消除对象分配
 */

/** 优化178: 直接消费扁平数组 normalizeContour，返回扁平数组 */
function normalizeContourFlat(arr) {
  var len = arr.length;
  if (len < 6) return arr;

  /** 检查第一个点是否 onCurve */
  var firstOnCurve = !!(arr[2]);
  var prependX, prependY;

  if (!firstOnCurve) {
    var lastIdx = len - 3;
    var lastOnCurve = !!(arr[lastIdx + 2]);
    if (lastOnCurve) {
      prependX = arr[lastIdx];
      prependY = arr[lastIdx + 1];
    } else {
      prependX = (arr[0] + arr[lastIdx]) * 0.5;
      prependY = (arr[1] + arr[lastIdx + 1]) * 0.5;
    }
  }

  /** 检查是否有连续 offCurve 点 */
  var hasConsecutiveOff = false;
  if (!firstOnCurve) hasConsecutiveOff = true;
  else {
    for (var j = 0; j < len - 3; j += 3) {
      if (!arr[j + 2] && j + 5 < len && !arr[j + 5]) {
        hasConsecutiveOff = true;
        break;
      }
    }
    /** 也检查最后一个和第一个 */
    if (!hasConsecutiveOff && len >= 6 && !arr[len - 1] && !arr[2]) {
      hasConsecutiveOff = true;
    }
  }

  if (!hasConsecutiveOff && firstOnCurve) return arr;

  /** 构建结果：[x, y, flag, ...] */
  var result = [];
  if (prependX != null) {
    result.push(prependX, prependY, 1);
  }
  for (var k = 0; k < len; k += 3) {
    result.push(arr[k], arr[k + 1], arr[k + 2]);
    if (!arr[k + 2] && k + 5 < len && !arr[k + 5]) {
      var mx = (arr[k] + arr[k + 3]) * 0.5;
      var my = (arr[k + 1] + arr[k + 4]) * 0.5;
      result.push(mx, my, 1);
    }
  }
  /** 检查 wrap-around 连续 offCurve */
  if (prependX == null && len >= 6 && !arr[len - 1] && !arr[2]) {
    var mx2 = (arr[len - 3] + arr[0]) * 0.5;
    var my2 = (arr[len - 2] + arr[1]) * 0.5;
    result.push(mx2, my2, 1);
  }
  return result;
}

/**
 * 转换已标准化的轮廓，全扁平数组操作
 * 优化178: 输入和输出都是扁平数组 [x, y, flag, ...]
 */
function transformContourFlat(arr) {
  var normalized = normalizeContourFlat(arr);
  if (normalized.length < 6) return [];

  var contour = [];
  /** 第一个点一定是 onCurve */
  var r = Math.round;
  contour.push(r(normalized[0]), r(normalized[1]), 1);

  var i = 3;
  var nLen = normalized.length;
  var lastX = r(normalized[0]);
  var lastY = r(normalized[1]);

  while (i < nLen) {
    var isOnCurve = normalized[i + 2];
    if (isOnCurve) {
      /** 线段：直接添加 onCurve 端点 */
      var px = r(normalized[i]);
      var py = r(normalized[i + 1]);
      contour.push(px, py, 1);
      lastX = px;
      lastY = py;
      i += 3;
    } else {
      /** offCurve 点 */
      var c1x = normalized[i], c1y = normalized[i + 1];
      var nextIdx = i + 3;
      if (nextIdx < nLen && !normalized[nextIdx + 2]) {
        /** 第二个点也是 offCurve → 三次贝塞尔曲线 */
        var c2x = normalized[nextIdx], c2y = normalized[nextIdx + 1];
        var endIdx = nextIdx + 3;
        var endX, endY;
        if (endIdx < nLen) {
          endX = normalized[endIdx]; endY = normalized[endIdx + 1];
        } else {
          endX = normalized[0]; endY = normalized[1];
        }
        i = endIdx + 3;

        /** 三次→二次贝塞尔转换 */
        var bezierFlat = (0, _bezierCubic2Q.bezierCubic2Q2Raw)(lastX, lastY, c1x, c1y, c2x, c2y, endX, endY);
        for (var bi = 0, bl = bezierFlat.length; bi < bl; bi += 4) {
          contour.push(r(bezierFlat[bi]), r(bezierFlat[bi + 1]), 0);
          contour.push(r(bezierFlat[bi + 2]), r(bezierFlat[bi + 3]), 1);
        }
        lastX = r(endX);
        lastY = r(endY);
      } else {
        /** 单个 offCurve → 二次贝塞尔曲线（TTF 原生支持） */
        var endX2, endY2;
        if (nextIdx < nLen && normalized[nextIdx + 2]) {
          endX2 = normalized[nextIdx]; endY2 = normalized[nextIdx + 1];
          i = nextIdx + 3;
        } else {
          endX2 = normalized[0]; endY2 = normalized[1];
          i = nextIdx + 3;
        }
        contour.push(r(c1x), r(c1y), 0);
        contour.push(r(endX2), r(endY2), 1);
        lastX = r(endX2);
        lastY = r(endY2);
      }
    }
  }

  return contour;
}

/**
 * otf轮廓转ttf轮廓，同时计算包围盒
 * 优化178: 支持扁平数组输入 [x, y, flag, ...]，直接构建扁平数组输出
 */
function otfContours2ttfContours(otfContours) {
  if (!otfContours || !otfContours.length) {
    return { contours: otfContours };
  }
  var contours = [];
  var left, right, top, bottom;
  var found = false;
  for (var i = 0, l = otfContours.length; i < l; i++) {
    var otfContour = otfContours[i];
    if (!otfContour || otfContour.length < 6) continue;

    /** 检测输入格式：扁平数组 vs 对象数组 */
    var isFlat = otfContour._flatContours || (typeof otfContour[0] === 'number' && typeof otfContour[1] === 'number');
    var contour;
    if (isFlat) {
      contour = transformContourFlat(otfContour);
    } else {
      contour = transformContourObj(otfContour);
    }
    if (contour.length < 3) continue;
    contours.push(contour);

    /** 计算包围盒 */
    if (typeof contour[0] === 'number') {
      for (var ci = 0, cl = contour.length; ci < cl; ci += 3) {
        var px = contour[ci], py = contour[ci + 1];
        if (!found) {
          left = right = px; top = bottom = py; found = true;
        } else {
          if (px < left) left = px; else if (px > right) right = px;
          if (py < top) top = py; else if (py > bottom) bottom = py;
        }
      }
    } else {
      for (var ci2 = 0, cl2 = contour.length; ci2 < cl2; ci2++) {
        var p = contour[ci2];
        if (!found) {
          left = right = p.x; top = bottom = p.y; found = true;
        } else {
          if (p.x < left) left = p.x; else if (p.x > right) right = p.x;
          if (p.y < top) top = p.y; else if (p.y > bottom) bottom = p.y;
        }
      }
    }
  }
  return {
    contours: contours,
    xMin: left,
    yMin: top,
    xMax: right,
    yMax: bottom
  };
}

/**
 * 兼容旧对象数组格式 [onCurve, offCurve, ...]
 */
function transformContourObj(otfContour) {
  if (otfContour.length < 2) return [];

  var contour = [];
  var p0 = otfContour[0];
  contour.push({ x: p0.x + 0.5 | 0, y: p0.y + 0.5 | 0, onCurve: true });

  var i = 1;
  var nLen = otfContour.length;
  while (i < nLen) {
    var cur = otfContour[i];
    if (cur.onCurve) {
      contour.push({ x: cur.x + 0.5 | 0, y: cur.y + 0.5 | 0, onCurve: true });
      i++;
    } else {
      var c1 = cur;
      var c2 = i + 1 < nLen ? otfContour[i + 1] : null;
      var end;

      if (c2 && !c2.onCurve) {
        end = i + 2 < nLen ? otfContour[i + 2] : otfContour[0];
        i += 3;
      } else if (c2 && c2.onCurve) {
        end = c2;
        i += 2;
      } else {
        end = otfContour[0];
        i++;
      }

      var bezierFlat = (0, _bezierCubic2Q.default)(contour[contour.length - 1], c1, c2 || c1, end);
      for (var bi = 0, bl = bezierFlat.length; bi < bl; bi += 4) {
        contour.push({ x: bezierFlat[bi] + 0.5 | 0, y: bezierFlat[bi + 1] + 0.5 | 0 });
        contour.push({ x: bezierFlat[bi + 2] + 0.5 | 0, y: bezierFlat[bi + 3] + 0.5 | 0, onCurve: true });
      }
    }
  }

  return contour;
}
