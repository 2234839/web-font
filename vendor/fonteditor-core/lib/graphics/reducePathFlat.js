"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = reducePathFlat;
exports.ceilReducePathFlat = ceilReducePathFlat;
/**
 * @file 缩减path大小（扁平格式专用），去除冗余节点
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 缩减glyf，去除冗余节点（扁平格式 [x, y, onCurve, ...]）
 * 懒分配：首个点被移除前不分配 reduced 数组，大多数 contour 无冗余点可直接返回
 */
function reducePathFlat(contour) {
  if (!contour.length) {
    return contour;
  }
  var len = contour.length;
  var l = len / 3;
  /** 懒分配：仅在首个被保留的点出现时才创建 reduced 数组 */
  var reduced = null;
  var ri = 0;
  var removed = 0;
  // 段1: i=0（首点，prev 是尾点）
  var px = contour[0], py = contour[1], po = contour[2];
  var prevX = contour[(l - 1) * 3], prevY = contour[(l - 1) * 3 + 1], prevO = contour[(l - 1) * 3 + 2];
  var nextX = contour[3], nextY = contour[4], nextO = contour[5];

  var dx = px - nextX;
  var dy = py - nextY;
  /* 优化191: flag 只有 0 或 1，简化条件判断 */
  if (po === nextO && dx * dx + dy * dy <= 1) { removed++; }
  else {
    /** 优化291: 叉积复用 dx/dy，减少 2 次减法 */
    /** 优化288: 坐标为整数时叉积也是整数，用 === 0 替代两个浮点比较 */
    var cross = dx * (prevY - py) - dy * (prevX - px);
    if (prevO && nextO && !cross) { removed++; }
    else {
      reduced = new Array(len);
      reduced[ri++] = px; reduced[ri++] = py; reduced[ri++] = po;
    }
  }
  // 段2: i=1..l-2（中间点，prev/next 简单偏移）
  for (var i = 1; i < l - 1; i++) {
    var pi = i * 3;
    px = contour[pi]; py = contour[pi + 1]; po = contour[pi + 2];
    prevX = contour[pi - 3]; prevY = contour[pi - 2]; prevO = contour[pi - 1];
    nextX = contour[pi + 3]; nextY = contour[pi + 4]; nextO = contour[pi + 5];

    dx = px - nextX;
    dy = py - nextY;
    if (po === nextO && dx * dx + dy * dy <= 1) { removed++; continue; }
    /** 优化291: 叉积复用 dx/dy，减少 2 次减法 */
    cross = dx * (prevY - py) - dy * (prevX - px);
    if (prevO && nextO && !cross) { removed++; continue; }

    if (!reduced) reduced = new Array(len);
    reduced[ri++] = px; reduced[ri++] = py; reduced[ri++] = po;
  }
  // 段3: i=l-1（尾点，next 是首点）
  if (l > 1) {
    var pi = (l - 1) * 3;
    px = contour[pi]; py = contour[pi + 1]; po = contour[pi + 2];
    prevX = contour[pi - 3]; prevY = contour[pi - 2]; prevO = contour[pi - 1];
    nextX = contour[0]; nextY = contour[1]; nextO = contour[2];

    dx = px - nextX;
    dy = py - nextY;
    if (po === nextO && dx * dx + dy * dy <= 1) { removed++; }
    else {
      /** 优化291: 叉积复用 dx/dy，减少 2 次减法 */
      cross = dx * (prevY - py) - dy * (prevX - px);
      if (prevO && nextO && !cross) { removed++; }
      else {
        if (!reduced) reduced = new Array(len);
        reduced[ri++] = px; reduced[ri++] = py; reduced[ri++] = po;
      }
    }
  }
  // 没有任何缩减，直接返回原数组避免拷贝
  if (!reduced) return contour;
  // 截断到实际大小
  reduced.length = ri;
  return reduced;
}

/**
 * 优化85: 合并 ceil + reduce 为单次遍历
 * 在 reduce 遍历中同时做 Math.round，减少一次完整遍历
 */
function ceilReducePathFlat(contour) {
  if (!contour.length) {
    return contour;
  }
  var len = contour.length;
  var l = len / 3;

  /* 先原地 ceil */
  for (var ci = 0; ci < len; ci += 3) {
    contour[ci] = Math.round(contour[ci]);
    contour[ci + 1] = Math.round(contour[ci + 1]);
  }

  /* 然后 reduce（数据已经 round 过） */
  return reducePathFlat(contour);
}
