/**
 * 浏览器端 woff2 空实现 —— 拦截 fonteditor-core 的 woff2 import 链
 *
 * fonteditor-core 的 font.js 静态 import 了 ttftowoff2 → woff2/index → woff2-encode，
 * 后者依赖 Node.js 的 zlib.brotliCompressSync，浏览器无法加载。
 *
 * 本 shim 提供空壳函数，使 import 链不断裂、模块可正常加载。
 * 实际裁剪时 outType 恒为 ttf，不会触发 woff2 编码路径。
 * woff2 解码路径（读取 woff2 输入字体）同样不会触发——
 * 离线页面仅支持 ttf/otf 输入，woff2 输入走 fonteditor-core 的 woff2tottf.js。
 */

export function encodeTTFToWOFF2() {
  throw new Error("WOFF2 encoding is not supported in browser. Use TTF output.");
}

export function decodeWOFF2ToTTF() {
  throw new Error("WOFF2 decoding is not supported in browser shim.");
}

export default {
  isInited() {
    return false;
  },
  init() {
    return Promise.resolve();
  },
  encode() {
    throw new Error("WOFF2 encoding is not supported in browser.");
  },
  decode() {
    throw new Error("WOFF2 decoding is not supported in browser.");
  },
};
