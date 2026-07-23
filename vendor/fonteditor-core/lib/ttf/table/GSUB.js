"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file GSUB
 *
 * GSUB（Glyph Substitution Table）原始字节透传读写。
 * 子集化时由 backend/font_util/gsub-subset.ts 按 glyphId 重映射 coverage/ClassDef，
 * 保留连字（ligature）、上下文替换等规则，使子集字体的连字/替换与原字体人眼一致。
 *
 * @reference: https://learn.microsoft.com/en-us/typography/opentype/spec/gsub
 */
var _default = exports.default = _table.default.create('GSUB', [], {
  read: function read(reader, ttf) {
    var length = ttf.tables.GSUB.length;
    return reader.readBytes(this.offset, length);
  },
  write: function write(writer, ttf) {
    if (ttf.GSUB) {
      writer.writeBytes(ttf.GSUB, ttf.GSUB.length);
    }
  },
  size: function size(ttf) {
    return ttf.GSUB ? ttf.GSUB.length : 0;
  }
});
