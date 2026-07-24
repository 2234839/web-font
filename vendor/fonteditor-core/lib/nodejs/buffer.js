"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
/**
 * @file Buffer和ArrayBuffer转换
 * @author mengke01(kekee000@gmail.com)
 */
/* eslint-disable no-undef */
var _default = exports.default = {
  /**
   * Buffer转换成ArrayBuffer
   *
   * @param {Buffer} buffer 缓冲数组
   * @return {ArrayBuffer}
   */
  toArrayBuffer: function toArrayBuffer(buffer) {
    var length = buffer.length;
    var view = new DataView(new ArrayBuffer(length), 0, length);
    for (var i = 0, l = length; i < l; i++) {
      view.setUint8(i, buffer[i], false);
    }
    return view.buffer;
  },
  /**
   * ArrayBuffer转换成Buffer
   *
   * @param {ArrayBuffer} arrayBuffer 缓冲数组
   * @return {Buffer}
   */
  /**
   * 优化311: ArrayBuffer→Buffer 用 Buffer.from 共享底层内存（零拷贝），
   * 替代逐字节 view.getUint8 循环（千字文 ttf 162KB 输出时为 toBuffer 9% 热点）。
   * write 产出的 ArrayBuffer 后续不再修改，共享安全。
   */
  toBuffer: function toBuffer(arrayBuffer) {
    if (Array.isArray(arrayBuffer)) {
      return Buffer.from(arrayBuffer);
    }
    return Buffer.from(arrayBuffer);
  }
};