"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file loca表
 * @author mengke01(kekee000@gmail.com)
 */
var _default = exports.default = _table.default.create('loca', [], {
  read: function read(reader, ttf) {
    var offset = this.offset;
    var indexToLocFormat = ttf.head.indexToLocFormat;
    /* 优化7: 直接 view 批量读取，预分配数组 */
    var numGlyphs = ttf.maxp.numGlyphs;
    var wordOffset = new Array(numGlyphs);
    var view = reader.view;
    if (indexToLocFormat === 0) {
      var vOffset = view.byteOffset + offset;
      for (var i = 0; i < numGlyphs; i++) {
        wordOffset[i] = view.getUint16(vOffset, false) * 2;
        vOffset += 2;
      }
    } else {
      var vOffset2 = view.byteOffset + offset;
      for (var j = 0; j < numGlyphs; j++) {
        wordOffset[j] = view.getUint32(vOffset2, false);
        vOffset2 += 4;
      }
    }
    reader.offset = offset + (indexToLocFormat === 0 ? numGlyphs * 2 : numGlyphs * 4);
    return wordOffset;
  },
  write: function write(writer, ttf) {
    var glyfSupport = ttf.support.glyf;
    var offset = ttf.support.glyf.offset || 0;
    var indexToLocFormat = ttf.head.indexToLocFormat;
    var numGlyphs = ttf.glyf.length;
    /* 优化29: 直接 view 批量写入 */
    var wView = writer.view;
    var pos = writer.offset;
    if (indexToLocFormat) {
      for (var i = 0; i <= numGlyphs; i++) {
        wView.setUint32(pos, offset, false);
        pos += 4;
        if (i < numGlyphs) {
          offset += glyfSupport[i].size;
        }
      }
    } else {
      /* 优化110: 短格式使用右移替代浮点乘 0.5 */
      for (var j = 0; j <= numGlyphs; j++) {
        wView.setUint16(pos, offset >> 1, false);
        pos += 2;
        if (j < numGlyphs) {
          offset += glyfSupport[j].size;
        }
      }
    }
    writer.offset = pos;
    return writer;
  },
  size: function size(ttf) {
    var locaCount = ttf.glyf.length + 1;
    return ttf.head.indexToLocFormat ? locaCount * 4 : locaCount * 2;
  }
});
