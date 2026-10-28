/**
 * @file hhea 表
 * @author mengke01(kekee000@gmail.com)
 *
 * https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6hhea.html
 */
import table from "./table";
import struct from "./struct";
import type { TableReader, TableWriter, TtfObject } from "./table";

/** hhea 表实例（read 通过 this 写入解析出的字段） */
interface HheaTable {
  /** 表在字体文件中的偏移 */
  offset: number;
  /** 版本号（16.16 定点数） */
  version: number;
  /** 上边界（ascent） */
  ascent: number;
  /** 下边界（descent） */
  descent: number;
  /** 行距 */
  lineGap: number;
  /** 最大 advance width */
  advanceWidthMax: number;
  /** 最小左侧 bearing */
  minLeftSideBearing: number;
  /** 最小右侧 bearing */
  minRightSideBearing: number;
  /** x 最大延伸 */
  xMaxExtent: number;
  /** 斜率分子 */
  caretSlopeRise: number;
  /** 斜率分母 */
  caretSlopeRun: number;
  /** 光标偏移 */
  caretOffset: number;
  /** 度量数据格式 */
  metricDataFormat: number;
  /** 长水平度量数量 */
  numOfLongHorMetrics: number;
}

export default table.create('hhea', [['version', struct.Fixed], ['ascent', struct.Int16], ['descent', struct.Int16], ['lineGap', struct.Int16], ['advanceWidthMax', struct.Uint16], ['minLeftSideBearing', struct.Int16], ['minRightSideBearing', struct.Int16], ['xMaxExtent', struct.Int16], ['caretSlopeRise', struct.Int16], ['caretSlopeRun', struct.Int16], ['caretOffset', struct.Int16], ['reserved0', struct.Int16], ['reserved1', struct.Int16], ['reserved2', struct.Int16], ['reserved3', struct.Int16], ['metricDataFormat', struct.Int16], ['numOfLongHorMetrics', struct.Uint16]], {
  size: function () { return 36; },
  /** 优化178: 全部内联 view 读取 36 字节 */
  read: function (this: HheaTable, reader: TableReader) {
    reader.seek(this.offset);
    var v = reader.view;
    var o = reader.offset;
    this.version = v.getInt32(o, false) / 65536; o += 4;
    this.ascent = v.getInt16(o, false); o += 2;
    this.descent = v.getInt16(o, false); o += 2;
    this.lineGap = v.getInt16(o, false); o += 2;
    this.advanceWidthMax = v.getUint16(o, false); o += 2;
    this.minLeftSideBearing = v.getInt16(o, false); o += 2;
    this.minRightSideBearing = v.getInt16(o, false); o += 2;
    this.xMaxExtent = v.getInt16(o, false); o += 2;
    this.caretSlopeRise = v.getInt16(o, false); o += 2;
    this.caretSlopeRun = v.getInt16(o, false); o += 2;
    this.caretOffset = v.getInt16(o, false); o += 2;
    o += 8; /* reserved0-3 */
    this.metricDataFormat = v.getInt16(o, false); o += 2;
    this.numOfLongHorMetrics = v.getUint16(o, false); o += 2;
    reader.offset = o;
    return {
      version: this.version, ascent: this.ascent, descent: this.descent,
      lineGap: this.lineGap, advanceWidthMax: this.advanceWidthMax,
      minLeftSideBearing: this.minLeftSideBearing, minRightSideBearing: this.minRightSideBearing,
      xMaxExtent: this.xMaxExtent, caretSlopeRise: this.caretSlopeRise,
      caretSlopeRun: this.caretSlopeRun, caretOffset: this.caretOffset,
      metricDataFormat: this.metricDataFormat, numOfLongHorMetrics: this.numOfLongHorMetrics
    };
  },
  write: function (writer: TableWriter, ttf: TtfObject) {
    var h = ttf.hhea;
    var pos = writer.offset;
    var view = writer.view;
    view.setInt32(pos, h.version * 65536 + 0.5 | 0, false); pos += 4;
    view.setInt16(pos, h.ascent, false); pos += 2;
    view.setInt16(pos, h.descent, false); pos += 2;
    view.setInt16(pos, h.lineGap, false); pos += 2;
    view.setUint16(pos, h.advanceWidthMax, false); pos += 2;
    view.setInt16(pos, h.minLeftSideBearing, false); pos += 2;
    view.setInt16(pos, h.minRightSideBearing, false); pos += 2;
    view.setInt16(pos, h.xMaxExtent, false); pos += 2;
    view.setInt16(pos, h.caretSlopeRise, false); pos += 2;
    view.setInt16(pos, h.caretSlopeRun, false); pos += 2;
    view.setInt16(pos, h.caretOffset, false); pos += 2;
    pos += 8; /* reserved0-3 */
    view.setInt16(pos, h.metricDataFormat, false); pos += 2;
    view.setUint16(pos, h.numOfLongHorMetrics, false); pos += 2;
    writer.offset = pos;
    return writer;
  }
});
