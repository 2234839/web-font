"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = otfContours2ttfContours;
var _bezierCubic2Q = _interopRequireDefault(require("../../math/bezierCubic2Q2"));
var _pathCeil = _interopRequireDefault(require("../../graphics/pathCeil"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file otf轮廓转ttf轮廓
 * @author mengke01(kekee000@gmail.com)
 *
 * CFF Type 2 charstring 解析后的 contour 格式：
 *   - onCurve 点（{x, y, onCurve: true}）是曲线端点或线段端点
 *   - offCurve 点（{x, y}，无 onCurve 属性）是 cubic bezier 控制点
 *   - 每个 cubic bezier 段由 2 个 offCurve + 1 个 onCurve 组成
 *   - 连续的 offCurve 点之间，隐含端点为两者的中点
 */

/**
 * 将 CFF contour 转换为标准 [onCurve, offCurve, offCurve, onCurve, ...] 序列
 * 处理隐含端点和连续 offCurve 点的情况
 * 优化：原地操作 otfContour，减少中间数组分配
 */
function normalizeContour(otfContour) {
  var len = otfContour.length;
  if (len < 2) return otfContour;

  /** 确保 onCurve 标志规范化 */
  for (var i = 0; i < len; i++) {
    otfContour[i].onCurve = !!otfContour[i].onCurve;
  }

  /** 如果第一个点不是 onCurve，需要回绕处理 */
  if (!otfContour[0].onCurve) {
    var last = otfContour[len - 1];
    if (last.onCurve) {
      otfContour.unshift({ x: last.x, y: last.y, onCurve: true });
    } else {
      otfContour.unshift({
        x: (otfContour[0].x + last.x) * 0.5,
        y: (otfContour[0].y + last.y) * 0.5,
        onCurve: true
      });
    }
    len = otfContour.length;
  }

  /** 处理连续的 offCurve 点：在它们之间插入隐含端点 */
  for (var i = 0; i < len; i++) {
    var p = otfContour[i];
    if (!p.onCurve && i + 1 < len && !otfContour[i + 1].onCurve) {
      var next = otfContour[i + 1];
      otfContour.splice(i + 1, 0, {
        x: (p.x + next.x) * 0.5,
        y: (p.y + next.y) * 0.5,
        onCurve: true
      });
      len++;
      i++;
    }
  }

  return otfContour;
}

/**
 * 转换已标准化的轮廓（onCurve/offCurve 严格交替）
 * 模式：onCurve, offCurve, offCurve, onCurve, offCurve, offCurve, ...
 */
function transformContour(otfContour) {
  var normalized = normalizeContour(otfContour);
  if (normalized.length < 2) return [];

  var contour = [];
  contour.push(normalized[0]);

  var i = 1;
  while (i < normalized.length) {
    var cur = normalized[i];
    if (cur.onCurve) {
      /** 线段：直接添加 onCurve 端点 */
      contour.push(cur);
      i++;
    } else {
      /** cubic bezier：offCurve, offCurve, onCurve */
      var c1 = cur;
      var c2 = i + 1 < normalized.length ? normalized[i + 1] : null;
      var end;

      if (c2 && !c2.onCurve) {
        /** 标准 cubic bezier：2个控制点 + 1个端点 */
        end = i + 2 < normalized.length ? normalized[i + 2] : normalized[0];
        i += 3;
      } else if (c2 && c2.onCurve) {
        /** 退化 cubic bezier：只有1个控制点，端点就是 c2 */
        end = c2;
        i += 2;
      } else {
        /** 只有一个 offCurve 点，回绕到起点 */
        end = normalized[0];
        i++;
      }

      var bezierArray = (0, _bezierCubic2Q.default)(contour[contour.length - 1], c1, c2 || c1, end);
      for (var bi = 0, bl = bezierArray.length; bi < bl; bi++) {
        bezierArray[bi][2].onCurve = true;
        contour.push(bezierArray[bi][1]);
        contour.push(bezierArray[bi][2]);
      }
    }
  }

  return (0, _pathCeil.default)(contour);
}

/**
 * otf轮廓转ttf轮廓
 *
 * @param  {Array} otfContours otf轮廓数组
 * @return {Array} ttf轮廓
 */
function otfContours2ttfContours(otfContours) {
  if (!otfContours || !otfContours.length) {
    return otfContours;
  }
  var contours = [];
  for (var i = 0, l = otfContours.length; i < l; i++) {
    if (otfContours[i][0]) {
      contours.push(transformContour(otfContours[i]));
    }
  }
  return contours;
}
