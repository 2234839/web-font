"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = write;
/**
 * @file 写cmap表
 * @author mengke01(kekee000@gmail.com)
 */

function writeSubTable0(writer, unicodes) {
  var pos = writer.offset;
  var view = writer.view;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, 262, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;

  var i = -1;
  for (var j = 0; j < unicodes.length; j++) {
    var unicode = unicodes[j];
    while (++i < unicode[0]) {
      view.setUint8(pos++, 0);
    }
    view.setUint8(pos++, unicode[1]);
    i = unicode[0];
  }
  while (++i < 256) {
    view.setUint8(pos++, 0);
  }
  writer.offset = pos;
  return writer;
}

function writeSubTable4(writer, segments) {
  var pos = writer.offset;
  var view = writer.view;
  var segCount = segments.length + 1;
  var maxExponent = Math.floor(Math.log(segCount) / Math.LN2);
  var searchRange = 2 * Math.pow(2, maxExponent);

  view.setUint16(pos, 4, false); pos += 2;
  view.setUint16(pos, 24 + segments.length * 8, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint16(pos, segCount * 2, false); pos += 2;
  view.setUint16(pos, searchRange, false); pos += 2;
  view.setUint16(pos, maxExponent, false); pos += 2;
  view.setUint16(pos, 2 * segCount - searchRange, false); pos += 2;

  for (var i = 0; i < segments.length; i++) {
    view.setUint16(pos, segments[i].end, false); pos += 2;
  }
  view.setUint16(pos, 0xFFFF, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;

  for (var j = 0; j < segments.length; j++) {
    view.setUint16(pos, segments[j].start, false); pos += 2;
  }
  view.setUint16(pos, 0xFFFF, false); pos += 2;

  for (var k = 0; k < segments.length; k++) {
    view.setUint16(pos, segments[k].delta, false); pos += 2;
  }
  view.setUint16(pos, 1, false); pos += 2;

  for (var m = 0; m < segments.length; m++) {
    view.setUint16(pos, 0, false); pos += 2;
  }
  view.setUint16(pos, 0, false); pos += 2;

  writer.offset = pos;
  return writer;
}

function writeSubTable12(writer, segments) {
  var pos = writer.offset;
  var view = writer.view;
  view.setUint16(pos, 12, false); pos += 2;
  view.setUint16(pos, 0, false); pos += 2;
  view.setUint32(pos, 16 + segments.length * 12, false); pos += 4;
  view.setUint32(pos, 0, false); pos += 4;
  view.setUint32(pos, segments.length, false); pos += 4;

  for (var i = 0; i < segments.length; i++) {
    view.setUint32(pos, segments[i].start, false); pos += 4;
    view.setUint32(pos, segments[i].end, false); pos += 4;
    view.setUint32(pos, segments[i].startId, false); pos += 4;
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
  writer.offset = pos;

  var headerSize = 4 + numRecords * 8;
  var format4Size = ttf.support.cmap.format4Size;
  var format0Size = ttf.support.cmap.format0Size;

  /** platform 0 (Unicode) 和 platform 3 (Windows) 共享同一个 format 4 subtable */
  writer.writeUint16(0); writer.writeUint16(3); writer.writeUint32(headerSize);
  if (hasFormat0) {
    writer.writeUint16(1); writer.writeUint16(0); writer.writeUint32(headerSize + format4Size);
  }
  writer.writeUint16(3); writer.writeUint16(1); writer.writeUint32(headerSize);
  if (hasGLyphsOver2Bytes) {
    writer.writeUint16(3); writer.writeUint16(10); writer.writeUint32(headerSize + format4Size + format0Size);
  }

  writeSubTable4(writer, ttf.support.cmap.format4Segments);
  if (hasFormat0) {
    writeSubTable0(writer, ttf.support.cmap.format0Segments);
  }
  if (hasGLyphsOver2Bytes) {
    writeSubTable12(writer, ttf.support.cmap.format12Segments);
  }
  return writer;
}
