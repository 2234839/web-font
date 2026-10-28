/**
 * @file head表
 * @author mengke01(kekee000@gmail.com)
 */
import table from "./table";
import struct from "./struct";
import type { TableReader, TableWriter, TtfObject } from "./table";

/** head 表实例（read 通过 this 写入解析出的字段） */
interface HeadTable {
  /** 表在字体文件中的偏移 */
  offset: number;
  /** 版本号（16.16 定点数） */
  version: number;
  /** 字体修订号（16.16 定点数） */
  fontRevision: number;
  /** 校验和调整值 */
  checkSumAdjustment: number;
  /** 魔数 */
  magickNumber: number;
  /** 标记位 */
  flags: number;
  /** unitsPerEm */
  unitsPerEm: number;
  /** 创建时间（毫秒时间戳） */
  created: number;
  /** 修改时间（毫秒时间戳） */
  modified: number;
  /** x 最小值 */
  xMin: number;
  /** y 最小值 */
  yMin: number;
  /** x 最大值 */
  xMax: number;
  /** y 最大值 */
  yMax: number;
  /** mac 样式标记 */
  macStyle: number;
  /** 最小可读像素尺寸 */
  lowestRecPPEM: number;
  /** 字体方向提示 */
  fontDirectionHint: number;
  /** indexToLocFormat */
  indexToLocFormat: number;
  /** glyphDataFormat */
  glyphDataFormat: number;
}

export default table.create('head', [['version', struct.Fixed], ['fontRevision', struct.Fixed], ['checkSumAdjustment', struct.Uint32], ['magickNumber', struct.Uint32], ['flags', struct.Uint16], ['unitsPerEm', struct.Uint16], ['created', struct.LongDateTime], ['modified', struct.LongDateTime], ['xMin', struct.Int16], ['yMin', struct.Int16], ['xMax', struct.Int16], ['yMax', struct.Int16], ['macStyle', struct.Uint16], ['lowestRecPPEM', struct.Uint16], ['fontDirectionHint', struct.Int16], ['indexToLocFormat', struct.Int16], ['glyphDataFormat', struct.Int16]], {
  size: function () { return 54; },
  /** 优化178: 全部内联 view 读取 54 字节，LongDateTime 存储为毫秒时间戳 */
  read: function (this: HeadTable, reader: TableReader) {
    reader.seek(this.offset);
    var v = reader.view;
    var o = reader.offset;
    var base = -2082844800000;
    this.version = v.getInt32(o, false) / 65536; o += 4;
    this.fontRevision = v.getInt32(o, false) / 65536; o += 4;
    this.checkSumAdjustment = v.getUint32(o, false); o += 4;
    this.magickNumber = v.getUint32(o, false); o += 4;
    this.flags = v.getUint16(o, false); o += 2;
    this.unitsPerEm = v.getUint16(o, false); o += 2;
    this.created = base + v.getUint32(o + 4, false) * 1000; o += 8;
    this.modified = base + v.getUint32(o + 4, false) * 1000; o += 8;
    this.xMin = v.getInt16(o, false); o += 2;
    this.yMin = v.getInt16(o, false); o += 2;
    this.xMax = v.getInt16(o, false); o += 2;
    this.yMax = v.getInt16(o, false); o += 2;
    this.macStyle = v.getUint16(o, false); o += 2;
    this.lowestRecPPEM = v.getUint16(o, false); o += 2;
    this.fontDirectionHint = v.getInt16(o, false); o += 2;
    this.indexToLocFormat = v.getInt16(o, false); o += 2;
    this.glyphDataFormat = v.getInt16(o, false); o += 2;
    reader.offset = o;
    return {
      version: this.version, fontRevision: this.fontRevision,
      checkSumAdjustment: this.checkSumAdjustment, magickNumber: this.magickNumber,
      flags: this.flags, unitsPerEm: this.unitsPerEm,
      created: this.created, modified: this.modified,
      xMin: this.xMin, yMin: this.yMin, xMax: this.xMax, yMax: this.yMax,
      macStyle: this.macStyle, lowestRecPPEM: this.lowestRecPPEM,
      fontDirectionHint: this.fontDirectionHint, indexToLocFormat: this.indexToLocFormat,
      glyphDataFormat: this.glyphDataFormat
    };
  },
  /** 优化178: 全部内联 view 写入 54 字节，包括 LongDateTime */
  write: function (writer: TableWriter, ttf: TtfObject) {
    var head = ttf.head;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, head.version * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt32(pos, head.fontRevision * 65536 + 0.5 | 0, false); pos += 4;
    view.setUint32(pos, head.checkSumAdjustment, false); pos += 4;
    view.setUint32(pos, head.magickNumber, false); pos += 4;
    view.setUint16(pos, head.flags, false); pos += 2;
    view.setUint16(pos, head.unitsPerEm, false); pos += 2;
    /** 优化281: resolveTTF 已将 created/modified 转为 number，消除 typeof 链 */
    var delta = -2077545600000;
    var cMs = +head.created;
    view.setUint32(pos, 0, false); pos += 4;
    view.setUint32(pos, (cMs - delta + 500 | 0) / 1000 | 0, false); pos += 4;
    var mMs = +head.modified;
    view.setUint32(pos, 0, false); pos += 4;
    view.setUint32(pos, (mMs - delta + 500 | 0) / 1000 | 0, false); pos += 4;
    view.setInt16(pos, head.xMin, false); pos += 2;
    view.setInt16(pos, head.yMin, false); pos += 2;
    view.setInt16(pos, head.xMax, false); pos += 2;
    view.setInt16(pos, head.yMax, false); pos += 2;
    view.setUint16(pos, head.macStyle, false); pos += 2;
    view.setUint16(pos, head.lowestRecPPEM, false); pos += 2;
    view.setInt16(pos, head.fontDirectionHint, false); pos += 2;
    view.setInt16(pos, head.indexToLocFormat, false); pos += 2;
    view.setInt16(pos, head.glyphDataFormat, false); pos += 2;
    writer.offset = pos;
    return writer;
  }
});
