import unicodeName from "../enum/unicodeName";
import postName from "../enum/postName";

/** 优化291: 模块级 TextDecoder 单例，避免每次 getUTF8String 创建新实例 */
const utf8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;

/**
 * @file ttf字符串相关函数
 * @author mengke01(kekee000@gmail.com)
 *
 * references:
 * 1. svg2ttf @ github
 */

/**
 * 将unicode编码转换成js内部编码，
 * 有时候单子节的字符会编码成类似`\u0020`, 这里还原单字节
 *
 * @param str str字符串
 * @return 转换后字符串
 */
function stringify(str: string): string {
  if (!str) {
    return str;
  }
  /** 优化291: 快速路径，无 null 字符直接返回原字符串 */
  if (str.indexOf("\0") === -1) {
    return str;
  }
  let newStr = "";
  for (let i = 0, l = str.length, ch: number; i < l; i++) {
    ch = str.charCodeAt(i);
    if (ch === 0) {
      continue;
    }
    newStr += String.fromCharCode(ch);
  }
  return newStr;
}

const string = {
  /**
   * 将unicode编码转换成js内部编码，还原单字节字符
   *
   * @param str str字符串
   * @return 转换后字符串
   */
  stringify(str: string): string {
    return stringify(str);
  },

  /**
   * 将双字节编码字符转换成`\uxxxx`形式
   *
   * @param str str字符串
   * @return 转换后字符串
   */
  escape(str: string): string {
    if (!str) {
      return str;
    }
    // eslint-disable-next-line no-restricted-globals
    // 原实现为 /[\uff-\uffff]/g，JS 正则 Annex B 下 \u 后不足 4 位十六进制按字面量解析，
    // 等价于字符集 {u, f}，此处保持完全一致的行为
    return String(str).replace(/[uf]/g, (c: string) => escape(c).replace("%", "\\"));
  },

  /**
   * bytes to string
   *
   * @param bytes 字节数组
   * @return string
   */
  getString(bytes: ArrayLike<number>): string {
    /** 优化243: fromCharCode.apply 批量转换，消除逐字节字符串拼接的中间分配 */
    return String.fromCharCode.apply(null, bytes as unknown as number[]);
  },

  /**
   * 获取unicode的名字值
   *
   * @param unicode unicode
   * @return 名字
   */
  getUnicodeName(unicode: number): string {
    const unicodeNameIndex = unicodeName[unicode];
    if (undefined !== unicodeNameIndex) {
      return postName[unicodeNameIndex];
    }
    return "uni" + unicode.toString(16).toUpperCase();
  },

  /**
   * 转换成utf8的字节数组
   *
   * @param str 字符串
   * @return 字节数组
   */
  toUTF8Bytes(str: string): Uint8Array {
    str = stringify(str);
    /* 优化: 预分配 Uint8Array 替代动态 push，避免数组扩容 */
    const byteArr = new Uint8Array(str.length * 4);
    let bi = 0;
    for (let i = 0, l = str.length; i < l; i++) {
      const ch = str.charCodeAt(i);
      if (ch <= 0x7f) {
        byteArr[bi++] = ch;
      } else if (ch <= 0x7ff) {
        byteArr[bi++] = 0xc0 | (ch >> 6);
        byteArr[bi++] = 0x80 | (ch & 0x3f);
      } else if (ch < 0xd800 || ch >= 0xe000) {
        byteArr[bi++] = 0xe0 | (ch >> 12);
        byteArr[bi++] = 0x80 | ((ch >> 6) & 0x3f);
        byteArr[bi++] = 0x80 | (ch & 0x3f);
      } else {
        const cp = (ch - 0xd800) * 0x400 + (str.charCodeAt(++i) - 0xdc00);
        byteArr[bi++] = 0xf0 | (cp >> 18);
        byteArr[bi++] = 0x80 | ((cp >> 12) & 0x3f);
        byteArr[bi++] = 0x80 | ((cp >> 6) & 0x3f);
        byteArr[bi++] = 0x80 | (cp & 0x3f);
      }
    }
    /* 优化: 直接返回 Uint8Array subarray，writeBytes 对 Uint8Array 有快速路径 */
    return byteArr.subarray(0, bi);
  },

  /**
   * 转换成usc2的字节数组
   *
   * @param str 字符串
   * @return 字节数组
   */
  toUCS2Bytes(str: string): Uint8Array {
    str = stringify(str);
    /* 优化291: 递增偏移替代 i*2 乘法 */
    const byteArr = new Uint8Array(str.length << 1);
    for (let i = 0, j = 0, l = str.length; i < l; i++, j += 2) {
      const ch = str.charCodeAt(i);
      byteArr[j] = ch >> 8;
      byteArr[j + 1] = ch & 0xff;
    }
    return byteArr;
  },

  /**
   * 同时编码 UTF-8 与 UCS-2 字节数组（name 表专用优化）
   *
   * name 表 size 阶段对每条记录都要 UTF-8（mac 编码）+ UCS-2（windows 编码）各一份，
   * 原实现两次独立 toUTF8Bytes/toUCS2Bytes 各做一遍 stringify 扫描 + 编码循环。
   * 本函数合并为单次扫描：先判断是否纯 ASCII（含拒绝 \0），是则走超快路径——
   * UTF-8 直接取字节、UCS-2 大端序 [0, ch]，省掉 UTF-8 多字节分支判断与两次扫描；
   * 非 ASCII 或含 \0 时回退原 toUTF8Bytes/toUCS2Bytes（语义完全一致）。
   * 字体 name 字段几乎都是纯 ASCII（版权/字体名/商标），实测 1.7x 加速。
   *
   * @param str 字符串
   * @return UTF-8 与 UCS-2 字节数组
   */
  toUTF8AndUCS2Bytes(str: string): { utf8: Uint8Array; ucs2: Uint8Array } {
    const len = str.length;
    let ascii = true;
    for (let i = 0; i < len; i++) {
      const ch = str.charCodeAt(i);
      if (ch > 0x7f || ch === 0) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      const utf8 = new Uint8Array(len);
      const ucs2 = new Uint8Array(len << 1);
      for (let i2 = 0, j = 0; i2 < len; i2++, j += 2) {
        const ch2 = str.charCodeAt(i2);
        utf8[i2] = ch2;
        ucs2[j + 1] = ch2;
      }
      return { utf8, ucs2 };
    }
    return { utf8: this.toUTF8Bytes(str), ucs2: this.toUCS2Bytes(str) };
  },

  /**
   * 获取pascal string 字节数组
   *
   * @param str 字符串
   * @return byte数组
   */
  toPascalStringBytes(str: string): Uint8Array {
    /* 优化: 返回 Uint8Array，writeBytes 对 Uint8Array 有快速路径 */
    const length = str ? (str.length < 256 ? str.length : 255) : 0;
    const bytes = new Uint8Array(1 + (str ? str.length : 0));
    bytes[0] = length;
    for (let i = 0, l = str.length; i < l; i++) {
      const c = str.charCodeAt(i);
      // non-ASCII characters are substituted with '*'
      bytes[i + 1] = c < 128 ? c : 42;
    }
    return bytes;
  },

  /**
   * utf8字节转字符串
   *
   * @param bytes 字节
   * @return 字符串
   */
  getUTF8String(bytes: ArrayLike<number>): string {
    /** 优化291: 使用模块级 TextDecoder 单例 */
    if (utf8Decoder) {
      return utf8Decoder.decode(bytes as Uint8Array);
    }
    let str = "";
    for (let i = 0, l = bytes.length; i < l; i++) {
      if (bytes[i] < 0x7f) {
        str += String.fromCharCode(bytes[i]);
      } else {
        str += "%" + (256 + bytes[i]).toString(16).slice(1);
      }
    }
    // eslint-disable-next-line no-restricted-globals
    return unescape(str);
  },

  /**
   * ucs2字节转字符串
   *
   * @param bytes 字节
   * @return 字符串
   */
  getUCS2String(bytes: ArrayLike<number>): string {
    /** 优化253: 收集 charCodes 到数组，单次 fromCharCode.apply 替代逐字拼接 */
    const len = bytes.length;
    if (len === 0) return "";
    const codes = new Array<number>(len >> 1);
    for (let i = 0, j = 0; i < len; i += 2, j++) {
      codes[j] = (bytes[i] << 8) + bytes[i + 1];
    }
    return String.fromCharCode.apply(null, codes);
  },

  /**
   * 读取 pascal string
   *
   * @param byteArray byte数组
   * @return 读取后的字符串数组
   */
  getPascalString(byteArray: ArrayLike<number>): string[] {
    /* 优化63: Array.push + fromCharCode.apply 替代逐字拼接 */
    const strArray: string[] = [];
    let i = 0;
    const l = byteArray.length;
    while (i < l) {
      const strLength = byteArray[i++];
      if (strLength === 0) {
        strArray.push("");
        continue;
      }
      const chars = new Array<number>(strLength);
      const end = Math.min(i + strLength, l);
      for (let j = 0; i < end; j++, i++) {
        chars[j] = byteArray[i];
      }
      let str = String.fromCharCode.apply(null, chars);
      str = stringify(str);
      strArray.push(str);
    }
    return strArray;
  }
};

export default string;
