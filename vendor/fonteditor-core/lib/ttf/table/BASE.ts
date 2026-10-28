/**
 * @file BASE 基线表（原始字节透传，无 gid 依赖）
 *
 * @reference: https://learn.microsoft.com/en-us/typography/opentype/spec/baselinetags
 *
 * 为什么需要透传：FreeType（Linux/Android Skia）在字体缺少 BASE 表时使用启发式
 * 基线/字干推断，与完整字体（含 BASE）的渲染行为不一致，导致子集字体与原字体
 * 渲染出现系统性亚像素偏移。BASE 内容不含 glyph id，子集化后原样有效。
 */
import table from "./table";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** 透传表实例（read 通过 this 拿到表偏移） */
interface PassthroughTable {
  /** 表在字体文件中的偏移 */
  offset: number;
}

export default table.create('BASE', [], {
  read: function read(this: PassthroughTable, reader: TableFullReader, ttf: TtfObject) {
    var length = ttf.tables.BASE.length;
    /* 与 GPOS 相同的零拷贝 subarray 策略：BASE 全生命周期只读透传 */
    return new Uint8Array(reader.view.buffer, reader.view.byteOffset + this.offset, length);
  },
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    if (ttf.BASE) {
      writer.writeBytes(ttf.BASE, ttf.BASE.length);
    }
  },
  size: function size(ttf: TtfObject) {
    return ttf.BASE ? ttf.BASE.length : 0;
  }
});
