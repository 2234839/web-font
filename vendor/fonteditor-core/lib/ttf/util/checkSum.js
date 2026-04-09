"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = checkSum;
/**
 * @file ttf table校验函数
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化18+69: 位运算避免溢出 + Uint8Array 替代 DataView
 */
function checkSumArrayBuffer(buffer, offset, length) {
  if (offset === undefined) offset = 0;
  length = length == null ? buffer.byteLength : length;
  if (offset + length > buffer.byteLength) {
    throw new Error('check sum out of bound');
  }
  var bytes = new Uint8Array(buffer, offset, length);
  var nLongs = length >> 2;
  var sum = 0;
  var i = 0;
  while (i < nLongs) {
    var j = i << 2;
    sum = (sum + (bytes[j] << 24 | bytes[j + 1] << 16 | bytes[j + 2] << 8 | bytes[j + 3])) | 0;
    i++;
  }
  var leftBytes = length - nLongs * 4;
  if (leftBytes) {
    var off = nLongs << 2;
    var shift = leftBytes * 8;
    var val = 0;
    for (var k = 0; k < leftBytes; k++) {
      val = (val | bytes[off + k] << (leftBytes - 1 - k) * 8) >>> 0;
    }
    sum = (sum + val) | 0;
  }
  return sum >>> 0;
}

function checkSumArray(buffer, offset, length) {
  if (offset === undefined) offset = 0;
  length = length || buffer.length;
  if (offset + length > buffer.length) {
    throw new Error('check sum out of bound');
  }
  var nLongs = length >> 2;
  var sum = 0;
  var i = 0;
  while (i < nLongs) {
    sum = (sum + ((buffer[i] << 24 | buffer[i + 1] << 16 | buffer[i + 2] << 8 | buffer[i + 3]) >>> 0)) | 0;
    i += 4;
  }
  var leftBytes = length - nLongs * 4;
  if (leftBytes) {
    var off = nLongs << 2;
    for (var k = 0; k < leftBytes; k++) {
      sum = (sum + (buffer[off + k] << (leftBytes - 1 - k) * 8)) | 0;
    }
  }
  return sum >>> 0;
}

/**
 * table校验
 *
 * @param {ArrayBuffer|Array} buffer 表数据
 * @param {number=} offset 偏移量
 * @param {number=} length 长度
 *
 * @return {number} 校验和
 */
function checkSum(buffer, offset, length) {
  if (buffer instanceof ArrayBuffer) {
    return checkSumArrayBuffer(buffer, offset, length);
  } else if (buffer instanceof Array) {
    return checkSumArray(buffer, offset, length);
  }
  throw new Error('not support checksum buffer type');
}
