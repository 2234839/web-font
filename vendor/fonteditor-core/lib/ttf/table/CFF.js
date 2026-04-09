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
  var offsets = [];
  var objects = [];
  var count = reader.readUint16();
  var i;
  var l;
  if (count !== 0) {
    var offsetSize = reader.readUint8();
    for (i = 0, l = count + 1; i < l; i++) {
      offsets.push(getOffset(reader, offsetSize));
    }
    for (i = 0, l = count; i < l; i++) {
      var value = reader.readBytes(offsets[i + 1] - offsets[i]);
      if (conversionFn) {
        value = conversionFn(value);
      }
      objects.push(value);
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
    for (var i = 0; i <= count; i++) {
      offsets[i] = getOffset(reader, offsetSize);
    }
  }
  return { offsets: offsets, count: count, dataStart: reader.offset, endOffset: reader.offset };
}

/**
 * 根据 parseCFFIndexOffsets 的结果，按需读取第 idx 个 object
 *
 * @param  {Reader} reader       读取器
 * @param  {Object} indexInfo    parseCFFIndexOffsets 返回的信息
 * @param  {number} idx           object 索引（0-based）
 * @return {Uint8Array}          object 数据
 */
function readCFFIndexObject(reader, indexInfo, idx) {
  var off = indexInfo.offsets;
  var size = off[idx + 1] - off[idx];
  reader.seek(indexInfo.dataStart + off[idx] - 1);
  return reader.readBytes(size);
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
    /** format 0：每个 glyph 一个 uint8，存储为扁平数组 */
    var count = reader.readUint16();
    var flatData = new Uint8Array(count);
    for (var i = 0; i < count; i++) {
      flatData[i] = reader.readUint8();
    }
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
  var lo = 0;
  var hi = (ranges.length / 3) - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var idx = mid * 3;
    var first = ranges[idx] | (ranges[idx + 1] << 8);
    if (glyphIndex < first) {
      hi = mid - 1;
    } else {
      /** 检查是否在当前 range 内（即 < 下一个 range 的 first） */
      if (mid === (ranges.length / 3) - 1 || glyphIndex < (ranges[idx + 3] | (ranges[idx + 4] << 8))) {
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

      if (privDict.subrs) {
        var subrIndex = parseCFFIndex(reader, privOffset + privDict.subrs);
        result.subrs = subrIndex.objects;
        result.subrsBias = calcCFFSubroutineBias(result.subrs);
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
    var dictReader = new _reader.default(new Uint8Array(topDictData).buffer);
    var rawTopDict = _parseCFFDict.default.parseCFFDict(dictReader, 0, dictReader.length);
    /** 复用同一个 Reader 和解析结果构建 topDict，避免创建第二个 Reader */
    dictReader.seek(0);
    var topDict = _parseCFFDict.default.parseTopDict(dictReader, 0, dictReader.length, stringIndex.objects);
    cff.topDict = topDict;

    /** 从已解析的原始 Top DICT 获取 CID-keyed 字段 (FDArray/FDSelect) */
    var fdArrayOffset = rawTopDict[1236]; // 12 36
    var fdSelectOffset = rawTopDict[1237]; // 12 37
    var isCID = !!(fdArrayOffset && fdSelectOffset);

    /** 解析 FDSelect 和 FDArray（CID-keyed 字体） */
    var fdSelect = null;
    var fdPrivates = null;
    if (isCID) {
      /** 优化：只读取偏移表，不读取全部 charstring 数据 */
      var charStringsInfo = parseCFFIndexOffsets(reader, offset + topDict.charStrings);
      var nGlyphs = charStringsInfo.count;

      fdSelect = parseFDSelect(reader, offset + fdSelectOffset);

      /** 解析 FDArray */
      var fdArrayIndex = parseCFFIndex(reader, offset + fdArrayOffset);
      fdPrivates = [];
      for (var fi = 0; fi < fdArrayIndex.objects.length; fi++) {
        fdPrivates.push(parseFDPrivate(reader, offset, fdArrayIndex.objects[fi], stringIndex.objects));
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
    if (privateDict.subrs) {
      var subrOffset = privateDictOffset + privateDict.subrs;
      var subrIndex = parseCFFIndex(reader, subrOffset);
      cff.subrs = subrIndex.objects;
      cff.subrsBias = calcCFFSubroutineBias(cff.subrs);
    } else {
      cff.subrs = [];
      cff.subrsBias = 0;
    }
    cff.privateDict = privateDict;

    // 解析glyf数据和名字（统一使用延迟读取，避免大字体一次性读取全部 charstring）
    if (!isCID) {
      var charStringsInfo = parseCFFIndexOffsets(reader, offset + topDict.charStrings);
    }
    var nGlyphs = charStringsInfo.count;

    if (topDict.charset < 3) {
      cff.charset = _cffStandardStrings.default;
    } else {
      cff.charset = (0, _parseCFFCharset.default)(reader, offset + topDict.charset, nGlyphs, stringIndex.objects);
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
    cff.glyf = [];

    /**
     * 为指定 glyph 构建 per-glyph 的 font 对象
     * CID-keyed 字体使用 FD 对应的 local subrs
     */
    function getGlyphFont(glyphIndex) {
      if (isCID && fdSelect && fdPrivates) {
        var fdIdx = lookupFD(fdSelect, glyphIndex);
        var fd = fdPrivates[fdIdx];
        return {
          subrs: fd.subrs,
          subrsBias: fd.subrsBias,
          defaultWidthX: fd.defaultWidthX,
          nominalWidthX: fd.nominalWidthX,
          gsubrs: cff.gsubrs,
          gsubrsBias: cff.gsubrsBias
        };
      }
      return cff;
    }

    // only parse subset glyphs
    var subset = font.readOptions.subset;
    if (subset && subset.length > 0) {
      // subset map
      var subsetMap = {
        0: true // 设置.notdef
      };
      var codes = font.cmap;

      // unicode to index
      Object.keys(codes).forEach(function (c) {
        if (subset.indexOf(+c) > -1) {
          var i = codes[c];
          subsetMap[i] = true;
        }
      });
      font.subsetMap = subsetMap;
      Object.keys(subsetMap).forEach(function (i) {
        i = +i;
        var charstring = readCFFIndexObject(reader, charStringsInfo, i);
        var glyf = (0, _parseCFFGlyph.default)(charstring, getGlyphFont(i), i);
        glyf.name = cff.charset[i];
        cff.glyf[i] = glyf;
      });
    }
    // parse all
    else {
      for (var i = 0, l = nGlyphs; i < l; i++) {
        var charstring = readCFFIndexObject(reader, charStringsInfo, i);
        var glyf = (0, _parseCFFGlyph.default)(charstring, getGlyphFont(i), i);
        glyf.name = cff.charset[i];
        cff.glyf.push(glyf);
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
