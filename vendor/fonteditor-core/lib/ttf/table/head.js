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
  /** 优化178: 全部内联 view 读取 54 字节，LongDateTime 存储为毫秒时间戳 */
  read: function (reader) {
    reader.seek(this.offset);
    var v = reader.view;
    var o = reader.offset;
    var base = -2082844800000;
    this.version = v.getInt32(o, false) / 65536; o += 4;
    this.fontRevision = v.getInt32(o, false) / 65536; o += 4;
    this.checkSumAdjustment = v.getUint32(o, false); o += 4;
    this.magickNumber = v.getUint32(o, false); o += 4;
    this.flags = v.getUint16(o, false); o += 2;
    this.unitsPerEm = v.getUint16(o, false); o += 2;
    this.created = base + v.getUint32(o + 4, false) * 1000; o += 8;
    this.modified = base + v.getUint32(o + 4, false) * 1000; o += 8;
    this.xMin = v.getInt16(o, false); o += 2;
    this.yMin = v.getInt16(o, false); o += 2;
    this.xMax = v.getInt16(o, false); o += 2;
    this.yMax = v.getInt16(o, false); o += 2;
    this.macStyle = v.getUint16(o, false); o += 2;
    this.lowestRecPPEM = v.getUint16(o, false); o += 2;
    this.fontDirectionHint = v.getInt16(o, false); o += 2;
    this.indexToLocFormat = v.getInt16(o, false); o += 2;
    this.glyphDataFormat = v.getInt16(o, false); o += 2;
    reader.offset = o;
    return {
      version: this.version, fontRevision: this.fontRevision,
      checkSumAdjustment: this.checkSumAdjustment, magickNumber: this.magickNumber,
      flags: this.flags, unitsPerEm: this.unitsPerEm,
      created: this.created, modified: this.modified,
      xMin: this.xMin, yMin: this.yMin, xMax: this.xMax, yMax: this.yMax,
      macStyle: this.macStyle, lowestRecPPEM: this.lowestRecPPEM,
      fontDirectionHint: this.fontDirectionHint, indexToLocFormat: this.indexToLocFormat,
      glyphDataFormat: this.glyphDataFormat
    };
  },
  /** 优化178: 全部内联 view 写入 54 字节，包括 LongDateTime */
  write: function (writer, ttf) {
    var head = ttf.head;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, head.version * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt32(pos, head.fontRevision * 65536 + 0.5 | 0, false); pos += 4;
    view.setUint32(pos, head.checkSumAdjustment, false); pos += 4;
    view.setUint32(pos, head.magickNumber, false); pos += 4;
    view.setUint16(pos, head.flags, false); pos += 2;
    view.setUint16(pos, head.unitsPerEm, false); pos += 2;
    /** 优化216: 内联 writeLDT，消除函数定义+调用开销 */
    var delta = -2077545600000;
    var cMs = typeof head.created.getTime === 'function' ? head.created.getTime() : typeof head.created === 'number' ? head.created : Date.parse(head.created);
    view.setUint32(pos, 0, false); pos += 4;
    view.setUint32(pos, Math.round((cMs - delta) / 1000), false); pos += 4;
    var mMs = typeof head.modified.getTime === 'function' ? head.modified.getTime() : typeof head.modified === 'number' ? head.modified : Date.parse(head.modified);
    view.setUint32(pos, 0, false); pos += 4;
    view.setUint32(pos, Math.round((mMs - delta) / 1000), false); pos += 4;
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
