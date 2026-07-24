"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = sizeof;
var _glyFlag = _interopRequireDefault(require("../../enum/glyFlag"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/** 优化279: 枚举常量提升到模块级别，消除每个 glyph 调用时的属性查找 */
var _ONCURVE = _glyFlag.default.ONCURVE;
var _XSHORT = _glyFlag.default.XSHORT;
var _YSHORT = _glyFlag.default.YSHORT;
var _XSAME = _glyFlag.default.XSAME;
var _YSAME = _glyFlag.default.YSAME;
var _REPEAT = _glyFlag.default.REPEAT;
/**
 * @file 获取glyf的大小，同时对glyf写入进行预处理
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化33+38+39+40+48+49+57+66: getFlagsAndSize 单遍扫描替代两遍扫描，支持扁平 contours
 */
function getFlagsAndSize(glyf, glyfSupport, hinting) {
  if (!glyf.contours || glyf.contours.length === 0) {
    return 0;
  }

  /* 优化84+98+103+223: 直接复用 optimize 阶段预计算的 flags/encodedCoordSize + 预编码 buffer */
  var pre = glyf._precomputedGlyfSupport || (glyf._preFlags ? glyf : null);
  if (pre) {
    glyfSupport.flags = pre.flags || pre._preFlags;
    /* 优化256: buffer 已在写入方 trim，直接使用，消除二次 subarray slicing */
    var pxBuf = pre.xBuf || pre._preXBuf;
    if (pxBuf) {
      glyfSupport.xEncoded = pxBuf;
      glyfSupport.yEncoded = pre.yBuf || pre._preYBuf;
    } else {
      glyfSupport.xCoord = pre.xCoord;
      glyfSupport.yCoord = pre.yCoord;
    }
    glyf._precomputedGlyfSupport = null;
    var instructionSize = (hinting && glyf.instructions) ? glyf.instructions.length : 0;
    /* 优化103: 优先使用 _numContours */
    var nc = glyf._numContours != null ? glyf._numContours : glyf.contours.length;
    var encSz = pre.encodedCoordSize || pre._preEncodedCoordSize;
    return 12 + nc * 2 + glyfSupport.flags.length + encSz + instructionSize;
  }

  var ONCURVE = _ONCURVE;
  var XSHORT = _XSHORT;
  var YSHORT = _YSHORT;
  var XSAME = _XSAME;
  var YSAME = _YSAME;
  var REPEAT = _REPEAT;

  var contours = glyf.contours;
  var isFlat = glyf._flatContours;

  /** 预计算总点数，一次性分配 TypedArray */
  var totalPts = 0;
  for (var tc = 0, tcl = contours.length; tc < tcl; tc++) {
    totalPts += isFlat ? contours[tc].length / 3 | 0 : contours[tc].length;
  }

  var flagsC = new Uint8Array(totalPts);
  var xCoordBuf = new Uint8Array(totalPts * 2);
  var yCoordBuf = new Uint8Array(totalPts * 2);
  var xbi = 0, ybi = 0;
  var prevX = 0, prevY = 0;
  var prevFlag = -1;
  var repeatPoint = -1;
  var fi = 0;

  var encodedCoordSize = 0;

  /** 优化: isFirst 提取到循环外，消除每个点的条件分支 */
  var started = false;

  for (var j = 0, cl = contours.length; j < cl; j++) {
    var contour = contours[j];
    /** 优化293: 统一 isFlat 和非 isFlat 的编码循环，消除 60 行重复代码 */
    var step, cLen;
    if (isFlat) {
      step = 3; cLen = contour.length;
    } else {
      step = 1; cLen = contour.length;
    }
    for (var i = 0; i < cLen; i += step) {
      var px, py, onCurve;
      if (isFlat) {
        px = contour[i]; py = contour[i + 1]; onCurve = contour[i + 2];
      } else {
        px = contour[i].x; py = contour[i].y; onCurve = contour[i].onCurve;
      }
      var flag = onCurve ? ONCURVE : 0;
      var dx, dy;

      if (!started) {
        dx = px; dy = py; started = true;
      } else {
        dx = px - prevX; dy = py - prevY;
      }
      prevX = px; prevY = py;

      if (dx === 0) {
        flag += XSAME;
      } else if (dx > -256 && dx < 256) {
        flag += XSHORT;
        if (dx > 0) flag += XSAME;
        xCoordBuf[xbi++] = dx > 0 ? dx : -dx;
        encodedCoordSize += 1;
      } else {
        xCoordBuf[xbi++] = (dx >> 8) & 0xFF;
        xCoordBuf[xbi++] = dx & 0xFF;
        encodedCoordSize += 2;
      }

      if (dy === 0) {
        flag += YSAME;
      } else if (dy > -256 && dy < 256) {
        flag += YSHORT;
        if (dy > 0) flag += YSAME;
        yCoordBuf[ybi++] = dy > 0 ? dy : -dy;
        encodedCoordSize += 1;
      } else {
        yCoordBuf[ybi++] = (dy >> 8) & 0xFF;
        yCoordBuf[ybi++] = dy & 0xFF;
        encodedCoordSize += 2;
      }

      if (flag === prevFlag && started) {
        if (repeatPoint === -1) {
          repeatPoint = fi - 1;
          flagsC[repeatPoint] |= REPEAT;
          flagsC[fi++] = 1;
        } else if (flagsC[repeatPoint + 1] < 255) {
          ++flagsC[repeatPoint + 1];
        } else {
          /* 优化188: repeat count 达到 255 上限 */
          repeatPoint = -1;
          flagsC[fi++] = prevFlag = flag;
        }
      } else {
        repeatPoint = -1;
        flagsC[fi++] = prevFlag = flag;
      }
    }
  }

  flagsC = flagsC.subarray(0, fi);
  glyfSupport.flags = flagsC;
  glyfSupport.xEncoded = xCoordBuf.subarray(0, xbi);
  glyfSupport.yEncoded = yCoordBuf.subarray(0, ybi);

  var instructionSize = (hinting && glyf.instructions) ? glyf.instructions.length : 0;
  return 12 + contours.length * 2 + flagsC.length + encodedCoordSize + instructionSize;
}

/**
 * 优化48: sizeofCompound forEach → for 循环
 */
function sizeofCompound(glyf) {
  var size = 10;
  var glyfs = glyf.glyfs;
  for (var i = 0, l = glyfs.length; i < l; i++) {
    /** 优化212: 解构 transform 属性，消除重复属性查找 */
    var transform = glyfs[i].transform;
    var e = transform.e, f = transform.f;
    var a = transform.a, b = transform.b, c = transform.c, d = transform.d;
    size += 4;
    if (e < 0 || e > 0x7F || f < 0 || f > 0x7F) {
      size += 4;
    } else {
      size += 2;
    }
    if (b || c) {
      size += 8;
    } else if (a !== 1 || d !== 1) {
      size += a === d ? 2 : 4;
    }
  }
  return size;
}

/**
 * 优化49: sizeof glyf.forEach → for 循环
 */
/** 优化262: 空 glyph 预分配单例，避免每个空 glyph 创建新对象 */
var EMPTY_GLYF_SUPPORT = { glyfSize: 0, size: 0 };

function sizeof(ttf) {
  var glyfs = ttf.glyf;
  var glyfSupportArr = new Array(glyfs.length);
  ttf.support.glyf = glyfSupportArr;
  var tableSize = 0;
  var opts = ttf.writeOptions || {};
  var hinting = opts.hinting;
  var writeZeroContoursGlyfData = opts.writeZeroContoursGlyfData;

  for (var i = 0, gl = glyfs.length; i < gl; i++) {
    var glyf = glyfs[i];
    var glyfSupport;
    var glyfSize;
    if (glyf.compound) {
      glyfSupport = {};
      glyfSize = sizeofCompound(glyf);
    } else if (!writeZeroContoursGlyfData && (!glyf.contours || !glyf.contours.length)) {
      glyfSize = 0;
      glyfSupport = EMPTY_GLYF_SUPPORT;
    } else if (glyf._origBuf) {
      /** 优化310: simple 字形原始字节快路径，glyfSize 直接用原始字节长度。
       *  优化320: instructions 剥离——输出时移除 simple 字形的 hinting instructions（web 渲染用
       *  浏览器 autohint，原始 instructions 减小 glyf 字节）。_instrOff>=0 时长度减去 instructions 段。 */
      glyfSupport = {};
      glyfSize = glyf._origLen - (glyf._instrOff >= 0 ? glyf._instrLen : 0);
    } else {
      glyfSupport = {};
      glyfSize = getFlagsAndSize(glyf, glyfSupport, hinting);
    }

    var size = (glyfSize + 3) & ~3;
    glyfSupport.glyfSize = glyfSize;
    glyfSupport.size = size;
    glyfSupportArr[i] = glyfSupport;
    tableSize += size;
  }
  ttf.head.indexToLocFormat = tableSize > 65536 ? 1 : 0;
  return tableSize;
}
