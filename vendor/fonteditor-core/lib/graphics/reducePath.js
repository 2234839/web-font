"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = reducePath;
var _reducePathFlat = _interopRequireDefault(require("./reducePathFlat"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 缩减path大小，去除冗余节点
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 判断点是否多余的点
 *
 * @param {Object} prev 上一个
 * @param {Object} p 当前
 * @param {Object} next 下一个
 * @return {boolean}
 */
function redundant(prev, p, next) {
  /* 优化: Math.pow(x,2) → x*x，提取 dx/dy 避免重复计算 */
  var dx = p.x - next.x;
  var dy = p.y - next.y;
  /** 优化291: p.onCurve === next.onCurve 替代双重布尔运算 */
  if (p.onCurve === next.onCurve && dx * dx + dy * dy <= 1) {
    return true;
  }

  /** 优化291: 叉积复用 dx/dy，减少 2 次减法；合并两个 onCurve 分支 */
  /** 优化288: 坐标为整数时叉积也是整数，Math.abs 改为位运算取绝对值，阈值 0.001 改为 0 */
  var cross = dx * (prev.y - p.y) - dy * (prev.x - p.x);
  if (prev.onCurve && next.onCurve && !cross) {
    return true;
  }
  return false;
}

/**
 * 缩减glyf，去除冗余节点
 *
 * @param {Array} contour 路径对象（对象格式或扁平格式 [x, y, onCurve, ...]）
 * @return {Array} 路径对象
 */
function reducePath(contour) {
  if (!contour.length) {
    return contour;
  }
  /* 优化66: 检测扁平格式 - 第一个元素是 number 则为扁平格式 */
  if (typeof contour[0] === 'number') {
    return (0, _reducePathFlat.default)(contour);
  }
  /* 优化264: write-index 替代 splice，O(n) 替代 O(n²) */
  var len = contour.length;
  var writeIdx = 0;
  for (var i = 0; i < len; i++) {
    var next = i === len - 1 ? contour[0] : contour[i + 1];
    var prev = i === 0 ? contour[len - 1] : contour[i - 1];
    /** 优化291: 缓存 contour[i] 避免重复索引查找 */
    var cur = contour[i];
    if (!redundant(prev, cur, next)) {
      contour[writeIdx++] = cur;
    }
  }
  contour.length = writeIdx;
  return contour;
}