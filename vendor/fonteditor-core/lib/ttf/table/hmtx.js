"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file hmtx 表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6hmtx.html
 */
var _default = exports.default = _table.default.create('hmtx', [], {
  read: function read(reader, ttf) {
    var offset = this.offset;
    reader.seek(offset);
    var numOfLongHorMetrics = ttf.hhea.numOfLongHorMetrics;
    var numGlyphs = ttf.maxp.numGlyphs;
    /* 优化10+82: 扁平数组 [advW, lsb, advW, lsb, ...]，消除对象分配 */
    var hMetrics = new Int32Array(numGlyphs * 2);
    var view = reader.view;
    var vOffset = view.byteOffset + offset;
    for (var i = 0; i < numOfLongHorMetrics; i++) {
      var idx = i * 2;
      hMetrics[idx] = view.getUint16(vOffset, false);
      hMetrics[idx + 1] = view.getInt16(vOffset + 2, false);
      vOffset += 4;
    }
    var lastAdvW = hMetrics[(numOfLongHorMetrics - 1) * 2];
    var numOfLast = numGlyphs - numOfLongHorMetrics;
    for (var j = 0; j < numOfLast; j++) {
      var idx2 = (numOfLongHorMetrics + j) * 2;
      hMetrics[idx2] = lastAdvW;
      hMetrics[idx2 + 1] = view.getInt16(vOffset, false);
      vOffset += 2;
    }
    reader.offset = offset + numOfLongHorMetrics * 4 + numOfLast * 2;
    return hMetrics;
  },
  write: function write(writer, ttf) {
    var i;
    var numOfLongHorMetrics = ttf.hhea.numOfLongHorMetrics;
    /* 优化30+82: 直接 view 批量写入 */
    var wView = writer.view;
    var pos = writer.offset;
    var glyfs = ttf.glyf;
    for (i = 0; i < numOfLongHorMetrics; i++) {
      wView.setUint16(pos, glyfs[i].advanceWidth, false);
      wView.setInt16(pos + 2, glyfs[i].leftSideBearing, false);
      pos += 4;
    }
    var numOfLast = glyfs.length - numOfLongHorMetrics;
    for (i = 0; i < numOfLast; i++) {
      wView.setInt16(pos, glyfs[numOfLongHorMetrics + i].leftSideBearing, false);
      pos += 2;
    }
    writer.offset = pos;
    return writer;
  },
  size: function size(ttf) {
    var numOfLast = 0;
    var advanceWidth = ttf.glyf[ttf.glyf.length - 1].advanceWidth;
    for (var i = ttf.glyf.length - 2; i >= 0; i--) {
      if (advanceWidth === ttf.glyf[i].advanceWidth) {
        numOfLast++;
      } else {
        break;
      }
    }
    ttf.hhea.numOfLongHorMetrics = ttf.glyf.length - numOfLast;
    return 4 * ttf.hhea.numOfLongHorMetrics + 2 * numOfLast;
  }
});
