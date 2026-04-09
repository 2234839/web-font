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
 * 解析 FDSelect 表，返回 glyph index → FD index 的映射
 * 支持 format 0 和 format 3
 *
 * @param  {Reader} reader 读取器
 * @param  {number} offset  FDSelect 相对于 CFF 起始的偏移
 * @param  {number} nGlyphs glyph 总数
 * @return {Array}          FD index 数组，fdSelect[i] = glyph i 对应的 FD index
 */
function parseFDSelect(reader, offset, nGlyphs) {
  reader.seek(offset);
  var format = reader.readUint8();
  var fdSelect = [];

  if (format === 0) {
    for (var i = 0; i < nGlyphs; i++) {
      fdSelect.push(reader.readUint8());
    }
  } else if (format === 3) {
    var nRanges = reader.readUint16();
    var ranges = [];
    for (var r = 0; r < nRanges; r++) {
      ranges.push({
        first: reader.readUint16(),
        fd: reader.readUint8()
      });
    }
    /** sentinel = reader.readUint16(); */

    /** 根据 ranges 构建 fdSelect 数组 */
    for (var i = 0; i < nGlyphs; i++) {
      var fd = 0;
      for (var ri = ranges.length - 1; ri >= 0; ri--) {
        if (i >= ranges[ri].first) {
          fd = ranges[ri].fd;
          break;
        }
      }
      fdSelect.push(fd);
    }
  }

  return fdSelect;
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
    var dictReader = new _reader.default(new Uint8Array(topDictIndex.objects[0]).buffer);
    var topDict = _parseCFFDict.default.parseTopDict(dictReader, 0, dictReader.length, stringIndex.objects);
    cff.topDict = topDict;

    /** 解析原始 Top DICT 获取 CID-keyed 字段 (FDArray/FDSelect) */
    var rawTopDict = parseRawTopDict(
      new _reader.default(new Uint8Array(topDictIndex.objects[0]).buffer),
      0, new Uint8Array(topDictIndex.objects[0]).buffer.byteLength
    );
    var fdArrayOffset = rawTopDict[1236]; // 12 36
    var fdSelectOffset = rawTopDict[1237]; // 12 37
    var isCID = !!(fdArrayOffset && fdSelectOffset);

    /** 解析 FDSelect 和 FDArray（CID-keyed 字体） */
    var fdSelect = null;
    var fdPrivates = null;
    if (isCID) {
      var charStringsIndex = parseCFFIndex(reader, offset + topDict.charStrings);
      var nGlyphs = charStringsIndex.objects.length;

      fdSelect = parseFDSelect(reader, offset + fdSelectOffset, nGlyphs);

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

    // 解析glyf数据和名字
    if (!isCID) {
      var charStringsIndex = parseCFFIndex(reader, offset + topDict.charStrings);
    }
    var nGlyphs = charStringsIndex.objects.length;

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
        var fdIdx = fdSelect[glyphIndex] || 0;
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
        var glyf = (0, _parseCFFGlyph.default)(charStringsIndex.objects[i], getGlyphFont(i), i);
        glyf.name = cff.charset[i];
        cff.glyf[i] = glyf;
      });
    }
    // parse all
    else {
      for (var i = 0, l = nGlyphs; i < l; i++) {
        var glyf = (0, _parseCFFGlyph.default)(charStringsIndex.objects[i], getGlyphFont(i), i);
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
