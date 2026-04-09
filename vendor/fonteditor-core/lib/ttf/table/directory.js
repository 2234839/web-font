"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file directory 表, 读取和写入ttf表索引
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6.html
 */
var _default = exports.default = _table.default.create('directory', [], {
  read: function read(reader, ttf) {
    var tables = {};
    var numTables = ttf.numTables;
    var offset = this.offset;
    /* 优化26: 直接 view 批量读取 */
    var view = reader.view;
    var vOffset = view.byteOffset + offset;
    for (var i = 0; i < numTables; i++) {
      var name = String.fromCharCode(
        view.getUint8(vOffset), view.getUint8(vOffset + 1),
        view.getUint8(vOffset + 2), view.getUint8(vOffset + 3)
      ).trim();
      tables[name] = {
        name: name,
        checkSum: view.getUint32(vOffset + 4, false),
        offset: view.getUint32(vOffset + 8, false),
        length: view.getUint32(vOffset + 12, false)
      };
      vOffset += 16;
    }
    reader.offset = offset + numTables * 16;
    return tables;
  },
  write: function write(writer, ttf) {
    var tables = ttf.support.tables;
    for (var i = 0, l = tables.length; i < l; i++) {
      writer.writeString((tables[i].name + '    ').slice(0, 4));
      writer.writeUint32(tables[i].checkSum);
      writer.writeUint32(tables[i].offset);
      writer.writeUint32(tables[i].length);
    }
    return writer;
  },
  size: function size(ttf) {
    return ttf.numTables * 16;
  }
});
