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
  /** 优化141: 复用 Uint8Array 视图，避免每次 set 创建临时视图 */
  var buf = view.buffer;
  var vbo = view.byteOffset;
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
    /* 优化117: 缓存 glyfSupport 引用到循环顶部 */
    var gSupport = glyfSupport[index];

    /* 优化51: return → continue */
    if (!glyf.compound && !writeZeroContoursGlyfData && (!glyf.contours || !glyf.contours.length)) {
      continue;
    }

    /* 优化31+103: header 直接 view 写入 10 字节，优先使用 _numContours */
    var pos = writer.offset;
    var numC = glyf._numContours != null ? glyf._numContours : (glyf.contours || []).length;
    view.setInt16(pos, glyf.compound ? -1 : numC, false);
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
      /* 优化32+66+103: endPtsOfContours 直接 view 写入，支持 _pointsPerContour */
      var contours = glyf.contours || [];
      var endPts = -1;
      var ppc = glyf._pointsPerContour;
      if (ppc) {
        for (var ci = 0, cl = ppc.length; ci < cl; ci++) {
          endPts += ppc[ci];
          view.setUint16(pos, endPts, false);
          pos += 2;
        }
      } else {
        var isFlat = glyf._flatContours;
        for (var ci2 = 0, cl2 = contours.length; ci2 < cl2; ci2++) {
          endPts += isFlat ? contours[ci2].length / 3 : contours[ci2].length;
          view.setUint16(pos, endPts, false);
          pos += 2;
        }
      }

      /* 优化25+80: instructions 使用 Uint8Array.set 批量写入 */
      if (hinting && glyf.instructions) {
        var instructions = glyf.instructions;
        view.setUint16(pos, instructions.length, false);
        pos += 2;
        if (instructions.length > 0) {
          var instrArr = instructions instanceof Uint8Array ? instructions : new Uint8Array(instructions);
          new Uint8Array(view.buffer, view.byteOffset + pos, instrArr.length).set(instrArr);
        }
        pos += instructions.length;
      } else {
        view.setUint16(pos, 0, false);
        pos += 2;
      }

      /* 优化11+79+135: flags 直接 view 写入，避免临时 TypedArray */
      var flags = gSupport.flags || [];
      for (var fi = 0, fl = flags.length; fi < fl; fi++) {
        view.setUint8(pos++, flags[fi]);
      }

      /* 优化21+98+119+141: xCoord 预编码 Uint8Array 直接 set，使用缓存引用 */
      if (gSupport.xEncoded) {
        new Uint8Array(buf, vbo + pos, gSupport.xEncoded.length).set(gSupport.xEncoded);
        pos += gSupport.xEncoded.length;
      } else {
        var xCoord = gSupport.xCoord || [];
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
      }

      /* 优化21+58+98+119+141: yCoord 预编码 Uint8Array 直接 set，使用缓存引用 */
      if (gSupport.yEncoded) {
        new Uint8Array(buf, vbo + pos, gSupport.yEncoded.length).set(gSupport.yEncoded);
        pos += gSupport.yEncoded.length;
      } else {
        var yCoord = gSupport.yCoord || [];
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
    }

    /* 优化81: 4字节对齐直接 view 写入，避免临时 TypedArray */
    var glyfSize = gSupport.glyfSize;
    if (glyfSize % 4) {
      var pad = 4 - glyfSize % 4;
      if (pad >= 1) view.setUint8(pos++, 0);
      if (pad >= 2) view.setUint8(pos++, 0);
      if (pad >= 3) view.setUint8(pos++, 0);
    }

    writer.offset = pos;
  }
  return writer;
}
