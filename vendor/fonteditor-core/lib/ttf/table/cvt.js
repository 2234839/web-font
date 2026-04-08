"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file cvt表
 * @author mengke01(kekee000@gmail.com)
 *
 * @reference: https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6cvt.html
 */
var _default = exports.default = _table.default.create('cvt', [], {
  read: function read(reader, ttf) {
    var length = ttf.tables.cvt.length;
    return reader.readBytes(this.offset, length);
  },
  write: function write(writer, ttf) {
    if (ttf.cvt) {
      writer.writeBytes(ttf.cvt, ttf.cvt.length);
    }
  },
  size: function size(ttf) {
    return ttf.cvt ? ttf.cvt.length : 0;
  }
});