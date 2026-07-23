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
 * 优化92+94: parseSimpleGlyf 使用 TypedArray，延迟 contour 构建到 optimize 阶段
 */
function parseSimpleGlyf(reader, glyf) {
  var offset = reader.offset;
  var endPtsOfContours = glyf.endPtsOfContours;
  var numberOfCoordinates = endPtsOfContours[endPtsOfContours.length - 1] + 1;

  if (numberOfCoordinates > MAX_NUMBER_OF_COORDINATES) {
    return glyf;
  }

  var REPEAT = _glyFlag.default.REPEAT;
  var XSHORT = _glyFlag.default.XSHORT;
  var XSAME = _glyFlag.default.XSAME;
  var YSHORT = _glyFlag.default.YSHORT;
  var YSAME = _glyFlag.default.YSAME;
  var ONCURVE = _glyFlag.default.ONCURVE;

  var view = reader.view;
  var vOffset = view.byteOffset + reader.offset;
  var flags = new Uint8Array(numberOfCoordinates);
  var fi = 0;
  while (fi < numberOfCoordinates) {
    var flag = view.getUint8(vOffset++);
    flags[fi++] = flag;
    if (flag & REPEAT && fi < numberOfCoordinates) {
      var repeat = view.getUint8(vOffset++);
      var fillCount = repeat < numberOfCoordinates - fi ? repeat : numberOfCoordinates - fi;
      flags.fill(flag, fi, fi + fillCount);
      fi += fillCount;
    }
  }

  var xArr = new Int32Array(numberOfCoordinates);
  var prevX = 0;
  for (var xi = 0; xi < numberOfCoordinates; xi++) {
    var x = 0;
    var xflag = flags[xi];
    /** 优化280: delta=0 是最常见情况，提前分支提高分支预测命中率 */
    if (!(xflag & XSHORT) && (xflag & XSAME)) {
      /* x = 0, 无需操作 */
    } else if (xflag & XSHORT) {
      x = view.getUint8(vOffset++);
      if (!(xflag & XSAME)) x = -x;
    } else {
      x = view.getInt16(vOffset);
      vOffset += 2;
    }
    prevX += x;
    xArr[xi] = prevX;
  }

  var yArr = new Int32Array(numberOfCoordinates);
  var prevY = 0;
  for (var yi = 0; yi < numberOfCoordinates; yi++) {
    var y = 0;
    var yflag = flags[yi];
    /** 优化280: delta=0 是最常见情况，提前分支 */
    if (!(yflag & YSHORT) && (yflag & YSAME)) {
      /* y = 0 */
    } else if (yflag & YSHORT) {
      y = view.getUint8(vOffset++);
      if (!(yflag & YSAME)) y = -y;
    } else {
      y = view.getInt16(vOffset);
      vOffset += 2;
    }
    prevY += y;
    yArr[yi] = prevY;
  }

  reader.offset = vOffset - view.byteOffset;

  /* 优化94: 保存 TypedArray 坐标数据，延迟 contour 构建到 optimize */
  glyf._xArr = xArr;
  glyf._yArr = yArr;
  glyf._flags = flags;
  return glyf;
}

/**
 * 读取复合字形
 * 优化257: 使用直接 DataView 访问替代 reader API，消除每次 read 的函数调用和参数检查
 */
/** 优化290: 复合字形枚举常量提升到模块级别，消除每次调用的属性查找 */
var _ARG_1_AND_2_ARE_WORDS = _componentFlag.default.ARG_1_AND_2_ARE_WORDS;
var _WE_HAVE_A_SCALE = _componentFlag.default.WE_HAVE_A_SCALE;
var _WE_HAVE_AN_X_AND_Y_SCALE = _componentFlag.default.WE_HAVE_AN_X_AND_Y_SCALE;
var _WE_HAVE_A_TWO_BY_TWO = _componentFlag.default.WE_HAVE_A_TWO_BY_TWO;
var _ARGS_ARE_XY_VALUES = _componentFlag.default.ARGS_ARE_XY_VALUES;
var _USE_MY_METRICS = _componentFlag.default.USE_MY_METRICS;
var _OVERLAP_COMPOUND = _componentFlag.default.OVERLAP_COMPOUND;
var _MORE_COMPONENTS = _componentFlag.default.MORE_COMPONENTS;
var _WE_HAVE_INSTRUCTIONS = _componentFlag.default.WE_HAVE_INSTRUCTIONS;

function parseCompoundGlyf(reader, glyf) {
  glyf.compound = true;
  glyf.glyfs = [];
  var flags;
  var ARG_1_AND_2_ARE_WORDS = _ARG_1_AND_2_ARE_WORDS;
  var WE_HAVE_A_SCALE = _WE_HAVE_A_SCALE;
  var WE_HAVE_AN_X_AND_Y_SCALE = _WE_HAVE_AN_X_AND_Y_SCALE;
  var WE_HAVE_A_TWO_BY_TWO = _WE_HAVE_A_TWO_BY_TWO;
  var ARGS_ARE_XY_VALUES = _ARGS_ARE_XY_VALUES;
  var USE_MY_METRICS = _USE_MY_METRICS;
  var OVERLAP_COMPOUND = _OVERLAP_COMPOUND;
  var MORE_COMPONENTS = _MORE_COMPONENTS;
  var WE_HAVE_INSTRUCTIONS = _WE_HAVE_INSTRUCTIONS;

  var view = reader.view;
  var vOffset = view.byteOffset + reader.offset;

  /** 优化293: F2DOT14 逆比例常量提升到循环外（raw * (1/16384) 浮点解码） */
  var F2DOT14_INV = 0.00006103515625;
  do {
    flags = view.getUint16(vOffset, false); vOffset += 2;
    var glyphIndex = view.getUint16(vOffset, false); vOffset += 2;
    var arg1 = 0;
    var arg2 = 0;
    var scaleX = 16384;
    var scaleY = 16384;
    var scale01 = 0;
    var scale10 = 0;
    if (ARG_1_AND_2_ARE_WORDS & flags) {
      arg1 = view.getInt16(vOffset, false); vOffset += 2;
      arg2 = view.getInt16(vOffset, false); vOffset += 2;
    } else {
      arg1 = view.getInt8(vOffset); vOffset += 1;
      arg2 = view.getInt8(vOffset); vOffset += 1;
    }
    if (WE_HAVE_A_SCALE & flags) {
      scaleX = view.getInt16(vOffset, false); vOffset += 2;
      scaleY = scaleX;
    } else if (WE_HAVE_AN_X_AND_Y_SCALE & flags) {
      scaleX = view.getInt16(vOffset, false); vOffset += 2;
      scaleY = view.getInt16(vOffset, false); vOffset += 2;
    } else if (WE_HAVE_A_TWO_BY_TWO & flags) {
      scaleX = view.getInt16(vOffset, false); vOffset += 2;
      scale01 = view.getInt16(vOffset, false); vOffset += 2;
      scale10 = view.getInt16(vOffset, false); vOffset += 2;
      scaleY = view.getInt16(vOffset, false); vOffset += 2;
    }
    /**
     * F2DOT14 解码：raw / 16384。
     * 原实现 (raw * 0.6103515625 + 0.5 | 0) * 0.0001 对负数有 bug——
     * `+0.5 | 0` 对负数是向零截断而非四舍五入，导致 -16384(=-1.0) 被解码成 -0.9999，
     * 复合字形水平镜像（如 FiraCode less_equal.liga 引用 greater_equal.liga）产生坐标漂移。
     * 直接 raw * (1/16384) 浮点解码，无量化、无符号偏差。
     */
    if (ARGS_ARE_XY_VALUES & flags) {
      glyf.glyfs.push({
        flags: flags,
        glyphIndex: glyphIndex,
        useMyMetrics: !!(flags & USE_MY_METRICS),
        overlapCompound: !!(flags & OVERLAP_COMPOUND),
        transform: { a: scaleX * F2DOT14_INV, b: scale01 * F2DOT14_INV, c: scale10 * F2DOT14_INV, d: scaleY * F2DOT14_INV, e: arg1, f: arg2 }
      });
    } else {
      glyf.glyfs.push({
        flags: flags,
        glyphIndex: glyphIndex,
        points: [arg1, arg2],
        transform: { a: scaleX * F2DOT14_INV, b: scale01 * F2DOT14_INV, c: scale10 * F2DOT14_INV, d: scaleY * F2DOT14_INV, e: 0, f: 0 }
      });
    }
  } while (MORE_COMPONENTS & flags);

  if (WE_HAVE_INSTRUCTIONS & flags) {
    var length = view.getUint16(vOffset, false); vOffset += 2;
    if (length < MAX_INSTRUCTION_LENGTH) {
      var instructions = new Array(length);
      for (var i = 0; i < length; ++i) {
        instructions[i] = view.getUint8(vOffset + i);
      }
      glyf.instructions = instructions;
    }
    vOffset += length;
  }

  reader.offset = vOffset - view.byteOffset;
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
  /** 优化290: 缓存 ttf.readOptions 到局部变量，消除重复属性链查找 */
  var readOpts = ttf.readOptions || {};
  var hinting = readOpts.hinting;

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
      /** 优化245: undefined → 0，避免 V8 隐藏类转换，后续取默认值 0 */
      glyf.xMin = 0;
      glyf.yMin = 0;
      glyf.xMax = 0;
      glyf.yMax = 0;
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
    /* 优化94: 保留 endPtsOfContours 供 optimize 使用，不再删除 */
  } else {
    reader.offset = vOffset - view.byteOffset;
    parseCompoundGlyf(reader, glyf);
  }
  return glyf;
}
