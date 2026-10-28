/**
 * @file woff2 纯 JavaScript 编码器/解码器
 * 替代原 wasm 实现
 * @author mengke01(kekee000@gmail.com)
 */

import { encodeTTFToWOFF2 } from "./woff2-encode";
import * as nodeZlib from "node:zlib";

/** brotli 同步解压函数（Node 内置 zlib，浏览器侧本模块被 vite shim 整体替换） */
const brotliDecompressSync = nodeZlib.brotliDecompressSync as (data: Uint8Array) => Uint8Array;

/**
 * Base128 无符号整数解码
 *
 * @param data 数据
 * @param pos 起始位置
 * @return [值, 新位置]
 */
function readBase128(data: Uint8Array, pos: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = data[pos++];
    value = (value << 7) | (b & 0x7f);
    if (!(b & 0x80)) {
      return [value, pos];
    }
  }
  throw new Error(" UIntBase128 too long");
}

/** woff2 模块接口 */
interface Woff2Module {
  /** 是否已初始化 */
  isInited(): boolean;
  /** 初始化 */
  init(): Promise<Woff2Module>;
  /** ttf 转 woff2 */
  encode(ttfBuffer: ArrayBuffer | Uint8Array): Uint8Array;
  /** woff2 转 ttf */
  decode(woff2Buffer: ArrayBuffer | Uint8Array): Uint8Array;
}

const woff2Module: Woff2Module = {
  /**
   * 是否已经加载完毕（纯 JS 实现不需要初始化）
   *
   * @return 是否已初始化
   */
  isInited(): boolean {
    return true;
  },

  /**
   * 初始化（纯 JS 实现不需要初始化）
   *
   * @return Promise
   */
  init(): Promise<typeof woff2Module> {
    return Promise.resolve(this);
  },

  /**
   * 将ttf buffer 转换成 woff2 buffer
   *
   * @param ttfBuffer ttf buffer
   * @return uint8 array
   */
  /* encodeTTFToWOFF2 直接返回 Uint8Array，消除二次包装 */
  encode(ttfBuffer: ArrayBuffer | Uint8Array): Uint8Array {
    return encodeTTFToWOFF2(ttfBuffer);
  },

  /**
   * 将woff2 buffer 转换成 ttf buffer
   *
   * @param woff2Buffer woff2 buffer
   * @return uint8 array
   */
  decode(woff2Buffer: ArrayBuffer | Uint8Array): Uint8Array {
    /* WOFF2 文件头: signature(4) + flavor(4) + length(4) + numTables(2) + reserved(2)
     * + totalSfntSize(4) + totalCompressedSize(4) + majorVersion(2) + minorVersion(2)
     * + metaOffset(4) + metaLength(4) + metaOrigLength(4) + privOffset(4) + privLength(4)
     * = 48 bytes */
    const data = new Uint8Array(woff2Buffer);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    /* Table Directory 是变长的：每个 entry = flags(1) + [tag(4) if unknown]
     * + origLength(Base128) + [transformLength(Base128) if glyf/loca transformed] */
    const numTables = view.getUint16(12);
    const totalCompressedSize = view.getUint32(20);

    let pos = 48;
    for (let i = 0; i < numTables; i++) {
      const flags = data[pos++];
      const tagIndex = flags & 0x3f;
      /* 未知表（index 63）后跟 4 字节原始 tag */
      if (tagIndex === 63) {
        pos += 4;
      }
      let r = readBase128(data, pos);
      pos = r[1];
      /* transformLength 仅在 glyf/loca 被变换（transformVersion 0）时存在 */
      const transformVersion = (flags >> 6) & 0x3;
      const isGlyfLoca = flags & 0x40 ? false : tagIndex === 10 || tagIndex === 11;
      if (transformVersion === 0 && isGlyfLoca) {
        r = readBase128(data, pos);
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

export default woff2Module;
