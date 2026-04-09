"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = readWindowsAllCodes;
/* eslint-disable */

/**
 * @file 读取windows支持的字符集
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化65: format12 二分查找，避免全量展开
 */
function lookupFormat12(groups, unicode) {
  var lo = 0, hi = groups.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var g = groups[mid];
    if (unicode < g.start) {
      hi = mid - 1;
    } else if (unicode > g.end) {
      lo = mid + 1;
    } else {
      return g.startId + (unicode - g.start);
    }
  }
  return -1;
}

/**
 * 优化65: format4 线性查找 segment
 */
function lookupFormat4(format4, unicode) {
  var startCode = format4.startCode;
  var endCode = format4.endCode;
  var idDelta = format4.idDelta;
  var idRangeOffset = format4.idRangeOffset;
  var segCount = format4.segCountX2 / 2;

  for (var i = 0; i < segCount; i++) {
    if (unicode >= startCode[i] && unicode <= endCode[i]) {
      if (idRangeOffset[i] === 0) {
        return (unicode + idDelta[i]) % 0x10000;
      }
      var graphIdArrayIndexOffset = (format4.glyphIdArrayOffset - format4.idRangeOffsetOffset) / 2;
      var index = i + idRangeOffset[i] / 2 + (unicode - startCode[i]) - graphIdArrayIndexOffset;
      var graphId = format4.glyphIdArray[index];
      if (graphId !== 0) {
        return (graphId + idDelta[i]) % 0x10000;
      }
      return 0;
    }
  }
  return -1;
}

/**
 * 读取ttf中windows字符表的字符
 *
 * @param {Array} tables cmap表结构
 * @param {Object} ttf ttf对象
 * @return {Object} 字符字典索引，unicode => glyf index
 */
function readWindowsAllCodes(tables, ttf) {
  var codes = {};
  var subset = ttf.readOptions && ttf.readOptions.subset;

  /* 优化65: 合并5次 tables.find 为单次遍历 */
  var format0 = null, format12 = null, format4 = null, format2 = null, format14 = null;
  for (var fi = 0; fi < tables.length; fi++) {
    var t = tables[fi];
    if (t.format === 0 && !format0) format0 = t;
    else if (t.platformID === 3 && t.encodingID === 10 && t.format === 12 && !format12) format12 = t;
    else if (t.platformID === 3 && t.encodingID === 1 && t.format === 4 && !format4) format4 = t;
    else if (t.platformID === 3 && t.encodingID === 3 && t.format === 2 && !format2) format2 = t;
    else if (t.platformID === 0 && t.encodingID === 5 && t.format === 14 && !format14) format14 = t;
  }

  /* 优化65: subset 模式 - 只查找 subset 字符的 glyphId */
  if (subset && subset.length > 0) {
    if (format12) {
      for (var si = 0, sl = subset.length; si < sl; si++) {
        var u = subset[si];
        if (u < 0x10000 && format4) {
          var gid = lookupFormat4(format4, u);
          if (gid >= 0) { codes[u] = gid; continue; }
        }
        var gid12 = lookupFormat12(format12.groups, u);
        if (gid12 >= 0) { codes[u] = gid12; }
      }
    } else if (format4) {
      for (var si2 = 0, sl2 = subset.length; si2 < sl2; si2++) {
        var u2 = subset[si2];
        var gid4 = lookupFormat4(format4, u2);
        if (gid4 >= 0) { codes[u2] = gid4; }
      }
    }

    /* format0 和 format14 仍然需要全量处理（数据量小） */
    if (format0) {
      for (var i = 0, l = format0.glyphIdArray.length; i < l; i++) {
        if (format0.glyphIdArray[i]) {
          codes[i] = format0.glyphIdArray[i];
        }
      }
    }
    if (format14) {
      for (var vi = 0, vl = format14.groups.length; vi < vl; vi++) {
        var vg = format14.groups[vi];
        if (vg.unicode) {
          codes[vg.unicode] = vg.glyphId;
        }
      }
    }

    return codes;
  }

  /* 非subset模式 - 全量展开（原始逻辑） */
  if (format0) {
    for (var i2 = 0, l2 = format0.glyphIdArray.length; i2 < l2; i2++) {
      if (format0.glyphIdArray[i2]) {
        codes[i2] = format0.glyphIdArray[i2];
      }
    }
  }
  if (format14) {
    for (var vi2 = 0, vl2 = format14.groups.length; vi2 < vl2; vi2++) {
      var vg2 = format14.groups[vi2];
      if (vg2.unicode) {
        codes[vg2.unicode] = vg2.glyphId;
      }
    }
  }
  if (format12) {
    for (var gi = 0, gl = format12.nGroups; gi < gl; gi++) {
      var group = format12.groups[gi];
      var startId = group.startId;
      var start = group.start;
      var end = group.end;
      for (; start <= end;) {
        codes[start++] = startId++;
      }
    }
  } else if (format4) {
    var segCount = format4.segCountX2 / 2;
    var graphIdArrayIndexOffset = (format4.glyphIdArrayOffset - format4.idRangeOffsetOffset) / 2;
    for (var si3 = 0; si3 < segCount; ++si3) {
      for (var _start = format4.startCode[si3], _end = format4.endCode[si3]; _start <= _end; ++_start) {
        if (format4.idRangeOffset[si3] === 0) {
          codes[_start] = (_start + format4.idDelta[si3]) % 0x10000;
        } else {
          var index = si3 + format4.idRangeOffset[si3] / 2 + (_start - format4.startCode[si3]) - graphIdArrayIndexOffset;
          var graphId = format4.glyphIdArray[index];
          if (graphId !== 0) {
            codes[_start] = (graphId + format4.idDelta[si3]) % 0x10000;
          } else {
            codes[_start] = 0;
          }
        }
      }
    }
    delete codes[65535];
  } else if (format2) {
    var subHeadKeys = format2.subHeadKeys;
    var subHeads = format2.subHeads;
    var glyphs = format2.glyphs;
    var numGlyphs = ttf.maxp.numGlyphs;
    var _index = 0;
    for (var bi = 0; bi < 256; bi++) {
      if (subHeadKeys[bi] === 0) {
        if (bi >= format2.maxPos) {
          _index = 0;
        } else if (bi < subHeads[0].firstCode || bi >= subHeads[0].firstCode + subHeads[0].entryCount || subHeads[0].idRangeOffset + (bi - subHeads[0].firstCode) >= glyphs.length) {
          _index = 0;
        } else if ((_index = glyphs[subHeads[0].idRangeOffset + (bi - subHeads[0].firstCode)]) !== 0) {
          _index = _index + subHeads[0].idDelta;
        }
        if (_index !== 0 && _index < numGlyphs) {
          codes[bi] = _index;
        }
      } else {
        var k = subHeadKeys[bi];
        for (var j = 0, entryCount = subHeads[k].entryCount; j < entryCount; j++) {
          if (subHeads[k].idRangeOffset + j >= glyphs.length) {
            _index = 0;
          } else if ((_index = glyphs[subHeads[k].idRangeOffset + j]) !== 0) {
            _index = _index + subHeads[k].idDelta;
          }
          if (_index !== 0 && _index < numGlyphs) {
            var _unicode = (bi << 8 | j + subHeads[k].firstCode) % 0xffff;
            codes[_unicode] = _index;
          }
        }
      }
    }
  }
  return codes;
}
