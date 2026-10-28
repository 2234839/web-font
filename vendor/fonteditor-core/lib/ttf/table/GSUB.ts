/**
 * @file GSUB
 *
 * GSUB（Glyph Substitution Table）原始字节透传读写。
 * 子集化时由 backend/font_util/gsub-subset.ts 按 glyphId 重映射 coverage/ClassDef，
 * 保留连字（ligature）、上下文替换等规则，使子集字体的连字/替换与原字体人眼一致。
 *
 * @reference: https://learn.microsoft.com/en-us/typography/opentype/spec/gsub
 */
import table from "./table";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** 透传表实例（read 通过 this 拿到表偏移） */
interface PassthroughTable {
  /** 表在字体文件中的偏移 */
  offset: number;
}

export default table.create('GSUB', [], {
  read: function read(this: PassthroughTable, reader: TableFullReader, ttf: TtfObject) {
    var length = ttf.tables.GSUB.length;
    /* 优化328: 零拷贝 subarray 替代 readBytes 的 slice（同 GPOS）。
     * subsetGSUB 只读原始字节 + 写全新 OTWriter，write 只读，从不原地修改。 */
    return new Uint8Array(reader.view.buffer, reader.view.byteOffset + this.offset, length);
  },
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    if (ttf.GSUB) {
      writer.writeBytes(ttf.GSUB, ttf.GSUB.length);
    }
  },
  size: function size(ttf: TtfObject) {
    return ttf.GSUB ? ttf.GSUB.length : 0;
  }
});
