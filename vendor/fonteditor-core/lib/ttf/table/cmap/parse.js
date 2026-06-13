"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = parse;
var _readWindowsAllCodes = _interopRequireDefault(require("../../util/readWindowsAllCodes"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 解析cmap表
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 读取cmap子表
 *
 * @param {Reader} reader Reader对象
 * @param {Object} ttf ttf对象
 * @param {Object} subTable 子表对象
 * @param {number} cmapOffset 子表的偏移
 */
function readSubTable(reader, ttf, subTable, cmapOffset) {
  var startOffset = cmapOffset + subTable.offset;
  /* 优化59: 直接 view 批量读取，避免逐个 readUint8/readUint16/readUint32 */
  var view = reader.view;
  var vOffset = view.byteOffset + startOffset;
  subTable.format = view.getUint16(vOffset, false);
  vOffset += 2;

  if (subTable.format === 0) {
    /* 优化93: subset 模式下跳过 format0 完整解析，readWindowsAllCodes 不需要它 */
    var isSubset = ttf.readOptions && ttf.readOptions.subset;
    if (isSubset) {
      subTable.format = 0;
    } else {
      var format0 = subTable;
      format0.length = view.getUint16(vOffset, false); vOffset += 2;
      format0.language = view.getUint16(vOffset, false); vOffset += 2;
      var glyphCount = format0.length - 6;
      var glyphIdArray = new Array(glyphCount);
      for (var i = 0; i < glyphCount; i++) {
        glyphIdArray[i] = view.getUint8(vOffset + i);
      }
      format0.glyphIdArray = glyphIdArray;
    }
  } else if (subTable.format === 2) {
    var format2 = subTable;
    format2.length = view.getUint16(vOffset, false); vOffset += 2;
    format2.language = view.getUint16(vOffset, false); vOffset += 2;
    var subHeadKeys = new Array(256);
    var maxSubHeadKey = 0;
    var maxPos = -1;
    for (var _i = 0; _i < 256; _i++) {
      subHeadKeys[_i] = view.getUint16(vOffset, false) / 8;
      if (subHeadKeys[_i] > maxSubHeadKey) {
        maxSubHeadKey = subHeadKeys[_i];
        maxPos = _i;
      }
      vOffset += 2;
    }
    var subHeads = new Array(maxSubHeadKey + 1);
    for (var j = 0; j <= maxSubHeadKey; j++) {
      subHeads[j] = {
        firstCode: view.getUint16(vOffset, false),
        entryCount: view.getUint16(vOffset + 2, false),
        idDelta: view.getUint16(vOffset + 4, false),
        idRangeOffset: (view.getUint16(vOffset + 6, false) - (maxSubHeadKey - j) * 8 - 2) / 2
      };
      vOffset += 8;
    }
    var glyphCount2 = (startOffset + format2.length - (vOffset - view.byteOffset)) / 2;
    var glyphs = new Array(glyphCount2);
    for (var k = 0; k < glyphCount2; k++) {
      glyphs[k] = view.getUint16(vOffset, false);
      vOffset += 2;
    }
    format2.subHeadKeys = subHeadKeys;
    format2.maxPos = maxPos;
    format2.subHeads = subHeads;
    format2.glyphs = glyphs;
  }
  else if (subTable.format === 4) {
    var format4 = subTable;
    format4.length = view.getUint16(vOffset, false); vOffset += 2;
    format4.language = view.getUint16(vOffset, false); vOffset += 2;
    format4.segCountX2 = view.getUint16(vOffset, false); vOffset += 2;
    format4.searchRange = view.getUint16(vOffset, false); vOffset += 2;
    format4.entrySelector = view.getUint16(vOffset, false); vOffset += 2;
    format4.rangeShift = view.getUint16(vOffset, false); vOffset += 2;
    var segCount = format4.segCountX2 / 2;

    var endCode = new Array(segCount);
    for (var e = 0; e < segCount; e++) {
      endCode[e] = view.getUint16(vOffset, false);
      vOffset += 2;
    }
    format4.endCode = endCode;
    format4.reservedPad = view.getUint16(vOffset, false); vOffset += 2;

    var startCode = new Array(segCount);
    for (var s = 0; s < segCount; s++) {
      startCode[s] = view.getUint16(vOffset, false);
      vOffset += 2;
    }
    format4.startCode = startCode;

    var idDelta = new Array(segCount);
    for (var d = 0; d < segCount; d++) {
      idDelta[d] = view.getUint16(vOffset, false);
      vOffset += 2;
    }
    format4.idDelta = idDelta;
    format4.idRangeOffsetOffset = vOffset - view.byteOffset;

    var idRangeOffset = new Array(segCount);
    for (var r = 0; r < segCount; r++) {
      idRangeOffset[r] = view.getUint16(vOffset, false);
      vOffset += 2;
    }
    format4.idRangeOffset = idRangeOffset;
    format4.segCount = segCount;

    /* 优化101: subset 模式下跳过 glyphIdArray 解析，直接从 view 按需读取 */
    var isSubset4 = ttf.readOptions && ttf.readOptions.subset;
    if (isSubset4) {
      format4.glyphIdArrayOffset = vOffset - view.byteOffset;
      format4._cmapView = view;
    } else {
      var glyphCount4 = (format4.length - (vOffset - view.byteOffset - startOffset)) / 2;
      format4.glyphIdArrayOffset = vOffset - view.byteOffset;

      var glyphIdArray4 = new Array(glyphCount4);
      for (var g = 0; g < glyphCount4; g++) {
        glyphIdArray4[g] = view.getUint16(vOffset, false);
        vOffset += 2;
      }
      format4.glyphIdArray = glyphIdArray4;
    }
    /* 优化177: 预计算 glyphIdArrayIndexOffset，消除 lookupFormat4 中的重复除法 */
    format4.glyphIdArrayIndexOffset = (format4.glyphIdArrayOffset - format4.idRangeOffsetOffset) / 2;
  } else if (subTable.format === 6) {
    var format6 = subTable;
    format6.length = view.getUint16(vOffset, false); vOffset += 2;
    format6.language = view.getUint16(vOffset, false); vOffset += 2;
    format6.firstCode = view.getUint16(vOffset, false); vOffset += 2;
    format6.entryCount = view.getUint16(vOffset, false); vOffset += 2;
    format6.glyphIdArrayOffset = vOffset - view.byteOffset;
    var entryCount = format6.entryCount;
    var glyphIndexArray = new Array(entryCount);
    for (var f = 0; f < entryCount; f++) {
      glyphIndexArray[f] = view.getUint16(vOffset, false);
      vOffset += 2;
    }
    format6.glyphIdArray = glyphIndexArray;
  }
  else if (subTable.format === 12) {
    var format12 = subTable;
    format12.reserved = view.getUint16(vOffset, false); vOffset += 2;
    format12.length = view.getUint32(vOffset, false); vOffset += 4;
    format12.language = view.getUint32(vOffset, false); vOffset += 4;
    format12.nGroups = view.getUint32(vOffset, false); vOffset += 4;
    var nGroups = format12.nGroups;
    /**
     * 优化300: subset 模式下 format12 延迟解析，不展开 nGroups 个 group
     * 思源等大 CID 字体 format12 有 1.5 万+ group，全量展开需 4.5 万次 getUint32。
     * subset 仅查找少数 cp，lookupFormat12 直接从 view 二分查找（group 已升序、每项 12 字节）。
     */
    var isSubset12 = ttf.readOptions && ttf.readOptions.subset && ttf.readOptions.subset.length > 0;
    if (isSubset12) {
      format12._cmapView = view;
      format12._groupsOffset = vOffset;
      format12._lazyGroups = true;
    } else {
      /* 优化88: 扁平数组存储 groups，减少对象创建 [start, end, startId, ...] */
      var groups = new Array(nGroups * 3);
      for (var h = 0, gi = 0; h < nGroups; h++, gi += 3) {
        groups[gi] = view.getUint32(vOffset, false);
        groups[gi + 1] = view.getUint32(vOffset + 4, false);
        groups[gi + 2] = view.getUint32(vOffset + 8, false);
        vOffset += 12;
      }
      format12.groups = groups;
      format12._flatGroups = true;
    }
  }
  else if (subTable.format === 14) {
    /* 优化93: subset 模式下跳过 format14 完整解析 */
    var isSubset2 = ttf.readOptions && ttf.readOptions.subset;
    if (isSubset2) {
      subTable.format = 14;
      subTable.groups = [];
    } else {
    var format14 = subTable;
    format14.length = view.getUint32(vOffset, false); vOffset += 4;
    var numVarSelectorRecords = view.getUint32(vOffset, false); vOffset += 4;
    var _groups = [];
    var absOffset = vOffset;
    for (var vs = 0; vs < numVarSelectorRecords; vs++) {
      var varSelector = (view.getUint8(absOffset) << 16) + (view.getUint8(absOffset + 1) << 8) + view.getUint8(absOffset + 2);
      var defaultUVSOffset = view.getUint32(absOffset + 3, false);
      var nonDefaultUVSOffset = view.getUint32(absOffset + 7, false);
      absOffset += 11;
      if (defaultUVSOffset) {
        var numUnicodeValueRanges = view.getUint32(view.byteOffset + startOffset + defaultUVSOffset, false);
        var duvsOffset = view.byteOffset + startOffset + defaultUVSOffset + 4;
        for (var dj = 0; dj < numUnicodeValueRanges; dj++) {
          var startUnicode = (view.getUint8(duvsOffset) << 16) + (view.getUint8(duvsOffset + 1) << 8) + view.getUint8(duvsOffset + 2);
          var additionalCount = view.getUint8(duvsOffset + 3);
          duvsOffset += 4;
          _groups.push({
            start: startUnicode,
            end: startUnicode + additionalCount,
            varSelector: varSelector
          });
        }
      }
      if (nonDefaultUVSOffset) {
        var numUVSMappings = view.getUint32(view.byteOffset + startOffset + nonDefaultUVSOffset, false);
        var nuvsOffset = view.byteOffset + startOffset + nonDefaultUVSOffset + 4;
        for (var nj = 0; nj < numUVSMappings; nj++) {
          var unicode = (view.getUint8(nuvsOffset) << 16) + (view.getUint8(nuvsOffset + 1) << 8) + view.getUint8(nuvsOffset + 2);
          var glyphId = view.getUint16(nuvsOffset + 3, false);
          nuvsOffset += 5;
          _groups.push({
            unicode: unicode,
            glyphId: glyphId,
            varSelector: varSelector
          });
        }
      }
    }
    format14.groups = _groups;
    }
  } else {
    console.warn('not support cmap format:' + subTable.format);
  }
}

function parse(reader, ttf) {
  var tcmap = {};
  var cmapOffset = this.offset;
  reader.seek(cmapOffset);
  tcmap.version = reader.readUint16();
  var numberSubtables = tcmap.numberSubtables = reader.readUint16();

  var subTables = tcmap.tables = [];
  /* 优化59: 直接 view 读取子表目录 */
  var view = reader.view;
  var dirOffset = view.byteOffset + reader.offset;
  for (var i = 0; i < numberSubtables; i++) {
    var subTable = {};
    subTable.platformID = view.getUint16(dirOffset, false);
    subTable.encodingID = view.getUint16(dirOffset + 2, false);
    subTable.offset = view.getUint32(dirOffset + 4, false);
    readSubTable(reader, ttf, subTable, cmapOffset);
    subTables.push(subTable);
    dirOffset += 8;
  }
  reader.offset = dirOffset - view.byteOffset;
  var cmap = (0, _readWindowsAllCodes.default)(subTables, ttf);
  return cmap;
}
