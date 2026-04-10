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

/** 优化155: 扁平数组版本的 getSegments，使用并行数组替代对象数组 */
function getSegmentsFlat(unicodeArr, idArr, bound) {
  var result = [];
  var len = unicodeArr.length;
  if (len === 0) return result;

  var segStart = -1;
  var segStartId = 0;
  var segDelta = 0;
  var prevUnicode = -1;
  var prevId = 0;
  var hasValid = false;

  for (var i = 0; i < len; i++) {
    var u = unicodeArr[i];
    var id = idArr[i];
    if (bound === undefined || u <= bound) {
      if (!hasValid) {
        segStart = u;
        segStartId = id;
        segDelta = encodeDelta(id - u);
        hasValid = true;
      } else if (u !== prevUnicode + 1 || id !== prevId + 1) {
        result.push(segStart, prevUnicode, segStartId, segDelta);
        segStart = u;
        segStartId = id;
        segDelta = encodeDelta(id - u);
      }
      prevUnicode = u;
      prevId = id;
    }
  }
  if (hasValid) {
    result.push(segStart, prevUnicode, segStartId, segDelta);
  }
  return result;
}

/** 优化155: 扁平数组版本的 getFormat0Segment */
function getFormat0SegmentFlat(unicodeArr, idArr) {
  var unicodes = [];
  for (var i = 0, l = unicodeArr.length; i < l; i++) {
    if (unicodeArr[i] < 256) {
      unicodes.push(unicodeArr[i], idArr[i]);
    }
  }
  return unicodes;
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
    if (u.unicode < 256) {
      unicodes.push([u.unicode, u.id]);
    }
  }
  /* 数据已排序，无需再次 sort */
  return unicodes;
}

function sizeof(ttf) {
  ttf.support.cmap = {};
  /* 优化155: 使用并行扁平数组替代对象数组，减少 GC 压力 */
  var glyfs = ttf.glyf;
  var unicodeArr = [];
  var idArr = [];
  for (var index = 0, gl = glyfs.length; index < gl; index++) {
    var glyph = glyfs[index];
    var unicodes = glyph.unicode;
    if (typeof glyph.unicode === 'number') {
      unicodes = [glyph.unicode];
    }
    if (unicodes && unicodes.length) {
      for (var ui = 0, ul = unicodes.length; ui < ul; ui++) {
        unicodeArr.push(unicodes[ui]);
        idArr.push(unicodes[ui] !== 0xFFFF ? index : 0);
      }
    }
  }
  /* 优化179: 二分插入排序，O(n log n) 查找 + O(n) 移位 */
  var len = unicodeArr.length;
  for (var i = 1; i < len; i++) {
    var uKey = unicodeArr[i];
    var iKey = idArr[i];
    var lo = 0, hi = i - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (unicodeArr[mid] > uKey) hi = mid - 1;
      else lo = mid + 1;
    }
    if (lo !== i) {
      unicodeArr.copyWithin(lo + 1, lo, i);
      idArr.copyWithin(lo + 1, lo, i);
      unicodeArr[lo] = uKey;
      idArr[lo] = iKey;
    }
  }

  ttf.support.cmap.format4Segments = getSegmentsFlat(unicodeArr, idArr, 0xFFFF);
  /** format4Size 需要包含 sentinel segment (+1)，与 write.js 中的 segCount = segments.length/4 + 1 一致 */
  /**
   * format4Size = header(14) + reservedPad(2) + segCount * 2 * 4(four arrays)
   * segCount = 实际段数 + 1(sentinel 0xFFFF)
   */
  var format4SegCount = ttf.support.cmap.format4Segments.length / 4 + 1;
  ttf.support.cmap.format4Size = 16 + format4SegCount * 8;
  ttf.support.cmap.format0Segments = getFormat0SegmentFlat(unicodeArr, idArr);
  ttf.support.cmap.hasFormat0 = ttf.support.cmap.format0Segments.length > 0;
  ttf.support.cmap.format0Size = ttf.support.cmap.hasFormat0 ? 262 : 0;

  /** 始终生成 format 12 subtable（platformID=3, encodingID=10），
   *  现代浏览器使用 unicode-range 时依赖 format 12 来匹配字符。
   *  仅当有 cmap 映射数据时才生成（避免 nGroups=0 的无效 subtable） */
  var hasGLyphsOver2Bytes = len > 0;
  if (hasGLyphsOver2Bytes) {
    ttf.support.cmap.hasGLyphsOver2Bytes = true;
    ttf.support.cmap.format12Segments = getSegmentsFlat(unicodeArr, idArr);
    ttf.support.cmap.format12Size = 16 + (ttf.support.cmap.format12Segments.length / 4) * 12;
  }
  /** 记录头大小必须动态计算，与 write.js 中的 numRecords 保持一致，否则会导致表偏移错位 */
  var numRecords = 2 + (ttf.support.cmap.hasFormat0 ? 1 : 0) + (ttf.support.cmap.hasGLyphsOver2Bytes ? 1 : 0);
  var recordHeaderSize = 4 + numRecords * 8;
  var size = recordHeaderSize
  + ttf.support.cmap.format0Size
  + ttf.support.cmap.format4Size
  + (ttf.support.cmap.hasGLyphsOver2Bytes ? ttf.support.cmap.format12Size : 0);

  return size;
}
