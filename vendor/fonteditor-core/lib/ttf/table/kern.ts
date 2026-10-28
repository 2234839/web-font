/**
 * @file kern
 * @author fr33z00(https://github.com/fr33z00)
 *
 * @reference: https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6kern.html
 */
import table from "./table";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** 透传表实例（read 通过 this 拿到表偏移） */
interface PassthroughTable {
  /** 表在字体文件中的偏移 */
  offset: number;
}

export default table.create('kern', [], {
  read: function read(this: PassthroughTable, reader: TableFullReader, ttf: TtfObject) {
    var length = ttf.tables.kern.length;
    return reader.readBytes(this.offset, length);
  },
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    if (ttf.kern) {
      writer.writeBytes(ttf.kern, ttf.kern.length);
    }
  },
  size: function size(ttf: TtfObject) {
    return ttf.kern ? ttf.kern.length : 0;
  }
});
