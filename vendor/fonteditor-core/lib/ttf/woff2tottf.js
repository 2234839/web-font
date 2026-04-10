"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = woff2tottf;
exports.woff2tottfasync = woff2tottfasync;
var _index = _interopRequireDefault(require("../../woff2/index"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file woff2 to ttf
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * woff2格式转换成ttf字体格式
 *
 * @param {ArrayBuffer} woff2Buffer woff2缓冲数组
 * @param {Object} options 选项
 *
 * @return {ArrayBuffer} ttf格式byte流
 */
// eslint-disable-next-line no-unused-vars
function woff2tottf(woff2Buffer) {
  var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  var result = _index.default.decode(woff2Buffer);
  return result.buffer || result;
}

/**
 * woff2格式转换成ttf字体格式（异步，纯 JS 实现直接返回）
 *
 * @param {ArrayBuffer} woff2Buffer woff2缓冲数组
 * @param {Object} options 选项
 *
 * @return {Promise.<ArrayBuffer>} ttf格式byte流
 */
function woff2tottfasync(woff2Buffer) {
  var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  return Promise.resolve(woff2tottf(woff2Buffer, options));
}
