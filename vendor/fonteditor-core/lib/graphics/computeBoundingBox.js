"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.computePath = exports.computeBounding = void 0;
exports.computePathBox = computePathBox;
exports.quadraticBezier = void 0;
var _pathIterator = _interopRequireDefault(require("./pathIterator"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 计算曲线包围盒
 * @author mengke01(kekee000@gmail.com)
 *
 * modify from:
 * zrender
 * https://github.com/ecomfe/zrender/blob/master/src/tool/computeBoundingBox.js
 */

/**
 * 计算包围盒
 *
 * @param {Array} points 点集
 * @return {Object} bounding box
 */
function computeBoundingBox(points) {
  if (points.length === 0) {
    return false;
  }
  var p0 = points[0];
  var left = p0.x;
  var right = p0.x;
  var top = p0.y;
  var bottom = p0.y;
  for (var i = 1; i < points.length; i++) {
    var p = points[i];
    if (p.x < left) {
      left = p.x;
    }
    if (p.x > right) {
      right = p.x;
    }
    if (p.y < top) {
      top = p.y;
    }
    if (p.y > bottom) {
      bottom = p.y;
    }
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

/**
 * 计算二阶贝塞尔曲线的包围盒
 * http://pissang.net/blog/?p=91
 *
 * @param {Object} p0 p0
 * @param {Object} p1 p1
 * @param {Object} p2 p2
 * @return {Object} bound对象
 */
function computeQuadraticBezierBoundingBox(p0, p1, p2) {
  // Find extremities, where derivative in x dim or y dim is zero
  var tmp = p0.x + p2.x - 2 * p1.x;
  // p1 is center of p0 and p2 in x dim
  var t1;
  if (tmp === 0) {
    t1 = 0.5;
  } else {
    t1 = (p0.x - p1.x) / tmp;
  }
  tmp = p0.y + p2.y - 2 * p1.y;
  // p1 is center of p0 and p2 in y dim
  var t2;
  if (tmp === 0) {
    t2 = 0.5;
  } else {
    t2 = (p0.y - p1.y) / tmp;
  }
  t1 = Math.max(Math.min(t1, 1), 0);
  t2 = Math.max(Math.min(t2, 1), 0);
  var ct1 = 1 - t1;
  var ct2 = 1 - t2;
  var x1 = ct1 * ct1 * p0.x + 2 * ct1 * t1 * p1.x + t1 * t1 * p2.x;
  var y1 = ct1 * ct1 * p0.y + 2 * ct1 * t1 * p1.y + t1 * t1 * p2.y;
  var x2 = ct2 * ct2 * p0.x + 2 * ct2 * t2 * p1.x + t2 * t2 * p2.x;
  var y2 = ct2 * ct2 * p0.y + 2 * ct2 * t2 * p1.y + t2 * t2 * p2.y;
  return computeBoundingBox([p0, p2, {
    x: x1,
    y: y1
  }, {
    x: x2,
    y: y2
  }]);
}

/**
 * 计算曲线包围盒
 *
 * @private
 * @param {...Array} args 坐标点集, 支持多个path
 * @return {Object} {x, y, width, height}
 */
/**
 * 优化: 内联展开 computePathBoundingBox，消除中间 points 数组和临时对象分配
 * 直接在遍历过程中维护 left/right/top/bottom 四个边界值
 */
function computePathBoundingBox() {
  var left, right, top, bottom;
  var found = false;

  function updateBounds(x, y) {
    if (!found) {
      left = right = x;
      top = bottom = y;
      found = true;
    } else {
      if (x < left) left = x;
      else if (x > right) right = x;
      if (y < top) top = y;
      else if (y > bottom) bottom = y;
    }
  }

  function updateBoundsQ(p0, p1, p2) {
    /* 内联二次贝塞尔包围盒计算，避免创建中间对象 */
    var tmp = p0.x + p2.x - 2 * p1.x;
    var t1 = tmp === 0 ? 0.5 : (p0.x - p1.x) / tmp;
    tmp = p0.y + p2.y - 2 * p1.y;
    var t2 = tmp === 0 ? 0.5 : (p0.y - p1.y) / tmp;
    t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
    t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
    var ct1 = 1 - t1;
    var ct2 = 1 - t2;
    /* 计算 4 个极值点: p0, p2, (t1), (t2) */
    updateBounds(p0.x, p0.y);
    updateBounds(p2.x, p2.y);
    updateBounds(ct1 * ct1 * p0.x + 2 * ct1 * t1 * p1.x + t1 * t1 * p2.x,
                 ct1 * ct1 * p0.y + 2 * ct1 * t1 * p1.y + t1 * t1 * p2.y);
    updateBounds(ct2 * ct2 * p0.x + 2 * ct2 * t2 * p1.x + t2 * t2 * p2.x,
                 ct2 * ct2 * p0.y + 2 * ct2 * t2 * p1.y + t2 * t2 * p2.y);
  }

  function processContour(contour) {
    (0, _pathIterator.default)(contour, function (c, p0, p1, p2) {
      if (c === 'L') {
        updateBounds(p0.x, p0.y);
        updateBounds(p1.x, p1.y);
      } else if (c === 'Q') {
        updateBoundsQ(p0, p1, p2);
      }
    });
  }

  if (arguments.length === 1) {
    processContour(arguments[0]);
  } else {
    for (var i = 0, l = arguments.length; i < l; i++) {
      processContour(arguments[i]);
    }
  }

  if (!found) {
    return false;
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

/**
 * 计算曲线点边界（内联展开版，避免中间对象分配）
 *
 * @private
 * @param {...Array} args path对象, 支持多个path
 * @return {Object} {x, y, width, height}
 */
function computePathBox() {
  var left, right, top, bottom;
  var found = false;

  for (var a = 0; a < arguments.length; a++) {
    var contour = arguments[a];
    if (!contour || !contour.length) continue;

    for (var i = 0, l = contour.length; i < l; i++) {
      var p = contour[i];
      if (!found) {
        left = right = p.x;
        top = bottom = p.y;
        found = true;
      } else {
        if (p.x < left) left = p.x;
        else if (p.x > right) right = p.x;
        if (p.y < top) top = p.y;
        else if (p.y > bottom) bottom = p.y;
      }
    }
  }

  if (!found) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}
var computeBounding = exports.computeBounding = computeBoundingBox;
var quadraticBezier = exports.quadraticBezier = computeQuadraticBezierBoundingBox;
var computePath = exports.computePath = computePathBoundingBox;