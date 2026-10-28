/**
 * @file ttf to woff2
 * @author mengke01(kekee000@gmail.com)
 */

import woff2 from "../../woff2/index";

/**
 * ttf格式转换成woff2字体格式
 *
 * @param ttfBuffer ttf缓冲数组
 * @param _options 选项（未使用，保留签名兼容）
 * @return woff格式byte流
 */
export function ttftowoff2(ttfBuffer: ArrayBuffer | Uint8Array): Uint8Array {
  /* 直接返回 Uint8Array，避免 .buffer -> Buffer -> new Uint8Array 多余转换链 */
  return woff2.encode(ttfBuffer);
}

export default ttftowoff2;

/**
 * ttf格式转换成woff2字体格式（异步，纯 JS 实现直接返回）
 *
 * @param ttfBuffer ttf缓冲数组
 * @return woff格式byte流的 Promise
 */
export function ttftowoff2async(ttfBuffer: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(ttftowoff2(ttfBuffer));
}
