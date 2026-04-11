"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = bezierCubic2Q2;
exports.bezierCubic2Q2Raw = bezierCubic2Q2Raw;
exports.bezierCubic2Q2Push = bezierCubic2Q2Push;
exports.bezierCubic2Q2PushRounded = bezierCubic2Q2PushRounded;
/**
 * @file 三次贝塞尔转二次贝塞尔（高精度递归分割版）
 * @author mengke01(kekee000@gmail.com)
 *
 * 改进：递归分割三次贝塞尔直到可精确近似，提高 SSIM
 * 优化160+179: 返回扁平数组 [cx, cy, ex, ey, ...]，减少对象分配
 * 优化179: 新增 bezierCubic2Q2Raw 接受原始坐标参数，消除调用方对象分配
 * 优化184: 内联 isFlatEnough 到 cubicToQuadsPush，消除递归中每次分割的函数调用开销
 * 优化197: cubicToQuadsPush 使用索引赋值替代 push，支持预分配数组
 */

var MAX_DEPTH = 8;
var FLAT_THRESHOLD = 0.0625;

/**
 * 优化160+179: 直接构建扁平数组 [cx, cy, ex, ey, ...]
 * 每个二次贝塞尔段占 4 个元素：控制点 x,y + 端点 x,y
 */
/** 优化184: 内联 isFlatEnough */
function cubicToQuads(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, depth, result) {
  if (depth >= MAX_DEPTH) {
    result.push(
      (3 * c2x - p2x + 3 * c1x - p1x) * 0.25,
      (3 * c2y - p2y + 3 * c1y - p1y) * 0.25,
      p2x,
      p2y
    );
    return;
  }
  var ux = 3 * c1x - 2 * p1x - p2x;
  var uy = 3 * c1y - 2 * p1y - p2y;
  var vx = 3 * c2x - 2 * p2x - p1x;
  var vy = 3 * c2y - 2 * p2y - p1y;
  var d1 = ux * ux + uy * uy;
  var d2 = vx * vx + vy * vy;
  if (d1 <= FLAT_THRESHOLD && d2 <= FLAT_THRESHOLD) {
    result.push(
      (3 * c2x - p2x + 3 * c1x - p1x) * 0.25,
      (3 * c2y - p2y + 3 * c1y - p1y) * 0.25,
      p2x,
      p2y
    );
    return;
  }

  var m01x = (p1x + c1x) * 0.5, m01y = (p1y + c1y) * 0.5;
  var m12x = (c1x + c2x) * 0.5, m12y = (c1y + c2y) * 0.5;
  var m23x = (c2x + p2x) * 0.5, m23y = (c2y + p2y) * 0.5;
  var m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  var m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  var midx = (m012x + m123x) * 0.5, midy = (m012y + m123y) * 0.5;

  cubicToQuads(p1x, p1y, m01x, m01y, m012x, m012y, midx, midy, depth + 1, result);
  cubicToQuads(midx, midy, m123x, m123y, m23x, m23y, p2x, p2y, depth + 1, result);
}

/**
 * 优化179: 接受原始坐标参数，消除调用方临时对象分配
 * 返回扁平数组: [ctrlX, ctrlY, endX, endY, ctrlX, ctrlY, endX, endY, ...]
 */
function bezierCubic2Q2Raw(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y) {
  if (p1x === c1x && p1y === c1y && c2x === p2x && c2y === p2y) {
    return [
      (p1x + p2x) * 0.5,
      (p1y + p2y) * 0.5,
      p2x,
      p2y
    ];
  }

  var result = [];
  cubicToQuads(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, 0, result);
  return result;
}

/**
 * 优化197: 使用索引赋值替代 push，支持预分配数组
 * 每段写入 6 个元素: [ctrlX, ctrlY, 0, endX, endY, 1]（兼容 contour 扁平格式）
 * 返回写入后的索引位置
 */
function bezierCubic2Q2Push(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, contour, ci) {
  if (p1x === c1x && p1y === c1y && c2x === p2x && c2y === p2y) {
    contour[ci++] = (p1x + p2x) * 0.5;
    contour[ci++] = (p1y + p2y) * 0.5;
    contour[ci++] = 0;
    contour[ci++] = p2x;
    contour[ci++] = p2y;
    contour[ci++] = 1;
    return ci;
  }
  return cubicToQuadsPush(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, 0, contour, ci);
}

/** 优化255: 取整版 bezierCubic2Q2Push，写入时直接 Math.round，消除调用方二次遍历 */
function bezierCubic2Q2PushRounded(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, contour, ci) {
  if (p1x === c1x && p1y === c1y && c2x === p2x && c2y === p2y) {
    contour[ci++] = ((p1x + p2x) * 0.25 + 0.5) | 0;
    contour[ci++] = ((p1y + p2y) * 0.25 + 0.5) | 0;
    contour[ci++] = 0;
    contour[ci++] = (p2x + 0.5) | 0;
    contour[ci++] = (p2y + 0.5) | 0;
    contour[ci++] = 1;
    return ci;
  }
  return cubicToQuadsPushRounded(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, 0, contour, ci);
}

function cubicToQuadsPushRounded(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, depth, contour, ci) {
  if (depth >= MAX_DEPTH) {
    var qx = (3 * (c1x + c2x) - p1x - p2x) * 0.25;
    var qy = (3 * (c1y + c2y) - p1y - p2y) * 0.25;
    contour[ci++] = (qx + 0.5) | 0;
    contour[ci++] = (qy + 0.5) | 0;
    contour[ci++] = 0;
    contour[ci++] = (p2x + 0.5) | 0;
    contour[ci++] = (p2y + 0.5) | 0;
    contour[ci++] = 1;
    return ci;
  }
  var ux = 3 * c1x - 2 * p1x - p2x;
  var uy = 3 * c1y - 2 * p1y - p2y;
  var vx = 3 * c2x - 2 * p2x - p1x;
  var vy = 3 * c2y - 2 * p2y - p1y;
  var d1 = ux * ux + uy * uy;
  var d2 = vx * vx + vy * vy;
  if (d1 <= FLAT_THRESHOLD && d2 <= FLAT_THRESHOLD) {
    var qx2 = (3 * (c1x + c2x) - p1x - p2x) * 0.25;
    var qy2 = (3 * (c1y + c2y) - p1y - p2y) * 0.25;
    contour[ci++] = (qx2 + 0.5) | 0;
    contour[ci++] = (qy2 + 0.5) | 0;
    contour[ci++] = 0;
    contour[ci++] = (p2x + 0.5) | 0;
    contour[ci++] = (p2y + 0.5) | 0;
    contour[ci++] = 1;
    return ci;
  }

  var m01x = (p1x + c1x) * 0.5, m01y = (p1y + c1y) * 0.5;
  var m12x = (c1x + c2x) * 0.5, m12y = (c1y + c2y) * 0.5;
  var m23x = (c2x + p2x) * 0.5, m23y = (c2y + p2y) * 0.5;
  var m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  var m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  var midx = (m012x + m123x) * 0.5, midy = (m012y + m123y) * 0.5;

  ci = cubicToQuadsPushRounded(p1x, p1y, m01x, m01y, m012x, m012y, midx, midy, depth + 1, contour, ci);
  ci = cubicToQuadsPushRounded(midx, midy, m123x, m123y, m23x, m23y, p2x, p2y, depth + 1, contour, ci);
  return ci;
}

/** 优化184+197: 内联 isFlatEnough，索引赋值替代 push */
function cubicToQuadsPush(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, depth, contour, ci) {
  if (depth >= MAX_DEPTH) {
    contour[ci++] = (3 * (c1x + c2x) - p1x - p2x) * 0.25;
    contour[ci++] = (3 * (c1y + c2y) - p1y - p2y) * 0.25;
    contour[ci++] = 0;
    contour[ci++] = p2x;
    contour[ci++] = p2y;
    contour[ci++] = 1;
    return ci;
  }
  /* 内联 isFlatEnough 判断，短路比较替代 Math.max */
  var ux = 3 * c1x - 2 * p1x - p2x;
  var uy = 3 * c1y - 2 * p1y - p2y;
  var vx = 3 * c2x - 2 * p2x - p1x;
  var vy = 3 * c2y - 2 * p2y - p1y;
  var d1 = ux * ux + uy * uy;
  var d2 = vx * vx + vy * vy;
  if (d1 <= FLAT_THRESHOLD && d2 <= FLAT_THRESHOLD) {
    contour[ci++] = (3 * (c1x + c2x) - p1x - p2x) * 0.25;
    contour[ci++] = (3 * (c1y + c2y) - p1y - p2y) * 0.25;
    contour[ci++] = 0;
    contour[ci++] = p2x;
    contour[ci++] = p2y;
    contour[ci++] = 1;
    return ci;
  }

  var m01x = (p1x + c1x) * 0.5, m01y = (p1y + c1y) * 0.5;
  var m12x = (c1x + c2x) * 0.5, m12y = (c1y + c2y) * 0.5;
  var m23x = (c2x + p2x) * 0.5, m23y = (c2y + p2y) * 0.5;
  var m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  var m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  var midx = (m012x + m123x) * 0.5, midy = (m012y + m123y) * 0.5;

  ci = cubicToQuadsPush(p1x, p1y, m01x, m01y, m012x, m012y, midx, midy, depth + 1, contour, ci);
  ci = cubicToQuadsPush(midx, midy, m123x, m123y, m23x, m23y, p2x, p2y, depth + 1, contour, ci);
  return ci;
}

/**
 * 三次贝塞尔转二次贝塞尔（对象接口，兼容旧代码）
 * 返回扁平数组: [ctrlX, ctrlY, endX, endY, ctrlX, ctrlY, endX, endY, ...]
 */
function bezierCubic2Q2(p1, c1, c2, p2) {
  return bezierCubic2Q2Raw(p1.x, p1.y, c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
}
