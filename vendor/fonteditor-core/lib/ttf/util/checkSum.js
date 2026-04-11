"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = checkSum;
exports.checkSumArrayBuffer = checkSumArrayBuffer;
/**
 * @file ttf table校验函数
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化205+229+248: 支持传入预创建的 Uint8Array，使用 DataView.getUint32 替代手动字节组装
 * 注意: bytes 必须是从 offset 开始的子视图，或者 offset 必须为 0
 */
function checkSumArrayBuffer(buffer, offset, length, bytes) {
  if (offset === undefined) offset = 0;
  length = length == null ? buffer.byteLength : length;
  if (offset + length > buffer.byteLength) {
    throw new Error('check sum out of bound');
  }
  /** 优化229: 当传入 fullView 时，用 subarray 创建正确的偏移视图（不拷贝数据） */
  if (!bytes) {
    bytes = new Uint8Array(buffer, offset, length);
  } else if (offset > 0) {
    bytes = bytes.subarray(offset, offset + length);
  }
  /** 优化248: 使用 DataView.getUint32 替代手动字节组装，减少 4x 数组访问 */
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var nLongs = length >> 2;
  var sum = 0;
  var i = 0;
  while (i < nLongs) {
    sum = (sum + view.getUint32(i << 2, false)) | 0;
    i++;
  }
  var leftBytes = length - nLongs * 4;
  if (leftBytes) {
    var off = nLongs << 2;
    var val = 0;
    for (var k = 0; k < leftBytes; k++) {
      val = (val << 8) | view.getUint8(off + k);
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
    var val = 0;
    for (var k = 0; k < leftBytes; k++) {
      val = (val << 8) | buffer[off + k];
    }
    sum = (sum + val) | 0;
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
