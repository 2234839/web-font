"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _table = _interopRequireDefault(require("./table"));
var _struct = _interopRequireDefault(require("./struct"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file OS/2表
 * @author mengke01(kekee000@gmail.com)
 *
 * http://www.microsoft.com/typography/otspec/os2.htm
 */
var _default = exports.default = _table.default.create('OS/2', [['version', _struct.default.Uint16], ['xAvgCharWidth', _struct.default.Int16], ['usWeightClass', _struct.default.Uint16], ['usWidthClass', _struct.default.Uint16], ['fsType', _struct.default.Uint16], ['ySubscriptXSize', _struct.default.Uint16], ['ySubscriptYSize', _struct.default.Uint16], ['ySubscriptXOffset', _struct.default.Uint16], ['ySubscriptYOffset', _struct.default.Uint16], ['ySuperscriptXSize', _struct.default.Uint16], ['ySuperscriptYSize', _struct.default.Uint16], ['ySuperscriptXOffset', _struct.default.Uint16], ['ySuperscriptYOffset', _struct.default.Uint16], ['yStrikeoutSize', _struct.default.Uint16], ['yStrikeoutPosition', _struct.default.Uint16], ['sFamilyClass', _struct.default.Uint16],
// Panose
['bFamilyType', _struct.default.Uint8], ['bSerifStyle', _struct.default.Uint8], ['bWeight', _struct.default.Uint8], ['bProportion', _struct.default.Uint8], ['bContrast', _struct.default.Uint8], ['bStrokeVariation', _struct.default.Uint8], ['bArmStyle', _struct.default.Uint8], ['bLetterform', _struct.default.Uint8], ['bMidline', _struct.default.Uint8], ['bXHeight', _struct.default.Uint8],
// unicode range
['ulUnicodeRange1', _struct.default.Uint32], ['ulUnicodeRange2', _struct.default.Uint32], ['ulUnicodeRange3', _struct.default.Uint32], ['ulUnicodeRange4', _struct.default.Uint32],
// char 4
['achVendID', _struct.default.String, 4], ['fsSelection', _struct.default.Uint16], ['usFirstCharIndex', _struct.default.Uint16], ['usLastCharIndex', _struct.default.Uint16], ['sTypoAscender', _struct.default.Int16], ['sTypoDescender', _struct.default.Int16], ['sTypoLineGap', _struct.default.Int16], ['usWinAscent', _struct.default.Uint16], ['usWinDescent', _struct.default.Uint16],
// version 0 above 39

['ulCodePageRange1', _struct.default.Uint32], ['ulCodePageRange2', _struct.default.Uint32],
// version 1 above 41

['sxHeight', _struct.default.Int16], ['sCapHeight', _struct.default.Int16], ['usDefaultChar', _struct.default.Uint16], ['usBreakChar', _struct.default.Uint16], ['usMaxContext', _struct.default.Uint16]
// version 2,3,4 above 46
], {
  read: function read(reader, ttf) {
    var format = reader.readUint16(this.offset);
    var struct = this.struct;

    // format2
    if (format === 0) {
      struct = struct.slice(0, 39);
    } else if (format === 1) {
      struct = struct.slice(0, 41);
    }
    var OS2Head = _table.default.create('os2head', struct);
    var tbl = new OS2Head(this.offset).read(reader, ttf);

    // 补齐其他version的字段
    var os2Fields = {
      ulCodePageRange1: 1,
      ulCodePageRange2: 0,
      sxHeight: 0,
      sCapHeight: 0,
      usDefaultChar: 0,
      usBreakChar: 32,
      usMaxContext: 0
    };
    return Object.assign(os2Fields, tbl);
  },
  size: function size(ttf) {
    /* 优化120: 使用 optimizettf 预计算的 metrics，跳过全 glyf 遍历 */
    var metrics = ttf._metrics;
    var hinting = ttf.writeOptions ? ttf.writeOptions.hinting : false;

    if (metrics) {
      var glyfs = ttf.glyf;
      /* 计算 minRightSideBearing（需要逐字形遍历 advanceWidth - xMax） */
      var minRightSideBearing = 16384;
      for (var ri = 0, rl = glyfs.length; ri < rl; ri++) {
        var rg = glyfs[ri];
        if (rg.xMax != null) {
          var rsb = rg.advanceWidth - rg.xMax;
          if (rsb < minRightSideBearing) minRightSideBearing = rsb;
        }
      }

      ttf['OS/2'].version = 0x4;
      ttf['OS/2'].achVendID = (ttf['OS/2'].achVendID + '    ').slice(0, 4);
      ttf['OS/2'].xAvgCharWidth = metrics.xAvgCharWidth;
      ttf['OS/2'].ulUnicodeRange2 = 268435456;
      ttf['OS/2'].usFirstCharIndex = metrics.usFirstCharIndex;
      ttf['OS/2'].usLastCharIndex = metrics.usLastCharIndex;

      ttf.hhea.version = ttf.hhea.version || 0x1;
      ttf.hhea.advanceWidthMax = metrics.advanceWidthMax;
      ttf.hhea.minLeftSideBearing = metrics.minLeftSideBearing;
      ttf.hhea.minRightSideBearing = minRightSideBearing;
      ttf.hhea.xMaxExtent = metrics.xMaxExtent;

      ttf.head.version = ttf.head.version || 0x1;
      ttf.head.lowestRecPPEM = ttf.head.lowestRecPPEM || 0x8;
      ttf.head.xMin = metrics.xMin;
      ttf.head.yMin = metrics.yMin;
      ttf.head.xMax = metrics.xMax;
      ttf.head.yMax = metrics.yMax;

      if (ttf.support.head) {
        var _ttf$support$head = ttf.support.head;
        if (_ttf$support$head.xMin != null) ttf.head.xMin = _ttf$support$head.xMin;
        if (_ttf$support$head.yMin != null) ttf.head.yMin = _ttf$support$head.yMin;
        if (_ttf$support$head.xMax != null) ttf.head.xMax = _ttf$support$head.xMax;
        if (_ttf$support$head.yMax != null) ttf.head.yMax = _ttf$support$head.yMax;
      }
      if (ttf.support.hhea) {
        var _ttf$support$hhea = ttf.support.hhea;
        if (_ttf$support$hhea.advanceWidthMax != null) ttf.hhea.advanceWidthMax = _ttf$support$hhea.advanceWidthMax;
        if (_ttf$support$hhea.xMaxExtent != null) ttf.hhea.xMaxExtent = _ttf$support$hhea.xMaxExtent;
        if (_ttf$support$hhea.minLeftSideBearing != null) ttf.hhea.minLeftSideBearing = _ttf$support$hhea.minLeftSideBearing;
        if (_ttf$support$hhea.minRightSideBearing != null) ttf.hhea.minRightSideBearing = _ttf$support$hhea.minRightSideBearing;
      }

      ttf.maxp = ttf.maxp || {};
      ttf.support.maxp = {
        version: 1.0,
        numGlyphs: ttf.glyf.length,
        maxPoints: metrics.maxPoints,
        maxContours: metrics.maxContours,
        maxCompositePoints: 0,
        maxCompositeContours: 0,
        maxZones: ttf.maxp.maxZones || 0,
        maxTwilightPoints: ttf.maxp.maxTwilightPoints || 0,
        maxStorage: ttf.maxp.maxStorage || 0,
        maxFunctionDefs: ttf.maxp.maxFunctionDefs || 0,
        maxStackElements: ttf.maxp.maxStackElements || 0,
        maxSizeOfInstructions: 0,
        maxComponentElements: 0,
        maxComponentDepth: 0
      };

      delete ttf._metrics;
      return _table.default.size.call(this, ttf);
    }

    /* 无预计算 metrics 时的原始逻辑 */
    var xMin = 16384, yMin = 16384, xMax = -16384, yMax = -16384;
    var advanceWidthMax = -1;
    var minLeftSideBearing = 16384;
    var minRightSideBearing = 16384;
    var xMaxExtent = -16384;
    var xAvgCharWidth = 0;
    var usFirstCharIndex = 0x10FFFF;
    var usLastCharIndex = -1;
    var maxPoints = 0, maxContours = 0;
    var maxCompositePoints = 0, maxCompositeContours = 0;
    var maxSizeOfInstructions = 0;
    var maxComponentElements = 0;
    var glyfNotEmpty = 0;

    if (hinting) {
      if (ttf.cvt) maxSizeOfInstructions = Math.max(maxSizeOfInstructions, ttf.cvt.length);
      if (ttf.prep) maxSizeOfInstructions = Math.max(maxSizeOfInstructions, ttf.prep.length);
      if (ttf.fpgm) maxSizeOfInstructions = Math.max(maxSizeOfInstructions, ttf.fpgm.length);
    }
    var glyfs = ttf.glyf;
    for (var gi = 0, gl = glyfs.length; gi < gl; gi++) {
      var glyf = glyfs[gi];
      if (glyf.compound) {
        var compositeContours = 0;
        var compositePoints = 0;
        var subGlyfs = glyf.glyfs;
        for (var sg = 0, sgl = subGlyfs.length; sg < sgl; sg++) {
          var cglyf = ttf.glyf[subGlyfs[sg].glyphIndex];
          if (!cglyf) continue;
          if (cglyf._numContours != null) {
            compositeContours += cglyf._numContours;
            compositePoints += cglyf._totalPoints;
          } else {
            var cContours = cglyf.contours;
            if (cContours) {
              compositeContours += cContours.length;
              if (cContours.length) {
                var cIsFlat = cglyf._flatContours;
                for (var cc = 0, ccl = cContours.length; cc < ccl; cc++) {
                  compositePoints += cIsFlat ? cContours[cc].length / 3 : cContours[cc].length;
                }
              }
            }
          }
        }
        maxComponentElements = Math.max(maxComponentElements, subGlyfs.length);
        maxCompositePoints = Math.max(maxCompositePoints, compositePoints);
        maxCompositeContours = Math.max(maxCompositeContours, compositeContours);
      } else if (glyf._numContours != null && glyf._numContours > 0) {
        /* 优化106: 使用 _numContours/_totalPoints 快速路径 */
        maxContours = Math.max(maxContours, glyf._numContours);
        maxPoints = Math.max(maxPoints, glyf._totalPoints);
      } else if (glyf.contours && glyf.contours.length) {
        var gContours = glyf.contours;
        maxContours = Math.max(maxContours, gContours.length);
        var points = 0;
        var isFlat = glyf._flatContours;
        for (var ci = 0, cil = gContours.length; ci < cil; ci++) {
          points += isFlat ? gContours[ci].length / 3 : gContours[ci].length;
        }
        maxPoints = Math.max(maxPoints, points);
      }
      if (hinting && glyf.instructions) {
        maxSizeOfInstructions = Math.max(maxSizeOfInstructions, glyf.instructions.length);
      }
      var gXMin = glyf.xMin;
      var gYMin = glyf.yMin;
      var gXMax = glyf.xMax;
      var gYMax = glyf.yMax;
      if (null != gXMin && gXMin < xMin) xMin = gXMin;
      if (null != gYMin && gYMin < yMin) yMin = gYMin;
      if (null != gXMax && gXMax > xMax) xMax = gXMax;
      if (null != gYMax && gYMax > yMax) yMax = gYMax;
      advanceWidthMax = Math.max(advanceWidthMax, glyf.advanceWidth);
      minLeftSideBearing = Math.min(minLeftSideBearing, glyf.leftSideBearing);
      if (null != gXMax) {
        minRightSideBearing = Math.min(minRightSideBearing, glyf.advanceWidth - gXMax);
        xMaxExtent = Math.max(xMaxExtent, gXMax);
      }
      if (null != glyf.advanceWidth) {
        xAvgCharWidth += glyf.advanceWidth;
        glyfNotEmpty++;
      }
      var unicodes = glyf.unicode;
      if (typeof unicodes === 'number') unicodes = [unicodes];
      if (Array.isArray(unicodes)) {
        for (var ui = 0, ul = unicodes.length; ui < ul; ui++) {
          if (unicodes[ui] !== 0xFFFF) {
            if (unicodes[ui] < usFirstCharIndex) usFirstCharIndex = unicodes[ui];
            if (unicodes[ui] > usLastCharIndex) usLastCharIndex = unicodes[ui];
          }
        }
      }
    }

    ttf['OS/2'].version = 0x4;
    ttf['OS/2'].achVendID = (ttf['OS/2'].achVendID + '    ').slice(0, 4);
    ttf['OS/2'].xAvgCharWidth = xAvgCharWidth / (glyfNotEmpty || 1);
    ttf['OS/2'].ulUnicodeRange2 = 268435456;
    ttf['OS/2'].usFirstCharIndex = usFirstCharIndex;
    ttf['OS/2'].usLastCharIndex = usLastCharIndex;

    ttf.hhea.version = ttf.hhea.version || 0x1;
    ttf.hhea.advanceWidthMax = advanceWidthMax;
    ttf.hhea.minLeftSideBearing = minLeftSideBearing;
    ttf.hhea.minRightSideBearing = minRightSideBearing;
    ttf.hhea.xMaxExtent = xMaxExtent;

    ttf.head.version = ttf.head.version || 0x1;
    ttf.head.lowestRecPPEM = ttf.head.lowestRecPPEM || 0x8;
    ttf.head.xMin = xMin;
    ttf.head.yMin = yMin;
    ttf.head.xMax = xMax;
    ttf.head.yMax = yMax;

    if (ttf.support.head) {
      var _ttf$support$head = ttf.support.head;
      if (_ttf$support$head.xMin != null) ttf.head.xMin = _ttf$support$head.xMin;
      if (_ttf$support$head.yMin != null) ttf.head.yMin = _ttf$support$head.yMin;
      if (_ttf$support$head.xMax != null) ttf.head.xMax = _ttf$support$head.xMax;
      if (_ttf$support$head.yMax != null) ttf.head.yMax = _ttf$support$head.yMax;
    }
    if (ttf.support.hhea) {
      var _ttf$support$hhea = ttf.support.hhea;
      if (_ttf$support$hhea.advanceWidthMax != null) ttf.hhea.advanceWidthMax = _ttf$support$hhea.advanceWidthMax;
      if (_ttf$support$hhea.xMaxExtent != null) ttf.hhea.xMaxExtent = _ttf$support$hhea.xMaxExtent;
      if (_ttf$support$hhea.minLeftSideBearing != null) ttf.hhea.minLeftSideBearing = _ttf$support$hhea.minLeftSideBearing;
      if (_ttf$support$hhea.minRightSideBearing != null) ttf.hhea.minRightSideBearing = _ttf$support$hhea.minRightSideBearing;
    }
    ttf.maxp = ttf.maxp || {};
    ttf.support.maxp = {
      version: 1.0,
      numGlyphs: ttf.glyf.length,
      maxPoints: maxPoints,
      maxContours: maxContours,
      maxCompositePoints: maxCompositePoints,
      maxCompositeContours: maxCompositeContours,
      maxZones: ttf.maxp.maxZones || 0,
      maxTwilightPoints: ttf.maxp.maxTwilightPoints || 0,
      maxStorage: ttf.maxp.maxStorage || 0,
      maxFunctionDefs: ttf.maxp.maxFunctionDefs || 0,
      maxStackElements: ttf.maxp.maxStackElements || 0,
      maxSizeOfInstructions: maxSizeOfInstructions,
      maxComponentElements: maxComponentElements,
      maxComponentDepth: maxComponentElements ? 1 : 0
    };
    return _table.default.size.call(this, ttf);
  }
});