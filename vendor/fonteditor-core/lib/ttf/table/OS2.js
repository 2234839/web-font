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
/**
 * 优化309: os2head 表类按 format（0/1/2+）的模块级缓存。
 * 原实现每次 read 都 struct.slice + _table.create 动态建类，是 OS/2 parse 主开销。
 */
var _os2HeadCache = {};
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
  /** 优化176: 直接 view 写入 96 字节，绕过 table.js 双重 switch 分发 */
  write: function write(writer, ttf) {
    var o = ttf['OS/2'];
    var pos = writer.offset;
    var view = writer.view;
    view.setUint16(pos, o.version, false); pos += 2;
    view.setInt16(pos, o.xAvgCharWidth, false); pos += 2;
    view.setUint16(pos, o.usWeightClass, false); pos += 2;
    view.setUint16(pos, o.usWidthClass, false); pos += 2;
    view.setUint16(pos, o.fsType, false); pos += 2;
    view.setUint16(pos, o.ySubscriptXSize, false); pos += 2;
    view.setUint16(pos, o.ySubscriptYSize, false); pos += 2;
    view.setUint16(pos, o.ySubscriptXOffset, false); pos += 2;
    view.setUint16(pos, o.ySubscriptYOffset, false); pos += 2;
    view.setUint16(pos, o.ySuperscriptXSize, false); pos += 2;
    view.setUint16(pos, o.ySuperscriptYSize, false); pos += 2;
    view.setUint16(pos, o.ySuperscriptXOffset, false); pos += 2;
    view.setUint16(pos, o.ySuperscriptYOffset, false); pos += 2;
    view.setUint16(pos, o.yStrikeoutSize, false); pos += 2;
    view.setUint16(pos, o.yStrikeoutPosition, false); pos += 2;
    view.setUint16(pos, o.sFamilyClass, false); pos += 2;
    view.setUint8(pos, o.bFamilyType); pos += 1;
    view.setUint8(pos, o.bSerifStyle); pos += 1;
    view.setUint8(pos, o.bWeight); pos += 1;
    view.setUint8(pos, o.bProportion); pos += 1;
    view.setUint8(pos, o.bContrast); pos += 1;
    view.setUint8(pos, o.bStrokeVariation); pos += 1;
    view.setUint8(pos, o.bArmStyle); pos += 1;
    view.setUint8(pos, o.bLetterform); pos += 1;
    view.setUint8(pos, o.bMidline); pos += 1;
    view.setUint8(pos, o.bXHeight); pos += 1;
    view.setUint32(pos, o.ulUnicodeRange1 || 0, false); pos += 4;
    view.setUint32(pos, o.ulUnicodeRange2 || 0, false); pos += 4;
    view.setUint32(pos, o.ulUnicodeRange3 || 0, false); pos += 4;
    view.setUint32(pos, o.ulUnicodeRange4 || 0, false); pos += 4;
    var vendor = (o.achVendID || '    ').slice(0, 4);
    view.setUint8(pos, vendor.charCodeAt(0)); pos += 1;
    view.setUint8(pos, vendor.charCodeAt(1)); pos += 1;
    view.setUint8(pos, vendor.charCodeAt(2)); pos += 1;
    view.setUint8(pos, vendor.charCodeAt(3)); pos += 1;
    view.setUint16(pos, o.fsSelection, false); pos += 2;
    view.setUint16(pos, o.usFirstCharIndex, false); pos += 2;
    view.setUint16(pos, o.usLastCharIndex, false); pos += 2;
    view.setInt16(pos, o.sTypoAscender, false); pos += 2;
    view.setInt16(pos, o.sTypoDescender, false); pos += 2;
    view.setInt16(pos, o.sTypoLineGap, false); pos += 2;
    view.setUint16(pos, o.usWinAscent, false); pos += 2;
    view.setUint16(pos, o.usWinDescent, false); pos += 2;
    view.setUint32(pos, o.ulCodePageRange1 || 0, false); pos += 4;
    view.setUint32(pos, o.ulCodePageRange2 || 0, false); pos += 4;
    view.setInt16(pos, o.sxHeight || 0, false); pos += 2;
    view.setInt16(pos, o.sCapHeight || 0, false); pos += 2;
    view.setUint16(pos, o.usDefaultChar || 0, false); pos += 2;
    view.setUint16(pos, o.usBreakChar != null ? o.usBreakChar : 32, false); pos += 2;
    view.setUint16(pos, o.usMaxContext || 0, false); pos += 2;
    writer.offset = pos;
    return writer;
  },
  read: function read(reader, ttf) {
    var format = reader.readUint16(this.offset);
    /**
     * 优化309: 按 format 缓存 os2head 表类。
     * 原实现每次 read 都 struct.slice + _table.create 动态建类（_createClass + Object.assign prototype），
     * 是 OS/2 parse 的主开销（prof 实测 ObjectAssign 占稳态 4.2%）。
     * format 仅 0/1/2+ 三种，struct 切片固定，表类按 format 缓存复用。
     * 另：去掉 Object.assign(os2Fields, tbl)，直接在 tbl 上补默认字段。
     */
    var OS2Head = _os2HeadCache[format];
    if (!OS2Head) {
      var struct = this.struct;
      if (format === 0) {
        struct = struct.slice(0, 39);
      } else if (format === 1) {
        struct = struct.slice(0, 41);
      }
      OS2Head = _table.default.create('os2head', struct);
      _os2HeadCache[format] = OS2Head;
    }
    var tbl = new OS2Head(this.offset).read(reader, ttf);

    // 补齐其他 version 的字段（直接在 tbl 上赋值，避免 Object.assign 创建 os2Fields 中间对象）
    if (tbl.ulCodePageRange1 === undefined) tbl.ulCodePageRange1 = 1;
    if (tbl.ulCodePageRange2 === undefined) tbl.ulCodePageRange2 = 0;
    if (tbl.sxHeight === undefined) tbl.sxHeight = 0;
    if (tbl.sCapHeight === undefined) tbl.sCapHeight = 0;
    if (tbl.usDefaultChar === undefined) tbl.usDefaultChar = 0;
    if (tbl.usBreakChar === undefined) tbl.usBreakChar = 32;
    if (tbl.usMaxContext === undefined) tbl.usMaxContext = 0;
    return tbl;
  },
  size: function size(ttf) {
    /* 优化120: 使用 optimizettf 预计算的 metrics，跳过全 glyf 遍历 */
    /** 优化288: 缓存频繁访问的属性链到局部变量 */
    var os2 = ttf['OS/2'];
    var hhea = ttf.hhea;
    var head = ttf.head;
    var maxp = ttf.maxp || (ttf.maxp = {});
    var metrics = ttf._metrics;
    var hinting = ttf.writeOptions ? ttf.writeOptions.hinting : false;

    if (metrics) {
      os2.version = 0x4;
      os2.achVendID = (os2.achVendID + '    ').slice(0, 4);
      os2.xAvgCharWidth = metrics.xAvgCharWidth;
      os2.ulUnicodeRange2 = 268435456;
      os2.usFirstCharIndex = metrics.usFirstCharIndex;
      os2.usLastCharIndex = metrics.usLastCharIndex;

      hhea.version = hhea.version || 0x1;
      hhea.advanceWidthMax = metrics.advanceWidthMax;
      hhea.minLeftSideBearing = metrics.minLeftSideBearing;
      hhea.minRightSideBearing = metrics.minRightSideBearing;
      hhea.xMaxExtent = metrics.xMaxExtent;

      head.version = head.version || 0x1;
      head.lowestRecPPEM = head.lowestRecPPEM || 0x8;
      head.xMin = metrics.xMin;
      head.yMin = metrics.yMin;
      head.xMax = metrics.xMax;
      head.yMax = metrics.yMax;

      if (ttf.support.head) {
        var _ttf$support$head = ttf.support.head;
        if (_ttf$support$head.xMin != null) head.xMin = _ttf$support$head.xMin;
        if (_ttf$support$head.yMin != null) head.yMin = _ttf$support$head.yMin;
        if (_ttf$support$head.xMax != null) head.xMax = _ttf$support$head.xMax;
        if (_ttf$support$head.yMax != null) head.yMax = _ttf$support$head.yMax;
      }
      if (ttf.support.hhea) {
        var _ttf$support$hhea = ttf.support.hhea;
        if (_ttf$support$hhea.advanceWidthMax != null) hhea.advanceWidthMax = _ttf$support$hhea.advanceWidthMax;
        if (_ttf$support$hhea.xMaxExtent != null) hhea.xMaxExtent = _ttf$support$hhea.xMaxExtent;
        if (_ttf$support$hhea.minLeftSideBearing != null) hhea.minLeftSideBearing = _ttf$support$hhea.minLeftSideBearing;
        if (_ttf$support$hhea.minRightSideBearing != null) hhea.minRightSideBearing = _ttf$support$hhea.minRightSideBearing;
      }

      ttf.support.maxp = {
        version: 1.0,
        numGlyphs: ttf.glyf.length,
        maxPoints: metrics.maxPoints,
        maxContours: metrics.maxContours,
        maxCompositePoints: 0,
        maxCompositeContours: 0,
        maxZones: maxp.maxZones || 0,
        maxTwilightPoints: maxp.maxTwilightPoints || 0,
        maxStorage: maxp.maxStorage || 0,
        maxFunctionDefs: maxp.maxFunctionDefs || 0,
        maxStackElements: maxp.maxStackElements || 0,
        maxSizeOfInstructions: 0,
        maxComponentElements: 0,
        maxComponentDepth: 0
      };

      /** 优化260: delete → null 赋值，避免 V8 隐藏类转换 */
      ttf._metrics = null;
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

    /** 优化288: 内联 Math.max 为条件判断，消除函数调用开销 */
    if (hinting) {
      var cvtLen = ttf.cvt ? ttf.cvt.length : 0;
      if (cvtLen > maxSizeOfInstructions) maxSizeOfInstructions = cvtLen;
      var prepLen = ttf.prep ? ttf.prep.length : 0;
      if (prepLen > maxSizeOfInstructions) maxSizeOfInstructions = prepLen;
      var fpgmLen = ttf.fpgm ? ttf.fpgm.length : 0;
      if (fpgmLen > maxSizeOfInstructions) maxSizeOfInstructions = fpgmLen;
    }
    var glyfs = ttf.glyf;
    for (var gi = 0, gl = glyfs.length; gi < gl; gi++) {
      var glyf = glyfs[gi];
      if (glyf.compound) {
        var compositeContours = 0;
        var compositePoints = 0;
        var subGlyfs = glyf.glyfs;
        for (var sg = 0, sgl = subGlyfs.length; sg < sgl; sg++) {
          /** 优化291: 缓存 subGlyfs[sg] 避免双重属性查找 */
          var sgRef = subGlyfs[sg];
          var cglyf = glyfs[sgRef.glyphIndex];
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
        if (subGlyfs.length > maxComponentElements) maxComponentElements = subGlyfs.length;
        if (compositePoints > maxCompositePoints) maxCompositePoints = compositePoints;
        if (compositeContours > maxCompositeContours) maxCompositeContours = compositeContours;
      } else if (glyf._numContours != null && glyf._numContours > 0) {
        /* 优化106: 使用 _numContours/_totalPoints 快速路径 */
        if (glyf._numContours > maxContours) maxContours = glyf._numContours;
        if (glyf._totalPoints > maxPoints) maxPoints = glyf._totalPoints;
      } else if (glyf.contours && glyf.contours.length) {
        var gContours = glyf.contours;
        if (gContours.length > maxContours) maxContours = gContours.length;
        var points = 0;
        var isFlat = glyf._flatContours;
        for (var ci = 0, cil = gContours.length; ci < cil; ci++) {
          points += isFlat ? gContours[ci].length / 3 | 0 : gContours[ci].length;
        }
        if (points > maxPoints) maxPoints = points;
      }
      if (hinting && glyf.instructions) {
        if (glyf.instructions.length > maxSizeOfInstructions) maxSizeOfInstructions = glyf.instructions.length;
      }
      var gXMin = glyf.xMin;
      var gYMin = glyf.yMin;
      var gXMax = glyf.xMax;
      var gYMax = glyf.yMax;
      if (null != gXMin && gXMin < xMin) xMin = gXMin;
      if (null != gYMin && gYMin < yMin) yMin = gYMin;
      if (null != gXMax && gXMax > xMax) xMax = gXMax;
      if (null != gYMax && gYMax > yMax) yMax = gYMax;
      if (glyf.advanceWidth > advanceWidthMax) advanceWidthMax = glyf.advanceWidth;
      if (glyf.leftSideBearing < minLeftSideBearing) minLeftSideBearing = glyf.leftSideBearing;
      if (null != gXMax) {
        var rsb = glyf.advanceWidth - gXMax;
        if (rsb < minRightSideBearing) minRightSideBearing = rsb;
        if (gXMax > xMaxExtent) xMaxExtent = gXMax;
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

    os2.version = 0x4;
    os2.achVendID = (os2.achVendID + '    ').slice(0, 4);
    os2.xAvgCharWidth = xAvgCharWidth / (glyfNotEmpty || 1);
    os2.ulUnicodeRange2 = 268435456;
    os2.usFirstCharIndex = usFirstCharIndex;
    os2.usLastCharIndex = usLastCharIndex;

    hhea.version = hhea.version || 0x1;
    hhea.advanceWidthMax = advanceWidthMax;
    hhea.minLeftSideBearing = minLeftSideBearing;
    hhea.minRightSideBearing = minRightSideBearing;
    hhea.xMaxExtent = xMaxExtent;

    head.version = head.version || 0x1;
    head.lowestRecPPEM = head.lowestRecPPEM || 0x8;
    head.xMin = xMin;
    head.yMin = yMin;
    head.xMax = xMax;
    head.yMax = yMax;

    if (ttf.support.head) {
      var _ttf$support$head = ttf.support.head;
      if (_ttf$support$head.xMin != null) head.xMin = _ttf$support$head.xMin;
      if (_ttf$support$head.yMin != null) head.yMin = _ttf$support$head.yMin;
      if (_ttf$support$head.xMax != null) head.xMax = _ttf$support$head.xMax;
      if (_ttf$support$head.yMax != null) head.yMax = _ttf$support$head.yMax;
    }
    if (ttf.support.hhea) {
      var _ttf$support$hhea = ttf.support.hhea;
      if (_ttf$support$hhea.advanceWidthMax != null) hhea.advanceWidthMax = _ttf$support$hhea.advanceWidthMax;
      if (_ttf$support$hhea.xMaxExtent != null) hhea.xMaxExtent = _ttf$support$hhea.xMaxExtent;
      if (_ttf$support$hhea.minLeftSideBearing != null) hhea.minLeftSideBearing = _ttf$support$hhea.minLeftSideBearing;
      if (_ttf$support$hhea.minRightSideBearing != null) hhea.minRightSideBearing = _ttf$support$hhea.minRightSideBearing;
    }
    ttf.support.maxp = {
      version: 1.0,
      numGlyphs: ttf.glyf.length,
      maxPoints: maxPoints,
      maxContours: maxContours,
      maxCompositePoints: maxCompositePoints,
      maxCompositeContours: maxCompositeContours,
      maxZones: maxp.maxZones || 0,
      maxTwilightPoints: maxp.maxTwilightPoints || 0,
      maxStorage: maxp.maxStorage || 0,
      maxFunctionDefs: maxp.maxFunctionDefs || 0,
      maxStackElements: maxp.maxStackElements || 0,
      maxSizeOfInstructions: maxSizeOfInstructions,
      maxComponentElements: maxComponentElements,
      maxComponentDepth: maxComponentElements ? 1 : 0
    };
    return _table.default.size.call(this, ttf);
  }
});