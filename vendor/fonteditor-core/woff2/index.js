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
    /**
     * 已知表标签列表（WOFF2 规范 63 个 known table index）
     * 顺序必须与 woff2-encode.js 的 KNOWN_TAGS 保持一致（编码器自定义顺序）
     */
    decode(woff2Buffer) {
        /* WOFF2 文件头: signature(4) + flavor(4) + length(4) + numTables(2) + reserved(2) + totalSfntSize(4) + totalCompressedSize(4) + majorVersion(2) + minorVersion(2) + metaOffset(4) + metaLength(4) + metaOrigLength(4) + privOffset(4) + privLength(4) = 48 bytes */
        const data = new Uint8Array(woff2Buffer);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        /* Table Directory 是变长的：每个 entry = flags(1) + [tag(4) if unknown] + origLength(Base128) + [transformLength(Base128) if glyf/loca transformed] */
        const numTables = view.getUint16(12);
        const totalCompressedSize = view.getUint32(20);

        /* Base128 无符号整数解码 */
        const readBase128 = (pos) => {
            let value = 0;
            for (let i = 0; i < 5; i++) {
                const b = data[pos++];
                value = (value << 7) | (b & 0x7f);
                if (!(b & 0x80)) {
                    return [value, pos];
                }
            }
            throw new Error(" UIntBase128 too long");
        };

        let pos = 48;
        for (let i = 0; i < numTables; i++) {
            const flags = data[pos++];
            const tagIndex = flags & 0x3f;
            /* 未知表（index 63）后跟 4 字节原始 tag */
            if (tagIndex === 63) {
                pos += 4;
            }
            let r = readBase128(pos);
            pos = r[1];
            /* transformLength 仅在 glyf/loca 被变换（transformVersion 0）时存在 */
            const transformVersion = (flags >> 6) & 0x3;
            const isGlyfLoca = flags & 0x40 ? false : tagIndex === 10 || tagIndex === 11;
            if (transformVersion === 0 && isGlyfLoca) {
                r = readBase128(pos);
                pos = r[1];
            }
        }
        const dirEnd = pos;

        /* 压缩的表数据紧跟在 directory 之后 */
        const compressedData = data.subarray(dirEnd, dirEnd + totalCompressedSize);
        const decompressed = brotliDecompressSync(compressedData);
        return new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    },
};

// Export for CommonJS
module.exports = woff2Module;
