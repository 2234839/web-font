"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = parseGlyf;
var _glyFlag = _interopRequireDefault(require("../../enum/glyFlag"));
var _componentFlag = _interopRequireDefault(require("../../enum/componentFlag"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 解析glyf轮廓
 * @author mengke01(kekee000@gmail.com)
 */

var MAX_INSTRUCTION_LENGTH = 5000;
var MAX_NUMBER_OF_COORDINATES = 20000;

/**
 * 优化9+12+34+41+42: parseSimpleGlyf 消除中间数组，直接 view 批量读取
 */
function parseSimpleGlyf(reader, glyf) {
  var offset = reader.offset;
  var numberOfCoordinates = glyf.endPtsOfContours[glyf.endPtsOfContours.length - 1] + 1;

  if (numberOfCoordinates > MAX_NUMBER_OF_COORDINATES) {
    console.warn('error read glyf coordinates:' + offset);
    return glyf;
  }

  /* 优化34: 缓存 glyFlag 常量 */
  var REPEAT = _glyFlag.default.REPEAT;
  var XSHORT = _glyFlag.default.XSHORT;
  var XSAME = _glyFlag.default.XSAME;
  var YSHORT = _glyFlag.default.YSHORT;
  var YSAME = _glyFlag.default.YSAME;
  var ONCURVE = _glyFlag.default.ONCURVE;

  /* 优化34+42: 直接 view 读取 flags */
  var view = reader.view;
  var vOffset = view.byteOffset + reader.offset;
  var flags = new Array(numberOfCoordinates);
  var i = 0;
  while (i < numberOfCoordinates) {
    var flag = view.getUint8(vOffset++);
    flags[i++] = flag;
    if (flag & REPEAT && i < numberOfCoordinates) {
      var repeat = view.getUint8(vOffset++);
      for (var j = 0; j < repeat && i < numberOfCoordinates; j++) {
        flags[i++] = flag;
      }
    }
  }

  /* 优化9+34: 直接构建扁平坐标数组，消除中间对象创建 */
  var xArr = new Array(numberOfCoordinates);
  var prevX = 0;
  for (var xi = 0; xi < numberOfCoordinates; xi++) {
    var x = 0;
    var xflag = flags[xi];
    if (xflag & XSHORT) {
      x = view.getUint8(vOffset++);
      x = (xflag & XSAME) ? x : -x;
    } else if (xflag & XSAME) {
      x = 0;
    } else {
      x = view.getInt16(vOffset);
      vOffset += 2;
    }
    prevX += x;
    xArr[xi] = prevX;
  }

  var yArr = new Array(numberOfCoordinates);
  var prevY = 0;
  for (var yi = 0; yi < numberOfCoordinates; yi++) {
    var y = 0;
    var yflag = flags[yi];
    if (yflag & YSHORT) {
      y = view.getUint8(vOffset++);
      y = (yflag & YSAME) ? y : -y;
    } else if (yflag & YSAME) {
      y = 0;
    } else {
      y = view.getInt16(vOffset);
      vOffset += 2;
    }
    prevY += y;
    yArr[yi] = prevY;
  }

  reader.offset = vOffset - view.byteOffset;

  /* 优化66: 扁平 contours [x, y, onCurve, x, y, onCurve, ...]，消除大量小对象 */
  if (numberOfCoordinates > 0) {
    var endPtsOfContours = glyf.endPtsOfContours;
    var contours = new Array(endPtsOfContours.length);
    var start = 0;
    for (var ci = 0, cl = endPtsOfContours.length; ci < cl; ci++) {
      var end = endPtsOfContours[ci] + 1;
      var numPoints = end - start;
      var contour = new Array(numPoints * 3);
      var ki = 0;
      for (var pi = start; pi < end; pi++) {
        contour[ki++] = xArr[pi];
        contour[ki++] = yArr[pi];
        contour[ki++] = !!(flags[pi] & ONCURVE);
      }
      contours[ci] = contour;
      start = end;
    }
    glyf.contours = contours;
    glyf._flatContours = true;
  }
  return glyf;
}

/**
 * 读取复合字形
 */
function parseCompoundGlyf(reader, glyf) {
  glyf.compound = true;
  glyf.glyfs = [];
  var flags;
  var g;
  var ARG_1_AND_2_ARE_WORDS = _componentFlag.default.ARG_1_AND_2_ARE_WORDS;
  var ROUND_XY_TO_GRID = _componentFlag.default.ROUND_XY_TO_GRID;
  var WE_HAVE_A_SCALE = _componentFlag.default.WE_HAVE_A_SCALE;
  var WE_HAVE_AN_X_AND_Y_SCALE = _componentFlag.default.WE_HAVE_AN_X_AND_Y_SCALE;
  var WE_HAVE_A_TWO_BY_TWO = _componentFlag.default.WE_HAVE_A_TWO_BY_TWO;
  var ARGS_ARE_XY_VALUES = _componentFlag.default.ARGS_ARE_XY_VALUES;
  var USE_MY_METRICS = _componentFlag.default.USE_MY_METRICS;
  var OVERLAP_COMPOUND = _componentFlag.default.OVERLAP_COMPOUND;
  var MORE_COMPONENTS = _componentFlag.default.MORE_COMPONENTS;
  var WE_HAVE_INSTRUCTIONS = _componentFlag.default.WE_HAVE_INSTRUCTIONS;

  do {
    flags = reader.readUint16();
    g = {};
    g.flags = flags;
    g.glyphIndex = reader.readUint16();
    var arg1 = 0;
    var arg2 = 0;
    var scaleX = 16384;
    var scaleY = 16384;
    var scale01 = 0;
    var scale10 = 0;
    if (ARG_1_AND_2_ARE_WORDS & flags) {
      arg1 = reader.readInt16();
      arg2 = reader.readInt16();
    } else {
      arg1 = reader.readInt8();
      arg2 = reader.readInt8();
    }
    if (ROUND_XY_TO_GRID & flags) {
      arg1 = Math.round(arg1);
      arg2 = Math.round(arg2);
    }
    if (WE_HAVE_A_SCALE & flags) {
      scaleX = reader.readInt16();
      scaleY = scaleX;
    } else if (WE_HAVE_AN_X_AND_Y_SCALE & flags) {
      scaleX = reader.readInt16();
      scaleY = reader.readInt16();
    } else if (WE_HAVE_A_TWO_BY_TWO & flags) {
      scaleX = reader.readInt16();
      scale01 = reader.readInt16();
      scale10 = reader.readInt16();
      scaleY = reader.readInt16();
    }
    if (ARGS_ARE_XY_VALUES & flags) {
      g.useMyMetrics = !!(flags & USE_MY_METRICS);
      g.overlapCompound = !!(flags & OVERLAP_COMPOUND);
      g.transform = {
        a: Math.round(10000 * scaleX / 16384) / 10000,
        b: Math.round(10000 * scale01 / 16384) / 10000,
        c: Math.round(10000 * scale10 / 16384) / 10000,
        d: Math.round(10000 * scaleY / 16384) / 10000,
        e: arg1,
        f: arg2
      };
    } else {
      g.points = [arg1, arg2];
      g.transform = {
        a: Math.round(10000 * scaleX / 16384) / 10000,
        b: Math.round(10000 * scale01 / 16384) / 10000,
        c: Math.round(10000 * scale10 / 16384) / 10000,
        d: Math.round(10000 * scaleY / 16384) / 10000,
        e: 0,
        f: 0
      };
    }
    glyf.glyfs.push(g);
  } while (MORE_COMPONENTS & flags);
  if (WE_HAVE_INSTRUCTIONS & flags) {
    var length = reader.readUint16();
    if (length < MAX_INSTRUCTION_LENGTH) {
      var instructions = new Array(length);
      for (var i = 0; i < length; ++i) {
        instructions[i] = reader.readUint8();
      }
      glyf.instructions = instructions;
    } else {
      console.warn(length);
    }
  }
  return glyf;
}

/**
 * 优化41: header 和 endPtsOfContours 直接 view 批量读取
 * 优化12: 非 hinting 模式跳过 instructions
 */
function parseGlyf(reader, ttf, offset) {
  if (null != offset) {
    reader.seek(offset);
  }
  var glyf = {};
  var hinting = ttf.readOptions ? ttf.readOptions.hinting : false;

  /* 优化41: 直接 view 读取 header 的 10 字节 */
  var view = reader.view;
  var vOffset = view.byteOffset + reader.offset;
  var numberOfContours = view.getInt16(vOffset, false);
  glyf.xMin = view.getInt16(vOffset + 2, false);
  glyf.yMin = view.getInt16(vOffset + 4, false);
  glyf.xMax = view.getInt16(vOffset + 6, false);
  glyf.yMax = view.getInt16(vOffset + 8, false);
  vOffset += 10;

  if (numberOfContours >= 0) {
    /* 优化41: endPtsOfContours 预分配 + 直接 view 读取 */
    if (numberOfContours > 0) {
      glyf.endPtsOfContours = new Array(numberOfContours);
      for (var i = 0; i < numberOfContours; i++) {
        glyf.endPtsOfContours[i] = view.getUint16(vOffset, false);
        vOffset += 2;
      }
    } else {
      delete glyf.xMin;
      delete glyf.yMin;
      delete glyf.xMax;
      delete glyf.yMax;
    }

    /* 优化12+42: 非 hinting 模式只跳过 instructions */
    var instrLength = view.getUint16(vOffset, false);
    vOffset += 2;
    if (hinting && instrLength && instrLength < MAX_INSTRUCTION_LENGTH) {
      var instructions = new Array(instrLength);
      for (var j = 0; j < instrLength; j++) {
        instructions[j] = view.getUint8(vOffset + j);
      }
      glyf.instructions = instructions;
    }
    vOffset += instrLength;
    reader.offset = vOffset - view.byteOffset;

    parseSimpleGlyf(reader, glyf);
    delete glyf.endPtsOfContours;
  } else {
    reader.offset = vOffset - view.byteOffset;
    parseCompoundGlyf(reader, glyf);
  }
  return glyf;
}
