"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = sizeof;
var _glyFlag = _interopRequireDefault(require("../../enum/glyFlag"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
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

  /* 优化84+98+103: 直接复用 optimize 阶段预计算的 flags/encodedCoordSize + 预编码 buffer */
  if (glyf._precomputedGlyfSupport) {
    var pre = glyf._precomputedGlyfSupport;
    glyfSupport.flags = pre.flags;
    /* 优化98: 预编码 buffer 直接传递 */
    if (pre.xEncoded) {
      glyfSupport.xEncoded = pre.xEncoded;
      glyfSupport.yEncoded = pre.yEncoded;
    } else {
      glyfSupport.xCoord = pre.xCoord;
      glyfSupport.yCoord = pre.yCoord;
    }
    delete glyf._precomputedGlyfSupport;
    var instructionSize = (hinting && glyf.instructions) ? glyf.instructions.length : 0;
    /* 优化103: 优先使用 _numContours */
    var nc = glyf._numContours != null ? glyf._numContours : glyf.contours.length;
    return 12 + nc * 2 + pre.flags.length + pre.encodedCoordSize + instructionSize;
  }

  var ONCURVE = _glyFlag.default.ONCURVE;
  var XSHORT = _glyFlag.default.XSHORT;
  var YSHORT = _glyFlag.default.YSHORT;
  var XSAME = _glyFlag.default.XSAME;
  var YSAME = _glyFlag.default.YSAME;
  var REPEAT = _glyFlag.default.REPEAT;

  var flagsC = [];
  var xCoordC = [];
  var yCoordC = [];
  var contours = glyf.contours;
  var prevX = 0, prevY = 0;
  var isFirst = true;
  var prevFlag = -1;
  var repeatPoint = -1;

  var isFlat = glyf._flatContours;

  var encodedCoordSize = 0;

  for (var j = 0, cl = contours.length; j < cl; j++) {
    var contour = contours[j];
    if (isFlat) {
      for (var i = 0, l = contour.length; i < l; i += 3) {
        var px = contour[i];
        var py = contour[i + 1];
        var onCurve = contour[i + 2];
        var dx, dy;
        var flag = onCurve ? ONCURVE : 0;

        if (isFirst) {
          dx = px;
          dy = py;
          isFirst = false;
        } else {
          dx = px - prevX;
          dy = py - prevY;
        }
        prevX = px;
        prevY = py;

        if (dx === 0) {
          flag += XSAME;
        } else if (-0xFF <= dx && dx <= 0xFF) {
          flag += XSHORT;
          if (dx > 0) flag += XSAME;
          xCoordC.push(dx > 0 ? dx : -dx);
          encodedCoordSize += 1;
        } else {
          xCoordC.push(dx);
          encodedCoordSize += 2;
        }

        if (dy === 0) {
          flag += YSAME;
        } else if (-0xFF <= dy && dy <= 0xFF) {
          flag += YSHORT;
          if (dy > 0) flag += YSAME;
          yCoordC.push(dy > 0 ? dy : -dy);
          encodedCoordSize += 1;
        } else {
          yCoordC.push(dy);
          encodedCoordSize += 2;
        }

        /* REPEAT 压缩 */
        if (flag === prevFlag && !isFirst) {
          if (repeatPoint === -1) {
            repeatPoint = flagsC.length - 1;
            flagsC[repeatPoint] |= REPEAT;
            flagsC.push(1);
          } else {
            ++flagsC[repeatPoint + 1];
          }
        } else {
          repeatPoint = -1;
          flagsC.push(prevFlag = flag);
        }
      }
    } else {
      for (var i = 0, l = contour.length; i < l; i++) {
        var point = contour[i];
        var px = point.x;
        var py = point.y;
        var dx, dy;
        var flag = point.onCurve ? ONCURVE : 0;

        if (isFirst) {
          dx = px;
          dy = py;
          isFirst = false;
        } else {
          dx = px - prevX;
          dy = py - prevY;
        }
        prevX = px;
        prevY = py;

        if (dx === 0) {
          flag += XSAME;
        } else if (-0xFF <= dx && dx <= 0xFF) {
          flag += XSHORT;
          if (dx > 0) flag += XSAME;
          xCoordC.push(dx > 0 ? dx : -dx);
          encodedCoordSize += 1;
        } else {
          xCoordC.push(dx);
          encodedCoordSize += 2;
        }

        if (dy === 0) {
          flag += YSAME;
        } else if (-0xFF <= dy && dy <= 0xFF) {
          flag += YSHORT;
          if (dy > 0) flag += YSAME;
          yCoordC.push(dy > 0 ? dy : -dy);
          encodedCoordSize += 1;
        } else {
          yCoordC.push(dy);
          encodedCoordSize += 2;
        }

        /* REPEAT 压缩 */
        if (flag === prevFlag && !isFirst) {
          if (repeatPoint === -1) {
            repeatPoint = flagsC.length - 1;
            flagsC[repeatPoint] |= REPEAT;
            flagsC.push(1);
          } else {
            ++flagsC[repeatPoint + 1];
          }
        } else {
          repeatPoint = -1;
          flagsC.push(prevFlag = flag);
        }
      }
    }
  }

  glyfSupport.flags = flagsC;
  glyfSupport.xCoord = xCoordC;
  glyfSupport.yCoord = yCoordC;

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
    var transform = glyfs[i].transform;
    size += 4;
    if (transform.e < 0 || transform.e > 0x7F || transform.f < 0 || transform.f > 0x7F) {
      size += 4;
    } else {
      size += 2;
    }
    if (transform.b || transform.c) {
      size += 8;
    } else if (transform.a !== 1 || transform.d !== 1) {
      size += transform.a === transform.d ? 2 : 4;
    }
  }
  return size;
}

/**
 * 优化49: sizeof glyf.forEach → for 循环
 */
function sizeof(ttf) {
  var glyfSupportArr = [];
  ttf.support.glyf = glyfSupportArr;
  var tableSize = 0;
  var hinting = ttf.writeOptions ? ttf.writeOptions.hinting : false;
  var writeZeroContoursGlyfData = ttf.writeOptions ? ttf.writeOptions.writeZeroContoursGlyfData : false;
  var glyfs = ttf.glyf;

  for (var i = 0, gl = glyfs.length; i < gl; i++) {
    var glyf = glyfs[i];
    var glyfSupport = {};
    var glyfSize;
    if (glyf.compound) {
      glyfSize = sizeofCompound(glyf);
    } else if (!writeZeroContoursGlyfData && (!glyf.contours || !glyf.contours.length)) {
      glyfSize = 0;
    } else {
      glyfSize = getFlagsAndSize(glyf, glyfSupport, hinting);
    }

    var size = glyfSize;
    if (size % 4) {
      size += 4 - size % 4;
    }
    glyfSupport.glyfSize = glyfSize;
    glyfSupport.size = size;
    glyfSupportArr[i] = glyfSupport;
    tableSize += size;
  }
  glyfSupportArr.tableSize = tableSize;
  ttf.head.indexToLocFormat = tableSize > 65536 ? 1 : 0;
  return tableSize;
}
