"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file head表
 * @author mengke01(kekee000@gmail.com)
 */
var _default = exports.default = _table.default.create('head', [['version', _struct.default.Fixed], ['fontRevision', _struct.default.Fixed], ['checkSumAdjustment', _struct.default.Uint32], ['magickNumber', _struct.default.Uint32], ['flags', _struct.default.Uint16], ['unitsPerEm', _struct.default.Uint16], ['created', _struct.default.LongDateTime], ['modified', _struct.default.LongDateTime], ['xMin', _struct.default.Int16], ['yMin', _struct.default.Int16], ['xMax', _struct.default.Int16], ['yMax', _struct.default.Int16], ['macStyle', _struct.default.Uint16], ['lowestRecPPEM', _struct.default.Uint16], ['fontDirectionHint', _struct.default.Int16], ['indexToLocFormat', _struct.default.Int16], ['glyphDataFormat', _struct.default.Int16]], {
  size: function () { return 54; },
  /** 优化178: 全部内联 view 写入 54 字节，包括 LongDateTime */
  write: function (writer, ttf) {
    var head = ttf.head;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, Math.round(head.version * 65536), false); pos += 4;
    view.setInt32(pos, Math.round(head.fontRevision * 65536), false); pos += 4;
    view.setUint32(pos, head.checkSumAdjustment, false); pos += 4;
    view.setUint32(pos, head.magickNumber, false); pos += 4;
    view.setUint16(pos, head.flags, false); pos += 2;
    view.setUint16(pos, head.unitsPerEm, false); pos += 2;
    /** LongDateTime 内联: 1904-01-01 基准，8字节 (高4字节=0, 低4字节=秒数) */
    var delta = -2077545600000;
    function writeLDT(value, p) {
      var ms = typeof value.getTime === 'function' ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
      view.setUint32(p, 0, false);
      view.setUint32(p + 4, Math.round((ms - delta) / 1000), false);
      return p + 8;
    }
    pos = writeLDT(head.created, pos);
    pos = writeLDT(head.modified, pos);
    view.setInt16(pos, head.xMin, false); pos += 2;
    view.setInt16(pos, head.yMin, false); pos += 2;
    view.setInt16(pos, head.xMax, false); pos += 2;
    view.setInt16(pos, head.yMax, false); pos += 2;
    view.setUint16(pos, head.macStyle, false); pos += 2;
    view.setUint16(pos, head.lowestRecPPEM, false); pos += 2;
    view.setInt16(pos, head.fontDirectionHint, false); pos += 2;
    view.setInt16(pos, head.indexToLocFormat, false); pos += 2;
    view.setInt16(pos, head.glyphDataFormat, false); pos += 2;
    writer.offset = pos;
    return writer;
  }
});
