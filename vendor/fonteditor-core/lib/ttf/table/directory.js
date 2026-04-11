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

/** 优化280: KNOWN_TAG_U32 提升到模块级，消除每次 write() 调用的对象分配 */
var KNOWN_TAG_U32 = {
  'OS/2': 0x4F532F32, 'cmap': 0x636D6170, 'glyf': 0x676C7966,
  'head': 0x68656164, 'hhea': 0x68686561, 'hmtx': 0x686D7478,
  'loca': 0x6C6F6361, 'maxp': 0x6D617870, 'name': 0x6E616D65,
  'post': 0x706F7374, 'CFF ': 0x43464620, 'VORG': 0x564F5247,
  'GPOS': 0x47504F53, 'kern': 0x6B65726E, 'kerx': 0x6B657278,
  'cvt ': 0x63767420, 'fpgm': 0x6670676D, 'prep': 0x70726570,
  'gasp': 0x67617370
};
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
  /**
   * 优化111+184: 直接 DataView 批量写入，避免 writer 方法调用开销
   * 优化184: 使用 Uint32 写入 4 字节 tag，减少 4 次 setUint8 调用为 1 次 setUint32
   */
  write: function write(writer, ttf) {
    var tables = ttf.support.tables;
    var view = writer.view;
    var pos = writer.offset;
    for (var i = 0, l = tables.length; i < l; i++) {
      var t = tables[i];
      var tagU32 = KNOWN_TAG_U32[t.name];
      if (tagU32 === undefined) {
        var name = t.name;
        tagU32 = name.charCodeAt(0) << 24 | name.charCodeAt(1) << 16 | name.charCodeAt(2) << 8 | name.charCodeAt(3);
      }
      view.setUint32(pos, tagU32, false); pos += 4;
      view.setUint32(pos, t.checkSum, false); pos += 4;
      view.setUint32(pos, t.offset, false); pos += 4;
      view.setUint32(pos, t.length, false); pos += 4;
    }
    writer.offset = pos;
    return writer;
  },
  size: function size(ttf) {
    return ttf.numTables * 16;
  }
});
