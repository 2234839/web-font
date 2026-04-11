"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = parseCFFCharset;
var _cffStandardStrings = _interopRequireDefault(require("./cffStandardStrings"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/** 优化280: 内联 getCFFString 逻辑，消除每次调用的函数调用开销 + interop 解包 */
var STD_STRINGS = _cffStandardStrings.default;
/**
 * @file 解析cff字符集
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 解析cff字形名称
 * See Adobe TN #5176 chapter 13, "Charsets".
 *
 * @param  {Reader} reader  读取器
 * @param  {number} start   起始偏移
 * @param  {number} nGlyphs 字形个数
 * @param  {Object} strings cff字符串字典
 * @return {Array}         字符集
 */
function parseCFFCharset(reader, start, nGlyphs, strings) {
  if (start) {
    reader.seek(start);
  }
  var i;
  var sid;
  var count;
  nGlyphs -= 1;
  /** 优化250: 预分配 charset 数组，避免 push 扩容 */
  var charset = new Array(nGlyphs + 1);
  charset[0] = '.notdef';
  var ci = 1;
  var format = reader.readUint8();
  if (format === 0) {
    for (i = 0; i < nGlyphs; i += 1) {
      sid = reader.readUint16();
      charset[ci++] = sid <= 390 ? STD_STRINGS[sid] : strings[sid - 391];
    }
  } else if (format === 1) {
    while (ci <= nGlyphs) {
      sid = reader.readUint16();
      count = reader.readUint8();
      for (i = 0; i <= count; i += 1) {
        charset[ci++] = sid <= 390 ? STD_STRINGS[sid] : strings[sid - 391];
        sid += 1;
      }
    }
  } else if (format === 2) {
    while (ci <= nGlyphs) {
      sid = reader.readUint16();
      count = reader.readUint16();
      for (i = 0; i <= count; i += 1) {
        charset[ci++] = sid <= 390 ? STD_STRINGS[sid] : strings[sid - 391];
        sid += 1;
      }
    }
  } else {
    throw new Error('Unknown charset format ' + format);
  }
  return charset;
}