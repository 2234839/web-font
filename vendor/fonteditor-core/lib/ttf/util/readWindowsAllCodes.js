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
 * 优化65+88: format12 二分查找，支持扁平数组格式
 */
function lookupFormat12(groups, unicode) {
  var lo = 0, hi = (groups.length / 3) - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var gi = mid * 3;
    var gStart = groups[gi];
    var gEnd = groups[gi + 1];
    if (unicode < gStart) {
      hi = mid - 1;
    } else if (unicode > gEnd) {
      lo = mid + 1;
    } else {
      return groups[gi + 2] + (unicode - gStart);
    }
  }
  return -1;
}

/**
 * 优化114: format4 二分查找 segment，替代线性扫描
 * 优化293: 接受预计算的 graphIdArrayIndexOffset 参数，避免每次调用重复计算
 */
function lookupFormat4(format4, unicode, _graphIdArrayIndexOffset) {
  var startCode = format4.startCode;
  var endCode = format4.endCode;
  var idDelta = format4.idDelta;
  var idRangeOffset = format4.idRangeOffset;
  var segCount = format4.segCount || (format4.segCountX2 / 2);

  var lo = 0, hi = segCount - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (unicode < startCode[mid]) {
      hi = mid - 1;
    } else if (unicode > endCode[mid]) {
      lo = mid + 1;
    } else {
      var i = mid;
      if (idRangeOffset[i] === 0) {
        return (unicode + idDelta[i]) % 0x10000;
      }
      var graphIdArrayIndexOffset = _graphIdArrayIndexOffset != null ? _graphIdArrayIndexOffset : (format4.glyphIdArrayOffset - format4.idRangeOffsetOffset) / 2;
      var index = i + (idRangeOffset[i] >> 1) + (unicode - startCode[i]) - graphIdArrayIndexOffset;
      var graphId;
      if (format4.glyphIdArray) {
        graphId = format4.glyphIdArray[index];
      } else if (format4._cmapView) {
        graphId = format4._cmapView.getUint16(format4.glyphIdArrayOffset + index * 2, false);
      } else {
        return 0;
      }
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
    /** 优化293: 预计算 graphIdArrayIndexOffset，避免在 subset 循环中重复计算 */
    var f4GIAO = format4 ? (format4.glyphIdArrayIndexOffset != null ? format4.glyphIdArrayIndexOffset : (format4.glyphIdArrayOffset - format4.idRangeOffsetOffset) / 2) : -1;
    if (format12) {
      for (var si = 0, sl = subset.length; si < sl; si++) {
        var u = subset[si];
        if (u < 0x10000 && format4) {
          var gid = lookupFormat4(format4, u, f4GIAO);
          if (gid >= 0) { codes[u] = gid; continue; }
        }
        var gid12 = lookupFormat12(format12.groups, u);
        if (gid12 >= 0) { codes[u] = gid12; }
      }
    } else if (format4) {
      for (var si2 = 0, sl2 = subset.length; si2 < sl2; si2++) {
        var u2 = subset[si2];
        var gid4 = lookupFormat4(format4, u2, f4GIAO);
        if (gid4 >= 0) { codes[u2] = gid4; }
      }
    }

    /* 优化93: format0/format14 在 subset 模式下跳过了解析，glyphIdArray/groups 为空 */
    if (format0 && format0.glyphIdArray) {
      for (var i = 0, l = format0.glyphIdArray.length; i < l; i++) {
        if (format0.glyphIdArray[i]) {
          codes[i] = format0.glyphIdArray[i];
        }
      }
    }
    if (format14 && format14.groups && format14.groups.length) {
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
    var f12Groups = format12.groups;
    if (format12._flatGroups) {
      for (var gi = 0, gl = f12Groups.length; gi < gl; gi += 3) {
        var startId = f12Groups[gi + 2];
        var start = f12Groups[gi];
        var end = f12Groups[gi + 1];
        for (; start <= end;) {
          codes[start++] = startId++;
        }
      }
    } else {
      for (var gi2 = 0, gl2 = format12.nGroups; gi2 < gl2; gi2++) {
        var group = f12Groups[gi2];
        var startId2 = group.startId;
        var start2 = group.start;
        var end2 = group.end;
        for (; start2 <= end2;) {
          codes[start2++] = startId2++;
        }
      }
    }
  } else if (format4) {
    /** 优化262: 属性链缓存到局部变量 + 跳过 65535 避免 delete 导致 V8 隐藏类退化 */
    var segCount = format4.segCountX2 / 2;
    var graphIdArrayIndexOffset = (format4.glyphIdArrayOffset - format4.idRangeOffsetOffset) / 2;
    var f4StartCode = format4.startCode;
    var f4EndCode = format4.endCode;
    var f4IdDelta = format4.idDelta;
    var f4IdRangeOffset = format4.idRangeOffset;
    var f4GlyphIdArray = format4.glyphIdArray;
    for (var si3 = 0; si3 < segCount; ++si3) {
      var segEnd = f4EndCode[si3];
      if (segEnd > 0xFFFE) segEnd = 0xFFFE;
      for (var _start = f4StartCode[si3]; _start <= segEnd; ++_start) {
        if (f4IdRangeOffset[si3] === 0) {
          codes[_start] = (_start + f4IdDelta[si3]) & 0xFFFF;
        } else {
          var index = si3 + (f4IdRangeOffset[si3] >> 1) + (_start - f4StartCode[si3]) - graphIdArrayIndexOffset;
          var graphId = f4GlyphIdArray[index];
          if (graphId !== 0) {
            codes[_start] = (graphId + f4IdDelta[si3]) & 0xFFFF;
          } else {
            codes[_start] = 0;
          }
        }
      }
    }
  } else if (format2) {
    /** 优化262: 缓存 subHeads[0] 和 subHeads[k] 到局部变量，消除重复属性链查找 */
    var subHeadKeys = format2.subHeadKeys;
    var subHeads = format2.subHeads;
    var glyphs = format2.glyphs;
    var numGlyphs = ttf.maxp.numGlyphs;
    var _index = 0;
    var sh0 = subHeads[0];
    for (var bi = 0; bi < 256; bi++) {
      if (subHeadKeys[bi] === 0) {
        if (bi >= format2.maxPos) {
          _index = 0;
        } else if (bi < sh0.firstCode || bi >= sh0.firstCode + sh0.entryCount || sh0.idRangeOffset + (bi - sh0.firstCode) >= glyphs.length) {
          _index = 0;
        } else if ((_index = glyphs[sh0.idRangeOffset + (bi - sh0.firstCode)]) !== 0) {
          _index = _index + sh0.idDelta;
        }
        if (_index !== 0 && _index < numGlyphs) {
          codes[bi] = _index;
        }
      } else {
        var sh = subHeads[subHeadKeys[bi]];
        var shIdRangeOffset = sh.idRangeOffset;
        var shIdDelta = sh.idDelta;
        var shFirstCode = sh.firstCode;
        for (var j = 0, entryCount = sh.entryCount; j < entryCount; j++) {
          if (shIdRangeOffset + j >= glyphs.length) {
            _index = 0;
          } else if ((_index = glyphs[shIdRangeOffset + j]) !== 0) {
            _index = _index + shIdDelta;
          }
          if (_index !== 0 && _index < numGlyphs) {
            var _unicode = (bi << 8 | j + shFirstCode) & 0xffff;
            codes[_unicode] = _index;
          }
        }
      }
    }
  }
  return codes;
}
