/**
 * @file woff2 to ttf
 * @author mengke01(kekee000@gmail.com)
 */

import woff2 from "../../woff2/index";

/**
 * woff2格式转换成ttf字体格式
 *
 * @param woff2Buffer woff2缓冲数组
 * @param _options 选项（未使用，保留签名兼容）
 * @return ttf格式byte流
 */
export function woff2tottf(woff2Buffer: ArrayBuffer | Uint8Array, _options: object = {}): ArrayBuffer {
  const result = woff2.decode(woff2Buffer);
  return (result.buffer as ArrayBuffer) || result;
}

export default woff2tottf;

/**
 * woff2格式转换成ttf字体格式（异步，纯 JS 实现直接返回）
 *
 * @param woff2Buffer woff2缓冲数组
 * @param options 选项
 * @return ttf格式byte流的 Promise
 */
export function woff2tottfasync(
  woff2Buffer: ArrayBuffer | Uint8Array,
  options: object = {}
): Promise<ArrayBuffer> {
  return Promise.resolve(woff2tottf(woff2Buffer, options));
}
