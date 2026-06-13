"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _string = _interopRequireDefault(require("../util/string"));
var _encoding = _interopRequireDefault(require("./cff/encoding"));
var _cffStandardStrings = _interopRequireDefault(require("./cff/cffStandardStrings"));
var _parseCFFDict = _interopRequireDefault(require("./cff/parseCFFDict"));
var _parseCFFGlyph = _interopRequireDefault(require("./cff/parseCFFGlyph"));
var _parseCFFCharset = _interopRequireDefault(require("./cff/parseCFFCharset"));
var _parseCFFEncoding = _interopRequireDefault(require("./cff/parseCFFEncoding"));
var _reader = _interopRequireDefault(require("../reader"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file cff表
 * @author mengke01(kekee000@gmail.com)
 *
 * reference:
 * http://wwwimages.adobe.com/content/dam/Adobe/en/devnet/font/pdfs/5176.CFF.pdf
 *
 * modify from:
 * https://github.com/nodebox/opentype.js/blob/master/src/tables/cff.js
 */

/**
 * 获取cff偏移
 *
 * @param  {Reader} reader  读取器
 * @param  {number} offSize 偏移大小
 * @param  {number} offset  起始偏移
 * @return {number}         偏移
 */
function getOffset(reader, offSize) {
  var v = 0;
  for (var i = 0; i < offSize; i++) {
    v <<= 8;
    v += reader.readUint8();
  }
  return v;
}

/**
 * 解析cff表头部
 *
 * @param  {Reader} reader 读取器
 * @return {Object}        头部字段
 */
function parseCFFHead(reader) {
  var head = {};
  head.startOffset = reader.offset;
  head.endOffset = head.startOffset + 4;
  head.formatMajor = reader.readUint8();
  head.formatMinor = reader.readUint8();
  head.size = reader.readUint8();
  head.offsetSize = reader.readUint8();
  return head;
}

/**
 * 解析`CFF`表索引
 *
 * @param  {Reader} reader       读取器
 * @param  {number} offset       偏移
 * @param  {Funciton} conversionFn 转换函数
 * @return {Object}              表对象
 */
function parseCFFIndex(reader, offset, conversionFn) {
  if (offset) {
    reader.seek(offset);
  }
  var start = reader.offset;
  var count = reader.readUint16();
  var offsets = new Array(count + 1);
  var objects = new Array(count);
  var i;
  var l;
  if (count !== 0) {
    var offsetSize = reader.readUint8();
    /** 优化289: 内联 getOffset，消除函数调用开销（与 parseCFFIndexOffsets 保持一致） */
    if (offsetSize === 1) {
      for (i = 0; i <= count; i++) offsets[i] = reader.readUint8();
    } else if (offsetSize === 2) {
      for (i = 0; i <= count; i++) offsets[i] = reader.readUint16();
    } else if (offsetSize === 3) {
      for (i = 0; i <= count; i++) {
        offsets[i] = reader.readUint8() << 16 | reader.readUint8() << 8 | reader.readUint8();
      }
    } else {
      for (i = 0; i <= count; i++) offsets[i] = reader.readUint32();
    }
    /** 优化291: 缓存 reader.view.byteOffset 到局部变量，消除循环内属性链查找 */
    /** 优化293: 合并 conversionFn 的两个循环，消除代码重复 */
    var viewByteOffset = reader.view.byteOffset;
    for (i = 0, l = count; i < l; i++) {
      var objSize = offsets[i + 1] - offsets[i];
      var value = new Uint8Array(reader.view.buffer, viewByteOffset + reader.offset, objSize);
      reader.offset += objSize;
      objects[i] = conversionFn ? conversionFn(value) : value;
    }
  }
  return {
    objects: objects,
    startOffset: start,
    endOffset: reader.offset
  };
}

/**
 * 解析 CFF 索引的偏移表（不读取实际数据）
 * 用于大字体的延迟读取，避免一次性读取全部 charstring
 *
 * @param  {Reader} reader  读取器
 * @param  {number} offset  偏移
 * @return {Object}         { offsets, count, dataStart, endOffset }
 */
function parseCFFIndexOffsets(reader, offset) {
  if (offset) reader.seek(offset);
  var start = reader.offset;
  var count = reader.readUint16();
  var offsets = null;
  if (count !== 0) {
    var offsetSize = reader.readUint8();
    offsets = new Array(count + 1);
    /** 优化166: 内联 getOffset，消除函数调用开销 */
    if (offsetSize === 1) {
      for (var i = 0; i <= count; i++) offsets[i] = reader.readUint8();
    } else if (offsetSize === 2) {
      for (var i = 0; i <= count; i++) offsets[i] = reader.readUint16();
    } else if (offsetSize === 3) {
      for (var i = 0; i <= count; i++) {
        offsets[i] = reader.readUint8() << 16 | reader.readUint8() << 8 | reader.readUint8();
      }
    } else {
      for (var i = 0; i <= count; i++) offsets[i] = reader.readUint32();
    }
  }
  return { offsets: offsets, count: count, dataStart: reader.offset, endOffset: reader.offset };
}

/**
 * 优化303: 子集模式下的 CFF 索引按需预读
 * 大 CID 字体（如思源）的 charstring index 含数万字形，parseCFFIndexOffsets 全量读取
 * offset 表（思源 65535×3≈196KB，1.97ms）对 subset 是纯浪费——仅需其中极少数字形。
 *
 * 本函数只读取被引用字形及其后一个 offset（用于界定字节范围），并按需读最后一个
 * offset 计算 totalSize 供 prepareCFFIndexView 建立全量大视图。
 * 返回的 indexInfo 兼容 readCFFIndexObject：subsetGids 命中的槽位有真实 offset，
 * 其余为 undefined（按需 seek 读取）。
 *
 * @param {Reader} reader    读取器
 * @param {number} offset    索引偏移
 * @param {Array<number>} neededGids 需要名字/数据的 GID 升序列表（0-based，不含越界）
 * @return {Object}          { offsets, count, dataStart, endOffset }
 */
function parseCFFIndexOffsetsSubset(reader, offset, neededGids) {
  reader.seek(offset);
  var count = reader.readUint16();
  var offsetSize = reader.readUint8();
  /** offset 数组起始（紧跟 count+offsetSize 之后） */
  var offsetArrayBase = reader.offset;
  /**
   * 优化307: 直接用 DataView 读取 offset，绕过 reader 的原型方法调用 + seek 边界检查。
   * reader.view 是覆盖整个 buffer 的 DataView，offset 坐标系与 reader.offset 一致。
   * 实测 reader.seek + readUint8 链对 15 次读取达 0.5ms（ES5 class 方法开销），
   * 直连 DataView 后降至可忽略。
   */
  var view = reader.view;
  function readOffAt(pos) {
    var off = offsetArrayBase + pos * offsetSize;
    if (offsetSize === 1) return view.getUint8(off);
    if (offsetSize === 2) return view.getUint16(off, false);
    if (offsetSize === 4) return view.getUint32(off, false);
    /** offsetSize === 3 */
    return view.getUint8(off) << 16 | view.getUint8(off + 1) << 8 | view.getUint8(off + 2);
  }
  /**
   * 优化308: subset 模式 offsets 用普通对象而非 new Array(count+1)。
   * 思源 charstring index count=65535，new Array(65536) 单次分配 0.32ms，
   * 而 subset 仅命中个位数槽位。对象按需添加属性，零分配开销。
   * readCFFIndexObject 的 off[idx] 索引对对象同样有效。
   */
  var offsets = {};
  /** 读取每个所需 GID 及其后一个 offset（界定数据范围） */
  for (var gi = 0; gi < neededGids.length; gi++) {
    var gid = neededGids[gi];
    if (gid < 0 || gid > count) continue;
    if (offsets[gid] === undefined) offsets[gid] = readOffAt(gid);
    if (gid + 1 <= count && offsets[gid + 1] === undefined) offsets[gid + 1] = readOffAt(gid + 1);
  }
  /** 读最后一个 offset 计算 totalSize，供 prepareCFFIndexView 建全量大视图 */
  var lastOffset = readOffAt(count);
  var dataStart = offsetArrayBase + (count + 1) * offsetSize;
  /** 同步 reader.offset 到 dataStart，保持后续 reader 读取的坐标连续性 */
  reader.offset = dataStart;
  return {
    offsets: offsets,
    count: count,
    dataStart: dataStart,
    /** 标记子集模式并提供按需读取所需信息 */
    _subsetMode: true,
    _offsetArrayBase: offsetArrayBase,
    _offsetSize: offsetSize,
    _totalSize: lastOffset - 1
  };
}

/**
 * 优化304: 完全惰性的 CFF 索引预读（用于 local subrs）
 * local subrs 的引用 idx 在 charstring 解析时动态决定，无法预知，故不能像
 * parseCFFIndexOffsetsSubset 那样只读所需 offset。但大 subrs 表（思源单 FD 含 26550 subrs）
 * 全量读取 offset 表（26550×3≈80KB，~10万次 readUint8）对 subset 仍是纯浪费——
 * 实际被引用的 subr 通常是个位数。
 *
 * 本函数只读 count + offsetSize + 最后一个 offset（算 totalSize 建 view），
 * offsets 数组保持稀疏，readCFFIndexObject 按需 seek 填充命中的 idx。
 *
 * @param {Reader} reader  读取器
 * @param {number} offset  索引偏移
 * @return {Object}        { offsets, count, dataStart, _subsetMode, ... }
 */
function parseCFFIndexOffsetsLazy(reader, offset) {
  reader.seek(offset);
  var count = reader.readUint16();
  var offsetSize = reader.readUint8();
  var offsetArrayBase = reader.offset;
  /** 优化307: 直接用 DataView 读末尾 offset，绕过 reader.seek + 原型方法 */
  var view = reader.view;
  var lastOffPos = offsetArrayBase + count * offsetSize;
  var lastOffset;
  if (offsetSize === 1) lastOffset = view.getUint8(lastOffPos);else if (offsetSize === 2) lastOffset = view.getUint16(lastOffPos, false);else if (offsetSize === 4) lastOffset = view.getUint32(lastOffPos, false);else lastOffset = view.getUint8(lastOffPos) << 16 | view.getUint8(lastOffPos + 1) << 8 | view.getUint8(lastOffPos + 2);
  var dataStart = offsetArrayBase + (count + 1) * offsetSize;
  /** 同步 reader.offset 到 dataStart，保持后续 reader 读取坐标连续 */
  reader.offset = dataStart;
  return {
    /** 优化308: 用普通对象替代 new Array(count+1)，避免大 subrs 表（26550）的数组分配 */
    offsets: {},
    count: count,
    dataStart: dataStart,
    _subsetMode: true,
    _offsetArrayBase: offsetArrayBase,
    _offsetSize: offsetSize,
    _totalSize: lastOffset - 1
  };
}

/**
 * 根据 parseCFFIndexOffsets 的结果，按需读取第 idx 个 object
 *
 * @param  {Reader} reader       读取器
 * @param  {Object} indexInfo    parseCFFIndexOffsets 返回的信息
 * @param  {number} idx           object 索引（0-based）
 * @return {Uint8Array}          object 数据
 */
/**
 * 优化169+179+244: 预创建全量 charstring 大视图，用 subarray 替代 new Uint8Array(buffer, off, len)
 * subarray 不需要参数验证，比 new Uint8Array 更快
 */
function readCFFIndexObject(reader, indexInfo, idx) {
  var off = indexInfo.offsets;
  var view = indexInfo._view;
  /**
   * 优化303+307: 子集模式下 off[idx]/off[idx+1] 可能为 undefined（未预读），
   * 直接用 DataView 读取（绕过 reader 原型方法 + seek 边界检查）。命中槽位直接复用。
   */
  if (off && off[idx] === undefined) {
    var base = indexInfo._offsetArrayBase;
    var os = indexInfo._offsetSize;
    var dv = reader.view;
    var o1 = base + idx * os;
    var o2 = base + (idx + 1) * os;
    if (os === 1) {
      off[idx] = dv.getUint8(o1);
      off[idx + 1] = dv.getUint8(o2);
    } else if (os === 2) {
      off[idx] = dv.getUint16(o1, false);
      off[idx + 1] = dv.getUint16(o2, false);
    } else if (os === 4) {
      off[idx] = dv.getUint32(o1, false);
      off[idx + 1] = dv.getUint32(o2, false);
    } else {
      off[idx] = dv.getUint8(o1) << 16 | dv.getUint8(o1 + 1) << 8 | dv.getUint8(o1 + 2);
      off[idx + 1] = dv.getUint8(o2) << 16 | dv.getUint8(o2 + 1) << 8 | dv.getUint8(o2 + 2);
    }
  }
  if (view) {
    /** 使用预创建的大视图 + subarray，baseOffset 已含 -1 修正 */
    return view.subarray(off[idx] - 1, off[idx + 1] - 1);
  }
  var size = off[idx + 1] - off[idx];
  var start = indexInfo.dataStart + off[idx] - 1;
  return new Uint8Array(reader.view.buffer, reader.view.byteOffset + start, size);
}

/**
 * 优化244: 为 parseCFFIndexOffsets 的结果预创建全量数据视图
 * 后续 readCFFIndexObject 将使用 subarray 替代 new Uint8Array
 */
function prepareCFFIndexView(reader, indexInfo) {
  var off = indexInfo.offsets;
  /** 优化303: 子集模式下 off[last] 未读，totalSize 由 parseCFFIndexOffsetsSubset 预先算好 */
  var totalSize = indexInfo._subsetMode ? indexInfo._totalSize : off && off.length >= 2 ? off[off.length - 1] - 1 : 0;
  if (totalSize <= 0) return;
  /** baseOffset 对齐原始 readCFFIndexObject 中的 byteOffset + dataStart + off[idx] - 1 */
  var baseOffset = reader.view.byteOffset + indexInfo.dataStart;
  indexInfo._view = new Uint8Array(reader.view.buffer, baseOffset, totalSize);
}

// Subroutines are encoded using the negative half of the number space.
// See type 2 chapter 4.7 "Subroutine operators".
function calcCFFSubroutineBias(subrs) {
  var bias;
  if (subrs.length < 1240) {
    bias = 107;
  } else if (subrs.length < 33900) {
    bias = 1131;
  } else {
    bias = 32768;
  }
  return bias;
}

/**
 * 解析原始 CFF Top DICT 获取 CID-keyed 字段的偏移
 * FDArray = 12 36, FDSelect = 12 37, ROS = 12 30
 *
 * @param  {Reader} reader 读取器
 * @param  {number} start   起始偏移
 * @param  {number} length  大小
 * @return {Object}         包含 FDArray/FDSelect 偏移的对象
 */
function parseRawTopDict(reader, start, length) {
  if (start) {
    reader.seek(start);
  }
  var entries = [];
  var operands = [];
  var lastOffset = reader.offset + length;
  while (reader.offset < lastOffset) {
    var op = reader.readUint8();
    if (op <= 21) {
      if (op === 12) {
        op = 1200 + reader.readUint8();
      }
      entries.push([op, operands]);
      operands = [];
    } else {
      operands.push(_parseCFFDict.default._parseOperand(reader, op));
    }
  }
  var result = {};
  for (var i = 0; i < entries.length; i++) {
    var key = entries[i][0];
    var values = entries[i][1];
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

/**
 * 解析 FDSelect 表，返回 ranges 和 format
 * subset 模式下不展开全量数组，改用二分查找按需获取 FD index
 *
 * @param  {Reader} reader 读取器
 * @param  {number} offset  FDSelect 相对于 CFF 起始的偏移
 * @return {Object}         { format, ranges, flatData }
 */
function parseFDSelect(reader, offset) {
  reader.seek(offset);
  var format = reader.readUint8();

  if (format === 0) {
    /** format 0：每个 glyph 一个 uint8 */
    var count = reader.readUint16();
    /**
     * 优化297: 直接以 buffer 视图引用整段 FDSelect0 数据，替代 count 次 readUint8 循环
     * 思源等大 CID 字体 count 可达 6 万+，逐字节读取占可观耗时
     */
    var dataStart = reader.view.byteOffset + reader.offset;
    var flatData = new Uint8Array(reader.view.buffer, dataStart, count);
    reader.offset += count;
    return { format: 0, ranges: null, flatData: flatData };
  }

  /** format 3：range 列表，存储为扁平数组 [first, fd, first, fd, ...] */
  var nRanges = reader.readUint16();
  var ranges = new Uint8Array(nRanges * 3);
  for (var r = 0; r < nRanges; r++) {
    var idx = r * 3;
    var first = reader.readUint16();
    ranges[idx] = first & 0xFF;
    ranges[idx + 1] = (first >> 8) & 0xFF;
    ranges[idx + 2] = reader.readUint8();
  }
  return { format: 3, ranges: ranges, flatData: null };
}

/**
 * 根据 parseFDSelect 的结果，查找指定 glyph 的 FD index
 * format 0 直接索引，format 3 二分查找
 */
function lookupFD(fdSelect, glyphIndex) {
  if (fdSelect.format === 0) {
    return fdSelect.flatData[glyphIndex] || 0;
  }
  /** format 3 二分查找 ranges */
  var ranges = fdSelect.ranges;
  /* 优化154: 缓存 numRanges 避免重复除法 */
  var numRanges = ranges.length / 3;
  var lo = 0;
  var hi = numRanges - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var idx = mid * 3;
    var first = ranges[idx] | (ranges[idx + 1] << 8);
    if (glyphIndex < first) {
      hi = mid - 1;
    } else {
      /** 检查是否在当前 range 内（即 < 下一个 range 的 first） */
      if (mid === numRanges - 1 || glyphIndex < (ranges[idx + 3] | (ranges[idx + 4] << 8))) {
        return ranges[idx + 2];
      }
      lo = mid + 1;
    }
  }
  return 0;
}

/**
 * 解析单个 FD (Font DICT) 的 Private DICT 和 local subrs
 *
 * @param  {Reader} reader      读取器
 * @param  {number} cffOffset   CFF 表起始偏移
 * @param  {Array}  fdDictData  FD 的原始字节数据
 * @param  {Array}  strings     CFF 字符串表
 * @return {Object}             { subrs, subrsBias, defaultWidthX, nominalWidthX }
 */
function parseFDPrivate(reader, cffOffset, fdDictData, strings) {
  var dictReader = new _reader.default(new Uint8Array(fdDictData).buffer);
  var fdDict = _parseCFFDict.default.parseCFFDict(dictReader, 0, dictReader.length);
  var result = { subrs: [], subrsBias: 0, defaultWidthX: 0, nominalWidthX: 0 };

  var privateData = fdDict[18];
  if (privateData && privateData.length >= 2) {
    var privLength = privateData[0];
    var privOffset = cffOffset + privateData[1];
    if (privLength > 0) {
      var privDict = _parseCFFDict.default.parsePrivateDict(reader, privOffset, privLength, strings);
      result.defaultWidthX = privDict.defaultWidthX || 0;
      result.nominalWidthX = privDict.nominalWidthX || 0;

      /** 修复：subrs 偏移量可能为 0（CFF 规范允许），
       *  原代码用 if (privDict.subrs) 检查，0 是 falsy 导致跳过 subrs 读取 */
      if (privDict.subrs != null && privDict.subrs > 0) {
        /**
         * 优化296+304: 完全惰性解析 local subrs
         * 思源等 CID 字体的单个 FD 可能含数万 subrs（实测 26550），全量读取 offset 表
         * （~10万次 readUint8）对 subset 是纯浪费——实际被引用的 subr 通常是个位数。
         * 改用 parseCFFIndexOffsetsLazy 只读 count + 末尾 offset（建大视图），
         * offsets 数组保持稀疏，readCFFIndexObject 按需 seek 填充命中的 subr。
         */
        var subrIndexInfo = parseCFFIndexOffsetsLazy(reader, privOffset + privDict.subrs);
        prepareCFFIndexView(reader, subrIndexInfo);
        var subrCount = subrIndexInfo.count;
        /**
         * 优化311: lazySubrs 用普通对象替代 new Array(subrCount)。
         * 思源单 FD subrs 可达 26550，new Array(26550) 分配 0.15ms；subset 仅引用个位数。
         * _resolveSubr 的按需填充对对象同样有效，bias 用 subrCount 单独计算。
         */
        var lazySubrs = {};
        result.subrs = lazySubrs;
        result.subrsBias = calcCFFSubroutineBias({ length: subrCount });
        /** 暴露按需解码器，parseCFFGlyph 访问 subrs[idx] 时调用 */
        result._resolveSubr = function (idx) {
          var s = lazySubrs[idx];
          if (s === undefined) {
            s = readCFFIndexObject(reader, subrIndexInfo, idx);
            lazySubrs[idx] = s;
          }
          return s;
        };
      }
    }
  }

  return result;
}

var _default = exports.default = _table.default.create('cff', [], {
  read: function read(reader, font) {
    var offset = this.offset;
    reader.seek(offset);
    var head = parseCFFHead(reader);
    var nameIndex = parseCFFIndex(reader, head.endOffset, _string.default.getString);
    var topDictIndex = parseCFFIndex(reader, nameIndex.endOffset);
    var stringIndex = parseCFFIndex(reader, topDictIndex.endOffset, _string.default.getString);
    var globalSubrIndex = parseCFFIndex(reader, stringIndex.endOffset);
    var cff = {
      head: head
    };

    // 全局子glyf数据
    cff.gsubrs = globalSubrIndex.objects;
    cff.gsubrsBias = calcCFFSubroutineBias(globalSubrIndex.objects);

    // 顶级字典数据
    var topDictData = topDictIndex.objects[0];
    /** 优化302: 复用 parseTopDict 内部的 parseCFFDict 结果，避免重复解析一遍 Top DICT */
    var dictReader = new _reader.default(new Uint8Array(topDictData).buffer);
    var topDict = _parseCFFDict.default.parseTopDict(dictReader, 0, dictReader.length, stringIndex.objects);
    cff.topDict = topDict;

    /** 从 parseTopDict 保留的原始 dict 获取 CID-keyed 字段 (FDArray=12 36 / FDSelect=12 37) */
    var rawTopDict = topDict._raw;
    var fdArrayOffset = rawTopDict[1236];
    var fdSelectOffset = rawTopDict[1237];
    var isCID = !!(fdArrayOffset && fdSelectOffset);

    /**
     * 优化303: subset 模式下提前构建 subsetGids（unicode→gid 映射，含 0=.notdef，升序）。
     * 后续 charstring index 与 charset 均复用此列表，避免各处重复构建。
     * 大 CID 字体（思源 65535 字形）的 charstring index 全量预读 offset 表需 ~2ms，
     * subset 仅引用极少字形，改用 parseCFFIndexOffsetsSubset 按需 seek 读取。
     */
    var subset = font.readOptions.subset;
    var subsetGids = null;
    if (subset && subset.length > 0) {
      var _codes = font.cmap;
      var _subsetMap = { 0: true };
      var _subsetGids = [0];
      for (var sci = 0, scl = subset.length; sci < scl; sci++) {
        var sGid = _codes[subset[sci]];
        if (sGid !== undefined && !_subsetMap[sGid]) {
          _subsetMap[sGid] = true;
          _subsetGids.push(sGid);
        }
      }
      subsetGids = _subsetGids.length > 1 ? _subsetGids.sort(function (a, b) {
        return a - b;
      }) : null;
    }

    /** 解析 FDSelect 和 FDArray（CID-keyed 字体） */
    var fdSelect = null;
    var fdPrivates = null;
    if (isCID) {
      /** 优化303: CID 字体的 charstring index 在 subset 模式按需预读，避免全量 offset 表扫描 */
      var charStringsInfo = subsetGids ? parseCFFIndexOffsetsSubset(reader, offset + topDict.charStrings, subsetGids) : parseCFFIndexOffsets(reader, offset + topDict.charStrings);
      var nGlyphs = charStringsInfo.count;

      fdSelect = parseFDSelect(reader, offset + fdSelectOffset);

      /**
       * 优化306: subset 模式下只解析被引用字形所属 FD 的 Private DICT + local subrs。
       * 思源等大 CID 字体含十余个 FD，subset 仅命中其中少数（常见 1-2 个），
       * 全量解析所有 FD 的 Private + 惰性 subrs index 是纯浪费。
       * 非 subset 模式仍全量解析（glyf 全量遍历会引用任意 FD）。
       */
      var fdArrayIndex = parseCFFIndex(reader, offset + fdArrayOffset);
      fdPrivates = new Array(fdArrayIndex.objects.length);
      if (subsetGids) {
        /** 收集 subsetGids 涉及的 FD index（含 0，.notdef 通常属 FD 0） */
        var neededFds = {};
        neededFds[0] = true;
        for (var fgi = 1; fgi < subsetGids.length; fgi++) {
          neededFds[lookupFD(fdSelect, subsetGids[fgi])] = true;
        }
        for (var fi = 0; fi < fdArrayIndex.objects.length; fi++) {
          if (neededFds[fi]) {
            fdPrivates[fi] = parseFDPrivate(reader, offset, fdArrayIndex.objects[fi], stringIndex.objects);
          }
        }
      } else {
        for (var fi = 0; fi < fdArrayIndex.objects.length; fi++) {
          fdPrivates.push(parseFDPrivate(reader, offset, fdArrayIndex.objects[fi], stringIndex.objects));
        }
      }
    }

    // 私有字典数据（非 CID 字体使用）
    var privateDictLength = topDict.private[0];
    var privateDict = {};
    var privateDictOffset;
    if (privateDictLength) {
      privateDictOffset = offset + topDict.private[1];
      privateDict = _parseCFFDict.default.parsePrivateDict(reader, privateDictOffset, privateDictLength, stringIndex.objects);
      cff.defaultWidthX = privateDict.defaultWidthX;
      cff.nominalWidthX = privateDict.nominalWidthX;
    } else {
      cff.defaultWidthX = 0;
      cff.nominalWidthX = 0;
    }

    // 私有子glyf数据（非 CID 字体使用）
    if (privateDict.subrs != null && privateDict.subrs > 0) {
      var subrOffset = privateDictOffset + privateDict.subrs;
      /** 优化296+304: 完全惰性解析 local subrs，offset 表按需 seek 读取 */
      var subrIndexInfo = parseCFFIndexOffsetsLazy(reader, subrOffset);
      prepareCFFIndexView(reader, subrIndexInfo);
      var nonCidSubrCount = subrIndexInfo.count;
      /** 优化311: 同 CID 路径，用对象替代 new Array 避免大 subrs 表的数组分配 */
      var nonCidLazySubrs = {};
      cff.subrs = nonCidLazySubrs;
      cff.subrsBias = calcCFFSubroutineBias({ length: nonCidSubrCount });
      cff._resolveSubr = function (idx) {
        var s = nonCidLazySubrs[idx];
        if (s === undefined) {
          s = readCFFIndexObject(reader, subrIndexInfo, idx);
          nonCidLazySubrs[idx] = s;
        }
        return s;
      };
    } else {
      cff.subrs = [];
      cff.subrsBias = 0;
    }
    cff.privateDict = privateDict;

    // 解析glyf数据和名字（统一使用延迟读取，避免大字体一次性读取全部 charstring）
    if (!isCID) {
      /** 优化303: 非 CID 字体同样在 subset 模式按需预读 charstring index */
      var charStringsInfo = subsetGids ? parseCFFIndexOffsetsSubset(reader, offset + topDict.charStrings, subsetGids) : parseCFFIndexOffsets(reader, offset + topDict.charStrings);
    }
    /** 优化244: 预创建全量 charstring 大视图，后续 readCFFIndexObject 用 subarray 替代 new Uint8Array */
    prepareCFFIndexView(reader, charStringsInfo);
    var nGlyphs = charStringsInfo.count;

    if (topDict.charset < 3) {
      cff.charset = _cffStandardStrings.default;
    } else {
      /**
       * 优化299+303: subset 模式下复用已构建的 subsetGids 传给 parseCFFCharset，
       * 使其只填充被引用 GID 的名字槽位，跳过数万无关 SID 的展开
       */
      cff.charset = (0, _parseCFFCharset.default)(reader, offset + topDict.charset, nGlyphs, stringIndex.objects, subsetGids);
    }

    // Standard encoding
    if (topDict.encoding === 0) {
      cff.encoding = _encoding.default.standardEncoding;
    }
    // Expert encoding
    else if (topDict.encoding === 1) {
      cff.encoding = _encoding.default.expertEncoding;
    } else {
      cff.encoding = (0, _parseCFFEncoding.default)(reader, offset + topDict.encoding);
    }
    cff.glyf = new Array(nGlyphs);

    /**
     * 为指定 glyph 构建 per-glyph 的 font 对象
     * 优化154: CID-keyed 字体预构建 per-FD font 对象缓存，避免每次分配
     */
    var fdGlyphFonts = null;
    if (isCID && fdSelect && fdPrivates) {
      fdGlyphFonts = new Array(fdPrivates.length);
      for (var fi = 0; fi < fdPrivates.length; fi++) {
        var fd = fdPrivates[fi];
        if (!fd) continue;
        fdGlyphFonts[fi] = {
          subrs: fd.subrs,
          subrsBias: fd.subrsBias,
          /** 优化296: 透传惰性 subrs 解码器 */
          _resolveSubr: fd._resolveSubr,
          defaultWidthX: fd.defaultWidthX,
          nominalWidthX: fd.nominalWidthX,
          gsubrs: cff.gsubrs,
          gsubrsBias: cff.gsubrsBias
        };
      }
    }
    function getGlyphFont(glyphIndex) {
      if (fdGlyphFonts) {
        var fdIdx = lookupFD(fdSelect, glyphIndex);
        var gfont = fdGlyphFonts[fdIdx];
        /**
         * 优化306: subset 模式下未预先解析的 FD 按需惰性解析。
         * 正常 subset 流程中所需 FD 已预先解析，此分支仅作 .notdef 等边界情况兜底。
         */
        if (!gfont && fdArrayIndex) {
          var fdData = fdArrayIndex.objects[fdIdx];
          if (fdData) {
            var lazyFd = parseFDPrivate(reader, offset, fdData, stringIndex.objects);
            fdPrivates[fdIdx] = lazyFd;
            gfont = {
              subrs: lazyFd.subrs,
              subrsBias: lazyFd.subrsBias,
              _resolveSubr: lazyFd._resolveSubr,
              defaultWidthX: lazyFd.defaultWidthX,
              nominalWidthX: lazyFd.nominalWidthX,
              gsubrs: cff.gsubrs,
              gsubrsBias: cff.gsubrsBias
            };
            fdGlyphFonts[fdIdx] = gfont;
          }
        }
        return gfont || cff;
      }
      return cff;
    }

    // only parse subset glyphs
    var subset = font.readOptions.subset;
    if (subset && subset.length > 0) {
      /**
       * 优化303: 复用外层已构建的 subsetGids 与 subsetMap，避免重复扫描 cmap。
       * subsetGids 为 null 表示仅有 .notdef（subset 未命中任何字形），退化为 [0]。
       */
      var finalSubsetGids = subsetGids || [0];
      var subsetMap = { 0: true };
      for (var smi = 1; smi < finalSubsetGids.length; smi++) {
        subsetMap[finalSubsetGids[smi]] = true;
      }
      font.subsetMap = subsetMap;
      /* 优化258: CID/non-CID 分支到循环外，消除每 glyph 的三元分支 */
      if (fdGlyphFonts) {
        for (var si = 0, sl = finalSubsetGids.length; si < sl; si++) {
          var i = finalSubsetGids[si];
          var charstring = readCFFIndexObject(reader, charStringsInfo, i);
          var glyf = (0, _parseCFFGlyph.default)(charstring, getGlyphFont(i), i);
          glyf.name = cff.charset[i];
          cff.glyf[i] = glyf;
        }
      } else {
        for (var si = 0, sl = finalSubsetGids.length; si < sl; si++) {
          var i = finalSubsetGids[si];
          var charstring = readCFFIndexObject(reader, charStringsInfo, i);
          var glyf = (0, _parseCFFGlyph.default)(charstring, cff, i);
          glyf.name = cff.charset[i];
          cff.glyf[i] = glyf;
        }
      }
      font.subsetGids = finalSubsetGids;
    }
    // parse all
    else {
      /* 优化202+230: 非 CID 字体直接使用 cff，缓存属性到局部变量 */
      var charset = cff.charset;
      var glyfArr = cff.glyf;
      if (fdGlyphFonts) {
        for (var i = 0, l = nGlyphs; i < l; i++) {
          var charstring = readCFFIndexObject(reader, charStringsInfo, i);
          var glyf = (0, _parseCFFGlyph.default)(charstring, getGlyphFont(i), i);
          glyf.name = charset[i];
          glyfArr[i] = glyf;
        }
      } else {
        for (var i = 0, l = nGlyphs; i < l; i++) {
          var charstring = readCFFIndexObject(reader, charStringsInfo, i);
          var glyf = (0, _parseCFFGlyph.default)(charstring, cff, i);
          glyf.name = charset[i];
          glyfArr[i] = glyf;
        }
      }
    }
    return cff;
  },
  // eslint-disable-next-line no-unused-vars
  write: function write(writer, font) {
    throw new Error('not support write cff table');
  },
  // eslint-disable-next-line no-unused-vars
  size: function size(font) {
    throw new Error('not support get cff table size');
  }
});
