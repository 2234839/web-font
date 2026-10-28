/**
 * Buffer和ArrayBuffer转换（nodejs/buffer.js 的类型声明）
 */
declare const buffer: {
  /** Buffer转换成ArrayBuffer */
  toArrayBuffer(buffer: Buffer): ArrayBuffer;
  /** ArrayBuffer转换成Buffer */
  toBuffer(arrayBuffer: ArrayBuffer): Buffer;
};

export default buffer;
