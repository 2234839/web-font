"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = bezierCubic2Q2;
/**
 * @file 三次贝塞尔转二次贝塞尔（高精度递归分割版）
 * @author mengke01(kekee000@gmail.com)
 *
 * 改进：递归分割三次贝塞尔直到可精确近似，提高 SSIM
 * 优化：返回扁平数组 [control1, endpoint1, control2, endpoint2, ...]
 *       减少 3-element 包装数组的分配
 */

var MAX_DEPTH = 4;

function isFlatEnough(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y) {
  var ux = 3 * c1x - 2 * p1x - p2x;
  var uy = 3 * c1y - 2 * p1y - p2y;
  var vx = 3 * c2x - 2 * p2x - p1x;
  var vy = 3 * c2y - 2 * p2y - p1y;
  return Math.max(ux * ux + uy * uy, vx * vx + vy * vy) <= 0.25;
}

function cubicToQuads(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y, depth, endpoints, controls) {
  if (isFlatEnough(p1x, p1y, c1x, c1y, c2x, c2y, p2x, p2y) || depth >= MAX_DEPTH) {
    controls.push({
      x: (3 * c2x - p2x + 3 * c1x - p1x) * 0.25,
      y: (3 * c2y - p2y + 3 * c1y - p1y) * 0.25
    });
    return;
  }

  var m01x = (p1x + c1x) * 0.5, m01y = (p1y + c1y) * 0.5;
  var m12x = (c1x + c2x) * 0.5, m12y = (c1y + c2y) * 0.5;
  var m23x = (c2x + p2x) * 0.5, m23y = (c2y + p2y) * 0.5;
  var m012x = (m01x + m12x) * 0.5, m012y = (m01y + m12y) * 0.5;
  var m123x = (m12x + m23x) * 0.5, m123y = (m12y + m23y) * 0.5;
  var midx = (m012x + m123x) * 0.5, midy = (m012y + m123y) * 0.5;

  cubicToQuads(p1x, p1y, m01x, m01y, m012x, m012y, midx, midy, depth + 1, endpoints, controls);
  endpoints.push({ x: midx, y: midy, onCurve: true });
  cubicToQuads(midx, midy, m123x, m123y, m23x, m23y, p2x, p2y, depth + 1, endpoints, controls);
}

/**
 * 三次贝塞尔转二次贝塞尔
 * 返回扁平数组: [control1, endpoint1, control2, endpoint2, ...]
 * 每对 (control, endpoint) 代表一个二次贝塞尔段
 */
function bezierCubic2Q2(p1, c1, c2, p2) {
  if (p1.x === c1.x && p1.y === c1.y && c2.x === p2.x && c2.y === p2.y) {
    return [{
      x: (p1.x + p2.x) * 0.5,
      y: (p1.y + p2.y) * 0.5
    }, p2];
  }

  var endpoints = [];
  var controls = [];
  cubicToQuads(p1.x, p1.y, c1.x, c1.y, c2.x, c2.y, p2.x, p2.y, 0, endpoints, controls);

  var result = new Array(controls.length * 2);
  var ri = 0;
  for (var i = 0, l = controls.length; i < l; i++) {
    var next = i < endpoints.length ? endpoints[i] : p2;
    next.onCurve = true;
    result[ri++] = controls[i];
    result[ri++] = next;
  }
  return result;
}
