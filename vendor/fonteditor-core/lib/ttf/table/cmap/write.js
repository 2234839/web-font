"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = write;
/**
 * @file 写cmap表
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化156: 接受扁平数组 [unicode, id, unicode, id, ...]
 */
function writeSubTable0(writer, unicodes) {
  var pos = writer.offset;
  var view = writer.view;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, 262, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;
  writer.offset = pos;

  /** 优化218: 使用 writer.writeEmpty 批量填充 0，替代逐字节 setUint8 */
  writer.writeEmpty(256);
  var base = writer.offset - 256;

  for (var j = 0; j < unicodes.length; j += 2) {
    pos = base + unicodes[j];
    view.setUint8(pos, unicodes[j + 1]);
  }
  writer.offset = base + 256;
  return writer;
}

/**
 * 优化156: 接受扁平数组 [start, end, startId, delta, ...]
 */
function writeSubTable4(writer, segments) {
  var pos = writer.offset;
  var view = writer.view;
  var segCount = segments.length / 4 + 1;
  var maxExponent = 31 - Math.clz32(segCount);
  var searchRange = 2 * (1 << maxExponent);

  view.setUint16(pos, 4, false); pos += 2;
  view.setUint16(pos, 16 + segCount * 8, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, segCount * 2, false); pos += 2;
  view.setUint16(pos, searchRange, false); pos += 2;
  view.setUint16(pos, maxExponent, false); pos += 2;
  view.setUint16(pos, 2 * segCount - searchRange, false); pos += 2;

  var numSegs = segments.length / 4;
  /** 优化262: 使用递增索引替代 i * 4 乘法 */
  for (var i = 0, off = 0; i < numSegs; i++, off += 4) {
    view.setUint16(pos, segments[off + 1], false); pos += 2;
  }
  view.setUint16(pos, 0xFFFF, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;

  for (var j = 0, off2 = 0; j < numSegs; j++, off2 += 4) {
    view.setUint16(pos, segments[off2], false); pos += 2;
  }
  view.setUint16(pos, 0xFFFF, false); pos += 2;

  for (var k = 0, off3 = 0; k < numSegs; k++, off3 += 4) {
    view.setUint16(pos, segments[off3 + 3], false); pos += 2;
  }
  view.setUint16(pos, 1, false); pos += 2;

  /** 优化279: idRangeOffset 全零数组用 Uint8Array.fill(0) 批量填充，替代 numSegs+1 次 setUint16 */
  var idRangeOffsetLen = (numSegs + 1) * 2;
  new Uint8Array(view.buffer, view.byteOffset + pos, idRangeOffsetLen).fill(0);
  pos += idRangeOffsetLen;

  writer.offset = pos;
  return writer;
}

/**
 * 优化156: 接受扁平数组 [start, end, startId, delta, ...]
 */
function writeSubTable12(writer, segments) {
  var pos = writer.offset;
  var view = writer.view;
  var numSegs = segments.length / 4;
  view.setUint16(pos, 12, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint32(pos, 16 + numSegs * 12, false); pos += 4;
  view.setUint32(pos, 0, false); pos += 4;
  view.setUint32(pos, numSegs, false); pos += 4;

  /** 优化262: 使用递增索引替代 i * 4 乘法 */
  for (var i = 0, off = 0; i < numSegs; i++, off += 4) {
    view.setUint32(pos, segments[off], false); pos += 4;
    view.setUint32(pos, segments[off + 1], false); pos += 4;
    view.setUint32(pos, segments[off + 2], false); pos += 4;
  }
  writer.offset = pos;
  return writer;
}

function write(writer, ttf) {
  /** 优化288: 缓存 ttf.support.cmap 到局部变量，消除重复属性链查找 */
  var cmap = ttf.support.cmap;
  var hasGLyphsOver2Bytes = cmap.hasGLyphsOver2Bytes;
  var hasFormat0 = cmap.hasFormat0;
  var pos = writer.offset;
  var view = writer.view;

  var numRecords = 2 + (hasFormat0 ? 1 : 0) + (hasGLyphsOver2Bytes ? 1 : 0);
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, numRecords, false); pos += 2;

  /* 优化88: encoding records 直接 view 写入 */
  var headerSize = 4 + numRecords * 8;
  var format4Size = cmap.format4Size;
  var format0Size = cmap.format0Size;

  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, 3, false); pos += 2;
  view.setUint32(pos, headerSize, false); pos += 4;
  if (hasFormat0) {
    view.setUint16(pos, 1, false); pos += 2;
    view.setUint16(pos, 0, false); pos += 2;
    view.setUint32(pos, headerSize + format4Size, false); pos += 4;
  }
  view.setUint16(pos, 3, false); pos += 2;
  view.setUint16(pos, 1, false); pos += 2;
  view.setUint32(pos, headerSize, false); pos += 4;
  if (hasGLyphsOver2Bytes) {
    view.setUint16(pos, 3, false); pos += 2;
    view.setUint16(pos, 10, false); pos += 2;
    view.setUint32(pos, headerSize + format4Size + format0Size, false); pos += 4;
  }
  writer.offset = pos;

  writeSubTable4(writer, cmap.format4Segments);
  if (hasFormat0) {
    writeSubTable0(writer, cmap.format0Segments);
  }
  if (hasGLyphsOver2Bytes) {
    writeSubTable12(writer, cmap.format12Segments);
  }
  return writer;
}
