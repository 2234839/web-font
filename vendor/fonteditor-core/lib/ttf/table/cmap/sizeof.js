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

function sizeof(ttf) {
  ttf.support.cmap = {};
  /* 优化249: 两遍扫描 — 第一遍统计 unicode 总数，预分配数组避免 push 扩容 */
  var glyfs = ttf.glyf;
  var gl = glyfs.length;
  var totalCount = 0;
  for (var index = 0; index < gl; index++) {
    var unicodes = glyfs[index].unicode;
    if (unicodes) {
      totalCount += unicodes.length;
    } else if (unicodes === 0 || unicodes === '') {
      totalCount++;
    }
  }
  var unicodeArr = new Array(totalCount);
  var idArr = new Array(totalCount);
  var ai = 0;
  for (var index2 = 0; index2 < gl; index2++) {
    var glyph = glyfs[index2];
    var ucs = glyph.unicode;
    if (ucs) {
      for (var ui = 0, ul = ucs.length; ui < ul; ui++) {
        unicodeArr[ai] = ucs[ui];
        idArr[ai] = ucs[ui] !== 0xFFFF ? index2 : 0;
        ai++;
      }
    } else if (ucs === 0 || ucs === '') {
      unicodeArr[ai] = ucs;
      idArr[ai] = ucs !== 0xFFFF ? index2 : 0;
      ai++;
    }
  }
  /* 优化187+247: Int32Array 索引排序，V8 对 TypedArray 比较器排序更高效（避免装箱） */
  var len = ai;
  if (len > 1) {
    var indices = new Int32Array(len);
    for (var ii = 0; ii < len; ii++) indices[ii] = ii;
    indices.sort(function(a, b) { return unicodeArr[a] - unicodeArr[b]; });
    var sortedU = new Array(len);
    var sortedI = new Array(len);
    for (var ii2 = 0; ii2 < len; ii2++) {
      var idx = indices[ii2];
      sortedU[ii2] = unicodeArr[idx];
      sortedI[ii2] = idArr[idx];
    }
    unicodeArr = sortedU;
    idArr = sortedI;
  }

  /* 优化: 合并 format12 和 format4 的 getSegmentsFlat 为单次调用
   * format12 不设 bound（包含所有字符），format4 截断到 0xFFFF
   * 大多数字体只有 BMP 字符，此时两者完全相同 */
  var format12Segments = getSegmentsFlat(unicodeArr, idArr);
  var cmapSupport = ttf.support.cmap;
  cmapSupport.format12Segments = format12Segments;
  cmapSupport.format12Size = 16 + (format12Segments.length >> 2) * 12;

  /* 检查是否有 > 0xFFFF 的字符，没有则 format4 直接复用 format12 */
  var hasOver2Bytes = false;
  for (var ci = 0, cl = format12Segments.length; ci < cl; ci += 4) {
    if (format12Segments[ci + 1] > 0xFFFF) {
      hasOver2Bytes = true;
      break;
    }
  }

  if (hasOver2Bytes) {
    cmapSupport.format4Segments = getSegmentsFlat(unicodeArr, idArr, 0xFFFF);
  } else {
    cmapSupport.format4Segments = format12Segments;
  }

  var hasGLyphsOver2Bytes = len > 0;
  if (hasGLyphsOver2Bytes) {
    cmapSupport.hasGLyphsOver2Bytes = true;
  }

  /** format4Size 需要包含 sentinel segment (+1)，与 write.js 中的 segCount = segments.length/4 + 1 一致 */
  var format4SegCount = cmapSupport.format4Segments.length / 4 + 1;
  cmapSupport.format4Size = 16 + format4SegCount * 8;
  cmapSupport.format0Segments = getFormat0SegmentFlat(unicodeArr, idArr);
  cmapSupport.hasFormat0 = cmapSupport.format0Segments.length > 0;
  cmapSupport.format0Size = cmapSupport.hasFormat0 ? 262 : 0;

  /** 记录头大小必须动态计算，与 write.js 中的 numRecords 保持一致，否则会导致表偏移错位 */
  var numRecords = 2 + (cmapSupport.hasFormat0 ? 1 : 0) + (cmapSupport.hasGLyphsOver2Bytes ? 1 : 0);
  var recordHeaderSize = 4 + numRecords * 8;
  var size = recordHeaderSize
  + cmapSupport.format0Size
  + cmapSupport.format4Size
  + (cmapSupport.hasGLyphsOver2Bytes ? cmapSupport.format12Size : 0);

  return size;
}
