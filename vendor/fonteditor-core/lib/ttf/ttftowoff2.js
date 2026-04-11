"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = ttftowoff2;
exports.ttftowoff2async = ttftowoff2async;
var _index = _interopRequireDefault(require("../../woff2/index"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file ttf to woff2
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * ttf格式转换成woff2字体格式
 *
 * @param {ArrayBuffer} ttfBuffer ttf缓冲数组
 * @param {Object} options 选项
 *
 * @return {ArrayBuffer} woff格式byte流
 */
function ttftowoff2(ttfBuffer) {
  /** 优化278: 直接返回 Uint8Array，避免 .buffer -> Buffer -> new Uint8Array 多余转换链 */
  var result = _index.default.encode(ttfBuffer);
  return result;
}

/**
 * ttf格式转换成woff2字体格式（异步，纯 JS 实现直接返回）
 */
function ttftowoff2async(ttfBuffer) {
  return Promise.resolve(ttftowoff2(ttfBuffer));
}
