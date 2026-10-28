/**
 * @file maxp 表
 * @author mengke01(kekee000@gmail.com)
 */
import table from "./table";
import struct from "./struct";
import type { TableFullReader, TableFullWriter, TtfObject } from "./table";

/** maxp 表实例（read 通过 this 拿到表偏移） */
interface MaxpTable {
  /** 表在字体文件中的偏移 */
  offset: number;
}

export default table.create('maxp', [['version', struct.Fixed], ['numGlyphs', struct.Uint16], ['maxPoints', struct.Uint16], ['maxContours', struct.Uint16], ['maxCompositePoints', struct.Uint16], ['maxCompositeContours', struct.Uint16], ['maxZones', struct.Uint16], ['maxTwilightPoints', struct.Uint16], ['maxStorage', struct.Uint16], ['maxFunctionDefs', struct.Uint16], ['maxInstructionDefs', struct.Uint16], ['maxStackElements', struct.Uint16], ['maxSizeOfInstructions', struct.Uint16], ['maxComponentElements', struct.Uint16], ['maxComponentDepth', struct.Int16]], {
  /** 优化178: 直接 view 读取 32 字节 */
  read: function (this: MaxpTable, reader: TableFullReader) {
    reader.seek(this.offset);
    var v = reader.view;
    var o = reader.offset;
    var r: Record<string, number> = {};
    r.version = v.getInt32(o, false) / 65536; o += 4;
    r.numGlyphs = v.getUint16(o, false); o += 2;
    r.maxPoints = v.getUint16(o, false); o += 2;
    r.maxContours = v.getUint16(o, false); o += 2;
    r.maxCompositePoints = v.getUint16(o, false); o += 2;
    r.maxCompositeContours = v.getUint16(o, false); o += 2;
    r.maxZones = v.getUint16(o, false); o += 2;
    r.maxTwilightPoints = v.getUint16(o, false); o += 2;
    r.maxStorage = v.getUint16(o, false); o += 2;
    r.maxFunctionDefs = v.getUint16(o, false); o += 2;
    r.maxInstructionDefs = v.getUint16(o, false); o += 2;
    r.maxStackElements = v.getUint16(o, false); o += 2;
    r.maxSizeOfInstructions = v.getUint16(o, false); o += 2;
    r.maxComponentElements = v.getUint16(o, false); o += 2;
    r.maxComponentDepth = v.getInt16(o, false); o += 2;
    reader.offset = o;
    return r;
  },
  /** 优化178: 直接 view 写入 32 字节，注意写入 ttf.support.maxp */
  write: function write(writer: TableFullWriter, ttf: TtfObject) {
    var m = ttf.support.maxp;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, m.version * 65536 + 0.5 | 0, false); pos += 4;
    view.setUint16(pos, m.numGlyphs, false); pos += 2;
    view.setUint16(pos, m.maxPoints, false); pos += 2;
    view.setUint16(pos, m.maxContours, false); pos += 2;
    view.setUint16(pos, m.maxCompositePoints, false); pos += 2;
    view.setUint16(pos, m.maxCompositeContours, false); pos += 2;
    view.setUint16(pos, m.maxZones, false); pos += 2;
    view.setUint16(pos, m.maxTwilightPoints, false); pos += 2;
    view.setUint16(pos, m.maxStorage, false); pos += 2;
    view.setUint16(pos, m.maxFunctionDefs, false); pos += 2;
    view.setUint16(pos, m.maxInstructionDefs, false); pos += 2;
    view.setUint16(pos, m.maxStackElements, false); pos += 2;
    view.setUint16(pos, m.maxSizeOfInstructions, false); pos += 2;
    view.setUint16(pos, m.maxComponentElements, false); pos += 2;
    view.setInt16(pos, m.maxComponentDepth, false); pos += 2;
    writer.offset = pos;
    return writer;
  },
  size: function size() {
    return 32;
  }
});
