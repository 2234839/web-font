"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
var _string = _interopRequireDefault(require("../util/string"));
var _unicodeName = _interopRequireDefault(require("../enum/unicodeName"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file post 表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6post.html
 */

var Posthead = _table.default.create('posthead', [['format', _struct.default.Fixed], ['italicAngle', _struct.default.Fixed], ['underlinePosition', _struct.default.Int16], ['underlineThickness', _struct.default.Int16], ['isFixedPitch', _struct.default.Uint32], ['minMemType42', _struct.default.Uint32], ['maxMemType42', _struct.default.Uint32], ['minMemType1', _struct.default.Uint32], ['maxMemType1', _struct.default.Uint32]]);

/** 优化287: 空名常量，避免每次 push [0] 普通数组导致 writeBytes 慢路径 */
var EMPTY_PASCAL = new Uint8Array([0]);

/**
 * 优化64+252: 从原始字节按需提取单个 pascal string，使用 fromCharCode.apply 替代数组+join
 */
function getPascalStringAt(bytes, offset) {
  var length = bytes[offset];
  if (length === 0) return '';
  var chars = new Array(length);
  for (var i = 0; i < length; i++) {
    chars[i] = bytes[offset + 1 + i];
  }
  return String.fromCharCode.apply(null, chars);
}

var _default = exports.default = _table.default.create('post', [], {
  read: function read(reader, ttf) {
    var tbl = new Posthead(this.offset).read(reader, ttf);
    var format = tbl.format;

    if (format === 2) {
      var numberOfGlyphs = reader.readUint16();
      /* 优化60: 直接 view 批量读取 glyphNameIndex */
      var view = reader.view;
      var vOffset = view.byteOffset + reader.offset;
      var pascalStringOffset = reader.offset + numberOfGlyphs * 2;
      var pascalStringLength = ttf.tables.post.length - (pascalStringOffset - this.offset);
      var pascalStringBytes = reader.readBytes(pascalStringOffset, pascalStringLength);

      /* 优化87: subset 模式下只读取子集字形的 nameIndex，跳过其余 */
      if (ttf.readOptions && ttf.readOptions.subset) {
        tbl._pascalStringBytes = pascalStringBytes;
        tbl._pascalStringOffsets = null;
        tbl.nameIndex = null;
        tbl.names = null;
        /* 保存 view 引用和偏移量，供后续按需读取 nameIndex */
        tbl._nameIndexViewOffset = vOffset;
        tbl._nameIndexView = view;
      } else {
        var glyphNameIndex = new Array(numberOfGlyphs);
        for (var i = 0; i < numberOfGlyphs; i++) {
          glyphNameIndex[i] = view.getUint16(vOffset, false);
          vOffset += 2;
        }
        tbl.nameIndex = glyphNameIndex;
        tbl.names = _string.default.getPascalString(pascalStringBytes);
      }
    }
    else if (format === 2.5) {
      tbl.format = 3;
    }
    return tbl;
  },
  write: function write(writer, ttf) {
    var post = ttf.post || {
      format: 3
    };

    /* 优化77: post header 直接 view 写入 32 字节 */
    var view = writer.view;
    var pos = writer.offset;
    view.setInt32(pos, post.format * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt32(pos, (post.italicAngle || 0) * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt16(pos, post.underlinePosition || 0, false); pos += 2;
    view.setInt16(pos, post.underlineThickness || 0, false); pos += 2;
    view.setUint32(pos, post.isFixedPitch || 0, false); pos += 4;
    view.setUint32(pos, post.minMemType42 || 0, false); pos += 4;
    view.setUint32(pos, post.maxMemType42 || 0, false); pos += 4;
    view.setUint32(pos, post.minMemType1 || 0, false); pos += 4;
    view.setUint32(pos, post.maxMemType1 || 0, false); pos += 4;

    if (post.format === 2) {
      var numberOfGlyphs = ttf.glyf.length;
      view.setUint16(pos, numberOfGlyphs, false); pos += 2;
      /* 优化77: nameIndex 直接 view 批量写入 */
      var nameIndex = ttf.support.post.nameIndex;
      for (var i = 0, l = nameIndex.length; i < l; i++) {
        view.setUint16(pos, nameIndex[i], false); pos += 2;
      }
      writer.offset = pos;
      /** 优化287: 创建一次 Uint8Array 视图，直接 set 替代 writer.writeBytes */
      var names = ttf.support.post.names;
      var uv = new Uint8Array(writer.getBuffer());
      for (var j = 0, jl = names.length; j < jl; j++) {
        var nameBytes = names[j];
        uv.set(nameBytes, pos);
        pos += nameBytes.length;
      }
      writer.offset = pos;
    } else {
      writer.offset = pos;
    }
  },
  size: function size(ttf) {
    var numberOfGlyphs = ttf.glyf.length;
    ttf.post = ttf.post || {};
    ttf.post.format = ttf.post.format || 3;
    ttf.post.maxMemType1 = numberOfGlyphs;

    /* 优化109: format 3/1 不需要 nameIndex/names 计算 */
    if (ttf.post.format === 3 || ttf.post.format === 1) {
      ttf.support.post = {};
      return 32;
    }

    var size = 34 + numberOfGlyphs * 2;
    var glyphNames = [];
    var nameIndexArr = new Array(numberOfGlyphs);
    var nameIndex = 0;

    for (var i = 0; i < numberOfGlyphs; i++) {
      if (i === 0) {
        nameIndexArr[i] = 0;
      } else {
        var glyf = ttf.glyf[i];
        var unicode = glyf.unicode ? glyf.unicode[0] : 0;
        var unicodeNameIndex = _unicodeName.default[unicode];
        if (undefined !== unicodeNameIndex) {
          nameIndexArr[i] = unicodeNameIndex;
        } else {
          var name = glyf.name;
          if (!name || name.charCodeAt(0) < 32) {
            nameIndexArr[i] = 258 + nameIndex++;
            glyphNames.push(EMPTY_PASCAL);
            size++;
          } else {
            nameIndexArr[i] = 258 + nameIndex++;
            var bytes = _string.default.toPascalStringBytes(name);
            glyphNames.push(bytes);
            size += bytes.length;
          }
        }
      }
    }
    ttf.support.post = {
      nameIndex: nameIndexArr,
      names: glyphNames
    };
    return size;
  }
});

/** 按需获取单个 pascal string name（供 ttfreader.js 使用） */
exports.getPascalStringAt = getPascalStringAt;
