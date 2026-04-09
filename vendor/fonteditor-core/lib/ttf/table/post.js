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

/**
 * 优化64: 从原始字节按需提取单个 pascal string
 */
function getPascalStringAt(bytes, offset) {
  var length = bytes[offset];
  if (length === 0) return '';
  var chars = new Array(length);
  for (var i = 0; i < length; i++) {
    chars[i] = String.fromCharCode(bytes[offset + 1 + i]);
  }
  return chars.join('');
}

var _default = exports.default = _table.default.create('post', [], {
  read: function read(reader, ttf) {
    var format = reader.readFixed(this.offset);
    var tbl = new Posthead(this.offset).read(reader, ttf);

    if (format === 2) {
      var numberOfGlyphs = reader.readUint16();
      /* 优化60: 直接 view 批量读取 glyphNameIndex */
      var view = reader.view;
      var vOffset = view.byteOffset + reader.offset;
      var glyphNameIndex = new Array(numberOfGlyphs);
      for (var i = 0; i < numberOfGlyphs; i++) {
        glyphNameIndex[i] = view.getUint16(vOffset, false);
        vOffset += 2;
      }
      var pascalStringOffset = vOffset - view.byteOffset;
      var pascalStringLength = ttf.tables.post.length - (pascalStringOffset - this.offset);
      var pascalStringBytes = reader.readBytes(pascalStringOffset, pascalStringLength);

      tbl.nameIndex = glyphNameIndex;

      /* 优化64: subset 模式下保存原始字节，按需解析 */
      if (ttf.readOptions && ttf.readOptions.subset) {
        tbl._pascalStringBytes = pascalStringBytes;
        tbl._pascalStringOffsets = [];
        var off = 0;
        for (var j = 0; j < numberOfGlyphs; j++) {
          tbl._pascalStringOffsets[j] = off;
          off += 1 + (pascalStringBytes[off] || 0);
        }
        tbl.names = null;
      } else {
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

    writer.writeFixed(post.format);
    writer.writeFixed(post.italicAngle || 0);
    writer.writeInt16(post.underlinePosition || 0);
    writer.writeInt16(post.underlineThickness || 0);
    writer.writeUint32(post.isFixedPitch || 0);
    writer.writeUint32(post.minMemType42 || 0);
    writer.writeUint32(post.maxMemType42 || 0);
    writer.writeUint32(post.minMemType1 || 0);
    writer.writeUint32(post.maxMemType1 || 0);

    if (post.format === 2) {
      var numberOfGlyphs = ttf.glyf.length;
      writer.writeUint16(numberOfGlyphs);
      var nameIndex = ttf.support.post.nameIndex;
      for (var i = 0, l = nameIndex.length; i < l; i++) {
        writer.writeUint16(nameIndex[i]);
      }
      var names = ttf.support.post.names;
      for (var j = 0, jl = names.length; j < jl; j++) {
        writer.writeBytes(names[j]);
      }
    }
  },
  size: function size(ttf) {
    var numberOfGlyphs = ttf.glyf.length;
    ttf.post = ttf.post || {};
    ttf.post.format = ttf.post.format || 3;
    ttf.post.maxMemType1 = numberOfGlyphs;

    if (ttf.post.format === 3 || ttf.post.format === 1) {
      return 32;
    }

    var size = 34 + numberOfGlyphs * 2;
    var glyphNames = [];
    var nameIndexArr = [];
    var nameIndex = 0;

    for (var i = 0; i < numberOfGlyphs; i++) {
      if (i === 0) {
        nameIndexArr.push(0);
      } else {
        var glyf = ttf.glyf[i];
        var unicode = glyf.unicode ? glyf.unicode[0] : 0;
        var unicodeNameIndex = _unicodeName.default[unicode];
        if (undefined !== unicodeNameIndex) {
          nameIndexArr.push(unicodeNameIndex);
        } else {
          var name = glyf.name;
          if (!name || name.charCodeAt(0) < 32) {
            nameIndexArr.push(258 + nameIndex++);
            glyphNames.push([0]);
            size++;
          } else {
            nameIndexArr.push(258 + nameIndex++);
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
