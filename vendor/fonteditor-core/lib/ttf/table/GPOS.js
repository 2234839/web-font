"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file GPOS
 * @author fr33z00(https://github.com/fr33z00)
 *
 * @reference: https://learn.microsoft.com/en-us/typography/opentype/spec/gpos
 */
var _default = exports.default = _table.default.create('GPOS', [], {
  read: function read(reader, ttf) {
    var length = ttf.tables.GPOS.length;
    /* 优化328: 零拷贝 subarray 替代 readBytes 的 slice。
     * GPOS/GSUB 是原始字节透传（subsetGPOS/subsetGSUB 只读 OTReader + 写全新 OTWriter，
     * write 只 writeBytes 只读），整个 read→optimize→subset→write 生命周期内从不原地修改，
     * 故无需 .slice() 拷贝（68KB slice 在 V8 耗 ~40μs，subarray ~0.3μs，130× 差距）。
     * readBytes 内部等价于 new Uint8Array(view.buffer, view.byteOffset+off, len).slice()，
     * 此处去掉末尾 .slice()，直接返回共享底层 ArrayBuffer 的视图。
     * view.byteOffset 已由 reader 构造时设为传入 offset（TTFReader 传 0），与 readBytes 一致。 */
    return new Uint8Array(reader.view.buffer, reader.view.byteOffset + this.offset, length);
  },
  write: function write(writer, ttf) {
    if (ttf.GPOS) {
      writer.writeBytes(ttf.GPOS, ttf.GPOS.length);
    }
  },
  size: function size(ttf) {
    return ttf.GPOS ? ttf.GPOS.length : 0;
  }
});