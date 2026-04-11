"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _unicodeName = _interopRequireDefault(require("../enum/unicodeName"));
var _postName = _interopRequireDefault(require("../enum/postName"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/** 优化291: 模块级 TextDecoder 单例，避免每次 getUTF8String 创建新实例 */
var _utf8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;
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
 * @param {string} str str字符串
 * @return {string} 转换后字符串
 */
function stringify(str) {
  if (!str) {
    return str;
  }
  /** 优化291: 快速路径，无 null 字符直接返回原字符串 */
  if (str.indexOf('\0') === -1) {
    return str;
  }
  var newStr = '';
  for (var i = 0, l = str.length, ch; i < l; i++) {
    ch = str.charCodeAt(i);
    if (ch === 0) {
      continue;
    }
    newStr += String.fromCharCode(ch);
  }
  return newStr;
}
var _default = exports.default = {
  stringify: stringify,
  /**
   * 将双字节编码字符转换成`\uxxxx`形式
   *
   * @param {string} str str字符串
   * @return {string} 转换后字符串
   */
  escape: function (_escape) {
    function escape(_x) {
      return _escape.apply(this, arguments);
    }
    escape.toString = function () {
      return _escape.toString();
    };
    return escape;
  }(function (str) {
    if (!str) {
      return str;
    }
    return String(str).replace(/[\uff-\uffff]/g, function (c) {
      return escape(c).replace('%', '\\');
    });
  }),
  /**
   * bytes to string
   *
   * @param  {Array} bytes 字节数组
   * @return {string}       string
   */
  getString: function getString(bytes) {
    /** 优化243: fromCharCode.apply 批量转换，消除逐字节字符串拼接的中间分配 */
    return String.fromCharCode.apply(null, bytes);
  },
  /**
   * 获取unicode的名字值
   *
   * @param {number} unicode unicode
   * @return {string} 名字
   */
  getUnicodeName: function getUnicodeName(unicode) {
    var unicodeNameIndex = _unicodeName.default[unicode];
    if (undefined !== unicodeNameIndex) {
      return _postName.default[unicodeNameIndex];
    }
    return 'uni' + unicode.toString(16).toUpperCase();
  },
  /**
   * 转换成utf8的字节数组
   *
   * @param {string} str 字符串
   * @return {Array.<byte>} 字节数组
   */
  toUTF8Bytes: function toUTF8Bytes(str) {
    str = stringify(str);
    /* 优化: 预分配 Uint8Array 替代动态 push，避免数组扩容 */
    var byteArr = new Uint8Array(str.length * 4);
    var bi = 0;
    for (var i = 0, l = str.length; i < l; i++) {
      var ch = str.charCodeAt(i);
      if (ch <= 0x7F) {
        byteArr[bi++] = ch;
      } else if (ch <= 0x7FF) {
        byteArr[bi++] = 0xC0 | (ch >> 6);
        byteArr[bi++] = 0x80 | (ch & 0x3F);
      } else if (ch < 0xD800 || ch >= 0xE000) {
        byteArr[bi++] = 0xE0 | (ch >> 12);
        byteArr[bi++] = 0x80 | ((ch >> 6) & 0x3F);
        byteArr[bi++] = 0x80 | (ch & 0x3F);
      } else {
        var cp = ((ch - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
        byteArr[bi++] = 0xF0 | (cp >> 18);
        byteArr[bi++] = 0x80 | ((cp >> 12) & 0x3F);
        byteArr[bi++] = 0x80 | ((cp >> 6) & 0x3F);
        byteArr[bi++] = 0x80 | (cp & 0x3F);
      }
    }
    /* 优化: 直接返回 Uint8Array subarray，writeBytes 对 Uint8Array 有快速路径 */
    return byteArr.subarray(0, bi);
  },
  /**
   * 转换成usc2的字节数组
   *
   * @param {string} str 字符串
   * @return {Array.<byte>} 字节数组
   */
  toUCS2Bytes: function toUCS2Bytes(str) {
    str = stringify(str);
    /* 优化291: 递增偏移替代 i*2 乘法 */
    var byteArr = new Uint8Array(str.length << 1);
    for (var i = 0, j = 0, l = str.length; i < l; i++, j += 2) {
      var ch = str.charCodeAt(i);
      byteArr[j] = ch >> 8;
      byteArr[j + 1] = ch & 0xFF;
    }
    return byteArr;
  },
  /**
   * 获取pascal string 字节数组
   *
   * @param {string} str 字符串
   * @return {Array.<byte>} byteArray byte数组
   */
  toPascalStringBytes: function toPascalStringBytes(str) {
    /* 优化: 返回 Uint8Array，writeBytes 对 Uint8Array 有快速路径 */
    var length = str ? str.length < 256 ? str.length : 255 : 0;
    var bytes = new Uint8Array(1 + (str ? str.length : 0));
    bytes[0] = length;
    for (var i = 0, l = str.length; i < l; i++) {
      var c = str.charCodeAt(i);
      // non-ASCII characters are substituted with '*'
      bytes[i + 1] = c < 128 ? c : 42;
    }
    return bytes;
  },
  /**
   * utf8字节转字符串
   *
   * @param {Array} bytes 字节
   * @return {string} 字符串
   */
  getUTF8String: function getUTF8String(bytes) {
    /** 优化291: 使用模块级 TextDecoder 单例 */
    if (_utf8Decoder) {
      return _utf8Decoder.decode(bytes);
    }
    var str = '';
    for (var i = 0, l = bytes.length; i < l; i++) {
      if (bytes[i] < 0x7F) {
        str += String.fromCharCode(bytes[i]);
      } else {
        str += '%' + (256 + bytes[i]).toString(16).slice(1);
      }
    }
    return unescape(str);
  },
  /**
   * ucs2字节转字符串
   *
   * @param {Array} bytes 字节
   * @return {string} 字符串
   */
  getUCS2String: function getUCS2String(bytes) {
    /** 优化253: 收集 charCodes 到数组，单次 fromCharCode.apply 替代逐字拼接 */
    var len = bytes.length;
    if (len === 0) return '';
    var codes = new Array(len >> 1);
    for (var i = 0, j = 0; i < len; i += 2, j++) {
      codes[j] = (bytes[i] << 8) + bytes[i + 1];
    }
    return String.fromCharCode.apply(null, codes);
  },
  /**
   * 读取 pascal string
   *
   * @param {Array.<byte>} byteArray byte数组
   * @return {Array.<string>} 读取后的字符串数组
   */
  getPascalString: function getPascalString(byteArray) {
    /* 优化63: Array.push + fromCharCode.apply 替代逐字拼接 */
    var strArray = [];
    var i = 0;
    var l = byteArray.length;
    while (i < l) {
      var strLength = byteArray[i++];
      if (strLength === 0) {
        strArray.push('');
        continue;
      }
      var chars = new Array(strLength);
      var end = Math.min(i + strLength, l);
      for (var j = 0; i < end; j++, i++) {
        chars[j] = byteArray[i];
      }
      var str = String.fromCharCode.apply(null, chars);
      str = stringify(str);
      strArray.push(str);
    }
    return strArray;
  }
};