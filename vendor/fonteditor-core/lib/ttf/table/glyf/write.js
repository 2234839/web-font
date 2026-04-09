"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = write;
var _componentFlag = _interopRequireDefault(require("../../enum/componentFlag"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 写glyf数据
 * @author mengke01(kekee000@gmail.com)
 */

/**
 * 优化11+21+25+31+32+50+51+52+53+58: glyf write 全面优化
 */
function write(writer, ttf) {
  var hinting = ttf.writeOptions ? ttf.writeOptions.hinting : false;
  var writeZeroContoursGlyfData = ttf.writeOptions ? ttf.writeOptions.writeZeroContoursGlyfData : false;

  /* 优化53: 缓存 glyfSupport 到局部变量 */
  var glyfSupport = ttf.support.glyf;
  var glyfs = ttf.glyf;
  var view = writer.view;
  var ARG_1_AND_2_ARE_WORDS = _componentFlag.default.ARG_1_AND_2_ARE_WORDS;
  var ROUND_XY_TO_GRID = _componentFlag.default.ROUND_XY_TO_GRID;
  var WE_HAVE_A_SCALE = _componentFlag.default.WE_HAVE_A_SCALE;
  var WE_HAVE_AN_X_AND_Y_SCALE = _componentFlag.default.WE_HAVE_AN_X_AND_Y_SCALE;
  var WE_HAVE_A_TWO_BY_TWO = _componentFlag.default.WE_HAVE_A_TWO_BY_TWO;
  var ARGS_ARE_XY_VALUES = _componentFlag.default.ARGS_ARE_XY_VALUES;
  var USE_MY_METRICS = _componentFlag.default.USE_MY_METRICS;
  var OVERLAP_COMPOUND = _componentFlag.default.OVERLAP_COMPOUND;
  var MORE_COMPONENTS = _componentFlag.default.MORE_COMPONENTS;

  for (var index = 0, gl = glyfs.length; index < gl; index++) {
    var glyf = glyfs[index];

    /* 优化51: return → continue */
    if (!glyf.compound && !writeZeroContoursGlyfData && (!glyf.contours || !glyf.contours.length)) {
      continue;
    }

    /* 优化31: header 直接 view 写入 10 字节 */
    var pos = writer.offset;
    view.setInt16(pos, glyf.compound ? -1 : (glyf.contours || []).length, false);
    view.setInt16(pos + 2, glyf.xMin, false);
    view.setInt16(pos + 4, glyf.yMin, false);
    view.setInt16(pos + 6, glyf.xMax, false);
    view.setInt16(pos + 8, glyf.yMax, false);
    pos += 10;

    if (glyf.compound) {
      var subGlyfs = glyf.glyfs;
      for (var gi = 0, gl2 = subGlyfs.length; gi < gl2; gi++) {
        var g = subGlyfs[gi];
        var flags = g.points ? 0 : ARGS_ARE_XY_VALUES + ROUND_XY_TO_GRID;
        if (gi < gl2 - 1) flags += MORE_COMPONENTS;
        flags += g.useMyMetrics ? USE_MY_METRICS : 0;
        flags += g.overlapCompound ? OVERLAP_COMPOUND : 0;
        var transform = g.transform;
        var a = transform.a;
        var b = transform.b;
        var c = transform.c;
        var d = transform.d;
        var e = g.points ? g.points[0] : transform.e;
        var f = g.points ? g.points[1] : transform.f;
        if (e < 0 || e > 0x7F || f < 0 || f > 0x7F) {
          flags += ARG_1_AND_2_ARE_WORDS;
        }
        if (b || c) {
          flags += WE_HAVE_A_TWO_BY_TWO;
        } else if ((a !== 1 || d !== 1) && a === d) {
          flags += WE_HAVE_A_SCALE;
        } else if (a !== 1 || d !== 1) {
          flags += WE_HAVE_AN_X_AND_Y_SCALE;
        }
        view.setUint16(pos, flags, false); pos += 2;
        view.setUint16(pos, g.glyphIndex, false); pos += 2;
        if (ARG_1_AND_2_ARE_WORDS & flags) {
          view.setInt16(pos, e, false); pos += 2;
          view.setInt16(pos, f, false); pos += 2;
        } else {
          view.setUint8(pos, e); pos += 1;
          view.setUint8(pos, f); pos += 1;
        }
        if (WE_HAVE_A_SCALE & flags) {
          view.setInt16(pos, Math.round(a * 16384), false); pos += 2;
        } else if (WE_HAVE_AN_X_AND_Y_SCALE & flags) {
          view.setInt16(pos, Math.round(a * 16384), false); pos += 2;
          view.setInt16(pos, Math.round(d * 16384), false); pos += 2;
        } else if (WE_HAVE_A_TWO_BY_TWO & flags) {
          view.setInt16(pos, Math.round(a * 16384), false); pos += 2;
          view.setInt16(pos, Math.round(b * 16384), false); pos += 2;
          view.setInt16(pos, Math.round(c * 16384), false); pos += 2;
          view.setInt16(pos, Math.round(d * 16384), false); pos += 2;
        }
      }
    } else {
      /* 优化32: endPtsOfContours 直接 view 写入 */
      var contours = glyf.contours || [];
      var endPts = -1;
      for (var ci = 0, cl = contours.length; ci < cl; ci++) {
        endPts += contours[ci].length;
        view.setUint16(pos, endPts, false);
        pos += 2;
      }

      /* 优化25: instructions 批量写入 */
      if (hinting && glyf.instructions) {
        var instructions = glyf.instructions;
        view.setUint16(pos, instructions.length, false);
        pos += 2;
        for (var ii = 0, il = instructions.length; ii < il; ii++) {
          view.setUint8(pos + ii, instructions[ii]);
        }
        pos += instructions.length;
      } else {
        view.setUint16(pos, 0, false);
        pos += 2;
      }

      /* 优化11: flags 批量写入 */
      var flags = glyfSupport[index].flags || [];
      for (var fi = 0, fl = flags.length; fi < fl; fi++) {
        view.setUint8(pos + fi, flags[fi]);
      }
      pos += fl;

      /* 优化21: xCoord 直接 view 写入 */
      var xCoord = glyfSupport[index].xCoord || [];
      for (var xi = 0, xl = xCoord.length; xi < xl; xi++) {
        var xv = xCoord[xi];
        if (0 <= xv && xv <= 0xFF) {
          view.setUint8(pos, xv);
          pos += 1;
        } else {
          view.setInt16(pos, xv, false);
          pos += 2;
        }
      }

      /* 优化21+58: yCoord 直接 view 写入，使用各自的数组长度 */
      var yCoord = glyfSupport[index].yCoord || [];
      for (var yi = 0, yl = yCoord.length; yi < yl; yi++) {
        var yv = yCoord[yi];
        if (0 <= yv && yv <= 0xFF) {
          view.setUint8(pos, yv);
          pos += 1;
        } else {
          view.setInt16(pos, yv, false);
          pos += 2;
        }
      }
    }

    /* 4字节对齐 */
    var glyfSize = glyfSupport[index].glyfSize;
    if (glyfSize % 4) {
      var pad = 4 - glyfSize % 4;
      for (var p = 0; p < pad; p++) {
        view.setUint8(pos + p, 0);
      }
      pos += pad;
    }

    writer.offset = pos;
  }
  return writer;
}
