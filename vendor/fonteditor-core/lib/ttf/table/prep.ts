/**
 * @file prep表
 * @author mengke01(kekee000@gmail.com)
 *
 * @reference: http://www.microsoft.com/typography/otspec140/prep.htm
 */
import table from "./table";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** 透传表实例（read 通过 this 拿到表偏移） */
interface PassthroughTable {
  /** 表在字体文件中的偏移 */
  offset: number;
}

export default table.create('prep', [], {
  read: function read(this: PassthroughTable, reader: TableFullReader, ttf: TtfObject) {
    var length = ttf.tables.prep.length;
    return reader.readBytes(this.offset, length);
  },
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    if (ttf.prep) {
      writer.writeBytes(ttf.prep, ttf.prep.length);
    }
  },
  size: function size(ttf: TtfObject) {
    return ttf.prep ? ttf.prep.length : 0;
  }
});
