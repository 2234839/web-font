"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = eot2base64;
var _bytes2base = _interopRequireDefault(require("./util/bytes2base64"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file eot数组转base64编码
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * eot数组转base64编码
 *
 * @param {Array} arrayBuffer ArrayBuffer对象
 * @return {string} base64编码
 */
function eot2base64(arrayBuffer) {
  return 'data:font/eot;charset=utf-8;base64,' + (0, _bytes2base.default)(arrayBuffer);
}