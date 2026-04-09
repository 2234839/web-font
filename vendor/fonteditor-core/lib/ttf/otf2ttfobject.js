"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = otf2ttfobject;
var _error = _interopRequireDefault(require("./error"));
var _otfreader = _interopRequireDefault(require("./otfreader"));
var _otfContours2ttfContours = _interopRequireDefault(require("./util/otfContours2ttfContours"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file otf格式转ttf格式对象
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 直接遍历 contours 计算包围盒，避免合并数组
 */
function computeContoursBox(contours) {
  var left, right, top, bottom;
  var found = false;
  for (var ci = 0, cl = contours.length; ci < cl; ci++) {
    var contour = contours[ci];
    for (var pi = 0, pl = contour.length; pi < pl; pi++) {
      var p = contour[pi];
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
  return found ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/**
 * otf格式转ttf格式对象
 *
 * @param  {ArrayBuffer|otfObject} otfBuffer 原始数据或者解析后的otf数据
 * @param  {Object} options   参数
 * @return {Object}          ttfObject对象
 */
function otf2ttfobject(otfBuffer, options) {
  var otfObject;
  if (otfBuffer instanceof ArrayBuffer) {
    var otfReader = new _otfreader.default(options);
    otfObject = otfReader.read(otfBuffer);
    otfReader.dispose();
  } else if (otfBuffer.head && otfBuffer.glyf && otfBuffer.cmap) {
    otfObject = otfBuffer;
  } else {
    _error.default.raise(10111);
  }

  // 转换otf轮廓
  var glyf = otfObject.glyf;
  for (var i = 0, l = glyf.length; i < l; i++) {
    var g = glyf[i];
    g.contours = (0, _otfContours2ttfContours.default)(g.contours);
    var box = computeContoursBox(g.contours);
    if (box) {
      g.xMin = box.x;
      g.xMax = box.x + box.width;
      g.yMin = box.y;
      g.yMax = box.y + box.height;
    } else {
      g.xMin = 0;
      g.xMax = 0;
      g.yMin = 0;
      g.yMax = 0;
    }
  }
  otfObject.version = 0x1;

  // 修改maxp相关配置
  otfObject.maxp.version = 1.0;
  otfObject.maxp.maxZones = otfObject.maxp.maxTwilightPoints ? 2 : 1;

  /**
   * OTF→TTF 转换后字体没有 TrueType instructions，
   * 必须清除 head.flags 中"依赖 hinting"的标志位，
   * 否则浏览器会跳过渲染（skia-canvas 不受影响）。
   * 同时清除"lossless"标志，因为三次→二次贝塞尔转换是有损的。
   */
  otfObject.head.flags = (otfObject.head.flags || 0) & ~(0x0008 | 0x0800);
  otfObject.head.fontDirectionHint = 2;
  delete otfObject.CFF;
  delete otfObject.VORG;
  return otfObject;
}