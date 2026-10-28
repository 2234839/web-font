/**
 * @file fpgm 表
 * @author mengke01(kekee000@gmail.com)
 *
 * reference: https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6fpgm.html
 */
import table from "./table";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** 透传表实例（read 通过 this 拿到表偏移） */
interface PassthroughTable {
  /** 表在字体文件中的偏移 */
  offset: number;
}

export default table.create('fpgm', [], {
  read: function read(this: PassthroughTable, reader: TableFullReader, ttf: TtfObject) {
    var length = ttf.tables.fpgm.length;
    return reader.readBytes(this.offset, length);
  },
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    if (ttf.fpgm) {
      writer.writeBytes(ttf.fpgm, ttf.fpgm.length);
    }
  },
  size: function size(ttf: TtfObject) {
    return ttf.fpgm ? ttf.fpgm.length : 0;
  }
});
