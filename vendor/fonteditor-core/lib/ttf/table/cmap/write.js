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

  var i = -1;
  for (var j = 0; j < unicodes.length; j += 2) {
    var unicode = unicodes[j];
    var glyphId = unicodes[j + 1];
    while (++i < unicode) {
      view.setUint8(pos++, 0);
    }
    view.setUint8(pos++, glyphId);
    i = unicode;
  }
  while (++i < 256) {
    view.setUint8(pos++, 0);
  }
  writer.offset = pos;
  return writer;
}

/**
 * 优化156: 接受扁平数组 [start, end, startId, delta, ...]
 */
function writeSubTable4(writer, segments) {
  var pos = writer.offset;
  var view = writer.view;
  var segCount = segments.length / 4 + 1;
  var maxExponent = Math.floor(Math.log(segCount) / Math.LN2);
  var searchRange = 2 * Math.pow(2, maxExponent);

  view.setUint16(pos, 4, false); pos += 2;
  view.setUint16(pos, 16 + segCount * 8, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, segCount * 2, false); pos += 2;
  view.setUint16(pos, searchRange, false); pos += 2;
  view.setUint16(pos, maxExponent, false); pos += 2;
  view.setUint16(pos, 2 * segCount - searchRange, false); pos += 2;

  var numSegs = segments.length / 4;
  for (var i = 0; i < numSegs; i++) {
    view.setUint16(pos, segments[i * 4 + 1], false); pos += 2;
  }
  view.setUint16(pos, 0xFFFF, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;

  for (var j = 0; j < numSegs; j++) {
    view.setUint16(pos, segments[j * 4], false); pos += 2;
  }
  view.setUint16(pos, 0xFFFF, false); pos += 2;

  for (var k = 0; k < numSegs; k++) {
    view.setUint16(pos, segments[k * 4 + 3], false); pos += 2;
  }
  view.setUint16(pos, 1, false); pos += 2;

  for (var m = 0; m < numSegs; m++) {
    view.setUint16(pos, 0, false); pos += 2;
  }
  view.setUint16(pos, 0, false); pos += 2;

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

  for (var i = 0; i < numSegs; i++) {
    var off = i * 4;
    view.setUint32(pos, segments[off], false); pos += 4;
    view.setUint32(pos, segments[off + 1], false); pos += 4;
    view.setUint32(pos, segments[off + 2], false); pos += 4;
  }
  writer.offset = pos;
  return writer;
}

function write(writer, ttf) {
  var hasGLyphsOver2Bytes = ttf.support.cmap.hasGLyphsOver2Bytes;
  var hasFormat0 = ttf.support.cmap.hasFormat0;
  var pos = writer.offset;
  var view = writer.view;

  var numRecords = 2 + (hasFormat0 ? 1 : 0) + (hasGLyphsOver2Bytes ? 1 : 0);
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, numRecords, false); pos += 2;

  /* 优化88: encoding records 直接 view 写入 */
  var headerSize = 4 + numRecords * 8;
  var format4Size = ttf.support.cmap.format4Size;
  var format0Size = ttf.support.cmap.format0Size;

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

  writeSubTable4(writer, ttf.support.cmap.format4Segments);
  if (hasFormat0) {
    writeSubTable0(writer, ttf.support.cmap.format0Segments);
  }
  if (hasGLyphsOver2Bytes) {
    writeSubTable12(writer, ttf.support.cmap.format12Segments);
  }
  return writer;
}
