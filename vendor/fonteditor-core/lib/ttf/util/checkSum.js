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
 * 优化107: 使用 Uint32Array 视图 + DataView 字节序转换处理大端序
 * 避免每次调用创建新的 DataView，减少内存分配
 */
function checkSumArrayBuffer(buffer, offset, length) {
  if (offset === undefined) offset = 0;
  length = length == null ? buffer.byteLength : length;
  if (offset + length > buffer.byteLength) {
    throw new Error('check sum out of bound');
  }
  /* 优化107: 复用共享 DataView 进行字节序转换 */
  var view = DataViewPool.acquire(buffer);
  var nLongs = length >> 2;
  var sum = 0;
  for (var i = 0; i < nLongs; i++) {
    sum = (sum + view.getUint32(offset + (i << 2), false)) | 0;
  }
  DataViewPool.release(view);
  var leftBytes = length - nLongs * 4;
  if (leftBytes) {
    var bytes = new Uint8Array(buffer, offset + nLongs * 4, leftBytes);
    var val = 0;
    for (var k = 0; k < leftBytes; k++) {
      val = (val | bytes[k] << (leftBytes - 1 - k) * 8) >>> 0;
    }
    sum = (sum + val) | 0;
  }
  return sum >>> 0;
}

/**
 * 优化107: DataView 对象池，避免重复创建
 */
var DataViewPool = {
  _view: null,
  _buffer: null,
  acquire: function (buffer) {
    if (this._buffer !== buffer) {
      this._view = new DataView(buffer);
      this._buffer = buffer;
    }
    return this._view;
  },
  release: function () {
    /* 保留引用供下次复用 */
  }
};

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
