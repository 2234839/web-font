"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = sizeof;
/**
 * @file 获取cmap表的大小
 * @author mengke01(kekee000@gmail.com)
 */

function encodeDelta(delta) {
  return delta > 0x7FFF ? delta - 0x10000 : delta < -0x7FFF ? delta + 0x10000 : delta;
}

function getSegments(glyfUnicodes, bound) {
  var prevGlyph = null;
  var result = [];
  var segment = {};
  for (var i = 0, l = glyfUnicodes.length; i < l; i++) {
    var glyph = glyfUnicodes[i];
    if (bound === undefined || glyph.unicode <= bound) {
      if (prevGlyph === null || glyph.unicode !== prevGlyph.unicode + 1 || glyph.id !== prevGlyph.id + 1) {
        if (prevGlyph !== null) {
          segment.end = prevGlyph.unicode;
          result.push(segment);
          segment = {
            start: glyph.unicode,
            startId: glyph.id,
            delta: encodeDelta(glyph.id - glyph.unicode)
          };
        } else {
          segment.start = glyph.unicode;
          segment.startId = glyph.id;
          segment.delta = encodeDelta(glyph.id - glyph.unicode);
        }
      }
      prevGlyph = glyph;
    }
  }
  if (prevGlyph !== null) {
    segment.end = prevGlyph.unicode;
    result.push(segment);
  }
  return result;
}

function getFormat0Segment(glyfUnicodes) {
  var unicodes = [];
  for (var i = 0, l = glyfUnicodes.length; i < l; i++) {
    var u = glyfUnicodes[i];
    if (u.unicode !== undefined && u.unicode < 256) {
      unicodes.push([u.unicode, u.id]);
    }
  }
  unicodes.sort(function (a, b) { return a[0] - b[0]; });
  return unicodes;
}

function sizeof(ttf) {
  ttf.support.cmap = {};
  var glyfUnicodes = [];
  var glyfs = ttf.glyf;
  for (var index = 0, gl = glyfs.length; index < gl; index++) {
    var glyph = glyfs[index];
    var unicodes = glyph.unicode;
    if (typeof glyph.unicode === 'number') {
      unicodes = [glyph.unicode];
    }
    if (unicodes && unicodes.length) {
      for (var ui = 0, ul = unicodes.length; ui < ul; ui++) {
        glyfUnicodes.push({
          unicode: unicodes[ui],
          id: unicodes[ui] !== 0xFFFF ? index : 0
        });
      }
    }
  }
  glyfUnicodes.sort(function (a, b) { return a.unicode - b.unicode; });
  ttf.support.cmap.unicodes = glyfUnicodes;
  var unicodes2Bytes = glyfUnicodes;
  ttf.support.cmap.format4Segments = getSegments(unicodes2Bytes, 0xFFFF);
  ttf.support.cmap.format4Size = 24 + ttf.support.cmap.format4Segments.length * 8;
  ttf.support.cmap.format0Segments = getFormat0Segment(glyfUnicodes);
  ttf.support.cmap.hasFormat0 = ttf.support.cmap.format0Segments.length > 0;
  ttf.support.cmap.format0Size = ttf.support.cmap.hasFormat0 ? 262 : 0;

  var hasGLyphsOver2Bytes = false;
  for (var gi = 0, gil = unicodes2Bytes.length; gi < gil; gi++) {
    if (unicodes2Bytes[gi].unicode > 0xFFFF) {
      hasGLyphsOver2Bytes = true;
      break;
    }
  }
  if (hasGLyphsOver2Bytes) {
    ttf.support.cmap.hasGLyphsOver2Bytes = true;
    var unicodes4Bytes = glyfUnicodes;
    ttf.support.cmap.format12Segments = getSegments(unicodes4Bytes);
    ttf.support.cmap.format12Size = 16 + ttf.support.cmap.format12Segments.length * 12;
  }
  /** 记录头大小必须动态计算，与 write.js 中的 numRecords 保持一致，否则会导致表偏移错位 */
  var numRecords = 2 + (ttf.support.cmap.hasFormat0 ? 1 : 0) + (hasGLyphsOver2Bytes ? 1 : 0);
  var recordHeaderSize = 4 + numRecords * 8;
  var size = recordHeaderSize
  + ttf.support.cmap.format0Size
  + ttf.support.cmap.format4Size
  + (hasGLyphsOver2Bytes ? ttf.support.cmap.format12Size : 0);

  return size;
}
