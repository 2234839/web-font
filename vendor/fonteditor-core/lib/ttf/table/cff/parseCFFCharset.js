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
 * @param  {Array<number>=} subsetGids 可选，subset 模式下需要名字的 GID 升序列表（含 0）
 * @return {Array}         字符集
 */
function parseCFFCharset(reader, start, nGlyphs, strings, subsetGids) {
  if (start) {
    reader.seek(start);
  }
  var i;
  var sid;
  var count;
  nGlyphs -= 1;
  /**
   * 优化310: subset 模式下 charset 用普通对象替代 new Array(nGlyphs+1)。
   * 思源 nGlyphs=65535，new Array(65536) 单次分配 0.32ms；subset 仅命中个位数槽。
   * 调用方仅用 charset[gid] 索引访问，对象同样有效。非 subset 模式仍用数组（全量填充）。
   */
  var hasSubsetPre = subsetGids && subsetGids.length > 1;
  var charset = hasSubsetPre ? { 0: '.notdef' } : new Array(nGlyphs + 1);
  if (!hasSubsetPre) charset[0] = '.notdef';
  var ci = 1;
  /**
   * 优化299: subset 模式下只填充被引用 GID 的名字槽位
   * 思源等大 CID 字体 charset 含数万 SID，但 subset 仅引用极少数。
   * subsetGids 已升序（含 0），用指针 sgp 扫描：每个 range 只在覆盖某个目标 GID 时展开，
   * 否则 ci += count+1 跳过，避免 O(nGlyphs) 的逐项 SID 写入。
   */
  var hasSubset = subsetGids && subsetGids.length > 1;
  /** sgp 指向 subsetGids 中第一个 > 0 的项（0 已固定为 .notdef） */
  var sgp = 1;
  /** 返回当前 range 内是否有目标 GID 尚未消费；无 subset 时恒真走全量路径 */
  function rangeHasTarget(rangeStart, rangeCount) {
    if (!hasSubset) return true;
    var rangeEnd = rangeStart + rangeCount;
    while (sgp < subsetGids.length) {
      var g = subsetGids[sgp];
      if (g > rangeEnd) return false;
      if (g >= rangeStart) return true;
      sgp++;
    }
    return false;
  }
  var format = reader.readUint8();
  if (format === 0) {
    /** format 0 每项一个 uint16 SID，reader 顺序读，无法跳过中间字节；仅按需赋值 */
    for (i = 0; i < nGlyphs; i += 1) {
      sid = reader.readUint16();
      if (!hasSubset || (sgp < subsetGids.length && subsetGids[sgp] === ci)) {
        charset[ci] = sid <= 390 ? STD_STRINGS[sid] : strings[sid - 391];
        if (hasSubset) sgp++;
      }
      ci++;
    }
  } else if (format === 1) {
    while (ci <= nGlyphs) {
      /**
       * 优化305: subset 模式下，所有目标 GID 已命中后即可终止扫描。
       * charset range 按 first GID 升序排列，subsetGids 亦升序，
       * sgp 走到末尾后后续 range 不可能再命中。
       */
      if (hasSubset && sgp >= subsetGids.length) break;
      sid = reader.readUint16();
      count = reader.readUint8();
      if (rangeHasTarget(ci, count)) {
        /**
         * 优化309: subset 模式下 range 命中时，只对落在本 range 的目标 GID 赋值，
         * 不遍历整个 range（思源单 range 可覆盖数万字形，全遍历是 charset 阶段主要耗时）。
         * range 内第 k 个字形 SID = sid + k，可直接计算，无需 reader 逐项读取。
         */
        if (hasSubset) {
          var rangeEnd = ci + count;
          while (sgp < subsetGids.length && subsetGids[sgp] <= rangeEnd) {
            var tg = subsetGids[sgp];
            var tsid = sid + (tg - ci);
            charset[tg] = tsid <= 390 ? STD_STRINGS[tsid] : strings[tsid - 391];
            sgp++;
          }
          ci += count + 1;
        } else {
          for (i = 0; i <= count; i += 1) {
            charset[ci] = sid <= 390 ? STD_STRINGS[sid] : strings[sid - 391];
            ci++;
            sid += 1;
          }
        }
      } else {
        ci += count + 1;
      }
    }
  } else if (format === 2) {
    while (ci <= nGlyphs) {
      /** 优化305: 同 format 1，subset 目标全部命中后提前终止 */
      if (hasSubset && sgp >= subsetGids.length) break;
      sid = reader.readUint16();
      count = reader.readUint16();
      if (rangeHasTarget(ci, count)) {
        /** 优化309: 同 format 1，subset 命中 range 时只赋值目标 GID，跳过 range 其余部分 */
        if (hasSubset) {
          var _rangeEnd = ci + count;
          while (sgp < subsetGids.length && subsetGids[sgp] <= _rangeEnd) {
            var _tg = subsetGids[sgp];
            var _tsid = sid + (_tg - ci);
            charset[_tg] = _tsid <= 390 ? STD_STRINGS[_tsid] : strings[_tsid - 391];
            sgp++;
          }
          ci += count + 1;
        } else {
          for (i = 0; i <= count; i += 1) {
            charset[ci] = sid <= 390 ? STD_STRINGS[sid] : strings[sid - 391];
            ci++;
            sid += 1;
          }
        }
      } else {
        ci += count + 1;
      }
    }
  } else {
    throw new Error('Unknown charset format ' + format);
  }
  return charset;
}