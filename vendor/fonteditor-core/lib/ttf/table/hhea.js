"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file hhea 表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6hhea.html
 */
var _default = exports.default = _table.default.create('hhea', [['version', _struct.default.Fixed], ['ascent', _struct.default.Int16], ['descent', _struct.default.Int16], ['lineGap', _struct.default.Int16], ['advanceWidthMax', _struct.default.Uint16], ['minLeftSideBearing', _struct.default.Int16], ['minRightSideBearing', _struct.default.Int16], ['xMaxExtent', _struct.default.Int16], ['caretSlopeRise', _struct.default.Int16], ['caretSlopeRun', _struct.default.Int16], ['caretOffset', _struct.default.Int16], ['reserved0', _struct.default.Int16], ['reserved1', _struct.default.Int16], ['reserved2', _struct.default.Int16], ['reserved3', _struct.default.Int16], ['metricDataFormat', _struct.default.Int16], ['numOfLongHorMetrics', _struct.default.Uint16]], {
  size: function () { return 36; },
  /** 优化178: 全部内联 view 读取 36 字节 */
  read: function (reader) {
    reader.seek(this.offset);
    var v = reader.view;
    var o = reader.offset;
    this.version = v.getInt32(o, false) / 65536; o += 4;
    this.ascent = v.getInt16(o, false); o += 2;
    this.descent = v.getInt16(o, false); o += 2;
    this.lineGap = v.getInt16(o, false); o += 2;
    this.advanceWidthMax = v.getUint16(o, false); o += 2;
    this.minLeftSideBearing = v.getInt16(o, false); o += 2;
    this.minRightSideBearing = v.getInt16(o, false); o += 2;
    this.xMaxExtent = v.getInt16(o, false); o += 2;
    this.caretSlopeRise = v.getInt16(o, false); o += 2;
    this.caretSlopeRun = v.getInt16(o, false); o += 2;
    this.caretOffset = v.getInt16(o, false); o += 2;
    o += 8; /* reserved0-3 */
    this.metricDataFormat = v.getInt16(o, false); o += 2;
    this.numOfLongHorMetrics = v.getUint16(o, false); o += 2;
    reader.offset = o;
    return {
      version: this.version, ascent: this.ascent, descent: this.descent,
      lineGap: this.lineGap, advanceWidthMax: this.advanceWidthMax,
      minLeftSideBearing: this.minLeftSideBearing, minRightSideBearing: this.minRightSideBearing,
      xMaxExtent: this.xMaxExtent, caretSlopeRise: this.caretSlopeRise,
      caretSlopeRun: this.caretSlopeRun, caretOffset: this.caretOffset,
      metricDataFormat: this.metricDataFormat, numOfLongHorMetrics: this.numOfLongHorMetrics
    };
  },
  write: function (writer, ttf) {
    var h = ttf.hhea;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, h.version * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt16(pos, h.ascent, false); pos += 2;
    view.setInt16(pos, h.descent, false); pos += 2;
    view.setInt16(pos, h.lineGap, false); pos += 2;
    view.setUint16(pos, h.advanceWidthMax, false); pos += 2;
    view.setInt16(pos, h.minLeftSideBearing, false); pos += 2;
    view.setInt16(pos, h.minRightSideBearing, false); pos += 2;
    view.setInt16(pos, h.xMaxExtent, false); pos += 2;
    view.setInt16(pos, h.caretSlopeRise, false); pos += 2;
    view.setInt16(pos, h.caretSlopeRun, false); pos += 2;
    view.setInt16(pos, h.caretOffset, false); pos += 2;
    pos += 8; /* reserved0-3 */
    view.setInt16(pos, h.metricDataFormat, false); pos += 2;
    view.setUint16(pos, h.numOfLongHorMetrics, false); pos += 2;
    writer.offset = pos;
    return writer;
  }
});
