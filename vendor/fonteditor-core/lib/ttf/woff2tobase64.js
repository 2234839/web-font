"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = woff2tobase64;
var _bytes2base = _interopRequireDefault(require("./util/bytes2base64"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file woff2数组转base64编码
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * woff数组转base64编码
 *
 * @param {Array} arrayBuffer ArrayBuffer对象
 * @return {string} base64编码
 */
function woff2tobase64(arrayBuffer) {
  return 'data:font/woff2;charset=utf-8;base64,' + (0, _bytes2base.default)(arrayBuffer);
}