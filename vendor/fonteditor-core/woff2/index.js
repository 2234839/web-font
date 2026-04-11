/**
 * @file woff2 纯 JavaScript 编码器/解码器
 * 替代原 wasm 实现
 * @author mengke01(kekee000@gmail.com)
 */

const { encodeTTFToWOFF2 } = require('./woff2-encode');

/** @type {typeof import("zlib")} */
let zlib;
try {
  zlib = require("node:zlib");
} catch (_) {
  zlib = require("zlib");
}
const brotliDecompressSync = zlib.brotliDecompressSync;

const woff2Module = {

    /**
     * 是否已经加载完毕（纯 JS 实现不需要初始化）
     *
     * @return {boolean}
     */
    isInited() {
        return true;
    },

    /**
     * 初始化（纯 JS 实现不需要初始化）
     *
     * @return {Promise}
     */
    init() {
        return Promise.resolve(this);
    },

    /**
     * 将ttf buffer 转换成 woff2 buffer
     *
     * @param {ArrayBuffer|Buffer|Array} ttfBuffer ttf buffer
     * @return {Uint8Array} uint8 array
     */
    /** 优化267: encodeTTFToWOFF2 直接返回 Uint8Array，消除二次包装 */
    encode(ttfBuffer) {
        return encodeTTFToWOFF2(ttfBuffer);
    },

    /**
     * 将woff2 buffer 转换成 ttf buffer
     *
     * @param {ArrayBuffer|Buffer|Array} woff2Buffer woff2 buffer
     * @return {Uint8Array} uint8 array
     */
    decode(woff2Buffer) {
        /* WOFF2 文件头: signature(4) + flavor(4) + length(4) + numTables(2) + reserved(2) + totalSfntSize(4) + totalCompressedSize(4) + majorVersion(2) + minorVersion(2) + metaOffset(4) + metaLength(4) + metaOrigLength(4) + privOffset(4) + privLength(4) = 48 bytes */
        const data = new Uint8Array(woff2Buffer);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        /* 跳过 WOFF2 header (48 bytes) + table directory (numTables * 20 bytes) */
        const numTables = view.getUint16(12);
        const totalCompressedSize = view.getUint32(20);
        const dirEnd = 48 + numTables * 20;

        /* 压缩的表数据紧跟在 directory 之后 */
        const compressedData = data.subarray(dirEnd, dirEnd + totalCompressedSize);
        const decompressed = brotliDecompressSync(compressedData);
        return new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    },
};

// Export for CommonJS
module.exports = woff2Module;
