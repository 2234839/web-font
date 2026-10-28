/// <reference types="node" />
/**
 * @file Buffer和ArrayBuffer转换
 * @author mengke01(kekee000@gmail.com)
 */

/** Buffer 和 ArrayBuffer 转换工具集合 */
const buffer = {
  /**
   * Buffer转换成ArrayBuffer
   */
  toArrayBuffer(buffer: Buffer): ArrayBuffer {
    const length = buffer.length;
    const view = new DataView(new ArrayBuffer(length), 0, length);
    for (let i = 0, l = length; i < l; i++) {
      view.setUint8(i, buffer[i]);
    }
    return view.buffer;
  },

  /**
   * ArrayBuffer转换成Buffer
   *
   * 优化311: 用 Buffer.from 共享底层内存（零拷贝），替代逐字节 view.getUint8 循环
   * （千字文 ttf 162KB 输出时为 toBuffer 9% 热点）。write 产出的 ArrayBuffer
   * 后续不再修改，共享安全。
   */
  toBuffer(arrayBuffer: ArrayBuffer): Buffer {
    return Buffer.from(arrayBuffer);
  }
};

export default buffer;
