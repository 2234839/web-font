"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = optimizettf;
exports.ceilReduceAndSizeFlat = ceilReduceAndSizeFlat;
var _reduceGlyf = _interopRequireDefault(require("./reduceGlyf"));
var _glyFlag = _interopRequireDefault(require("../enum/glyFlag"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/** 优化279: 枚举常量提升到模块级别，消除每个 glyph 调用时的属性查找 */
var _ONCURVE = _glyFlag.default.ONCURVE;
var _XSHORT = _glyFlag.default.XSHORT;
var _YSHORT = _glyFlag.default.YSHORT;
var _XSAME = _glyFlag.default.XSAME;
var _YSAME = _glyFlag.default.YSAME;
var _REPEAT = _glyFlag.default.REPEAT;
/**
 * @file 对ttf对象进行优化，查找错误，去除冗余点
 * @author mengke01(kekee000@gmail.com)
 */

/** 优化: 模块级排序函数，避免每个 glyph 创建闭包 */
function numericSort(a, b) { return a - b; }

/**
 * 优化103+116: 从 parse 阶段的 TypedArray 直接计算 precomputed 数据，跳过 contour 数组构建
 * 每个字形独立分配 buffer，避免共享 buffer 的复杂性
 */
function ceilReduceAndSizeFromTypedArrays(glyf) {
  var xArr = glyf._xArr;
  var yArr = glyf._yArr;
  var flagsArr = glyf._flags;
  var endPts = glyf.endPtsOfContours;
  var numContours = endPts.length;

  var ONCURVE = _ONCURVE;
  var XSHORT = _XSHORT;
  var YSHORT = _YSHORT;
  var XSAME = _XSAME;
  var YSAME = _YSAME;
  var REPEAT = _REPEAT;

  var numPoints = xArr.length;
  var flagsC = new Uint8Array(numPoints);
  var fi = 0;
  var prevFlag = -1;
  var repeatPoint = -1;
  var encodedCoordSize = 0;

  /* 每个字形独立分配 buffer */
  var neededSize = numPoints * 2;
  var xCoordBuf = new Uint8Array(neededSize);
  var yCoordBuf = new Uint8Array(neededSize);
  var xbi = 0, ybi = 0;

  /** 优化: 首点提取到循环外，消除 isFirst 条件分支 */
  if (numPoints > 0) {
    var px = xArr[0], py = yArr[0];
    var onCurve = !!(flagsArr[0] & ONCURVE);
    var flag = onCurve ? ONCURVE : 0;
    if (px === 0) flag += XSAME;
    else if (px > -256 && px < 256) { flag += XSHORT; if (px > 0) flag += XSAME; xCoordBuf[xbi++] = px > 0 ? px : -px; encodedCoordSize += 1; }
    else { xCoordBuf[xbi++] = (px >> 8) & 0xFF; xCoordBuf[xbi++] = px & 0xFF; encodedCoordSize += 2; }
    if (py === 0) flag += YSAME;
    else if (py > -256 && py < 256) { flag += YSHORT; if (py > 0) flag += YSAME; yCoordBuf[ybi++] = py > 0 ? py : -py; encodedCoordSize += 1; }
    else { yCoordBuf[ybi++] = (py >> 8) & 0xFF; yCoordBuf[ybi++] = py & 0xFF; encodedCoordSize += 2; }
    flagsC[fi++] = prevFlag = flag;
    var prevX = px, prevY = py;

    for (var pi = 1; pi < numPoints; pi++) {
      px = xArr[pi]; py = yArr[pi];
      onCurve = !!(flagsArr[pi] & ONCURVE);
      flag = onCurve ? ONCURVE : 0;
      var dx = px - prevX, dy = py - prevY;
      prevX = px; prevY = py;

      if (dx === 0) { flag += XSAME; }
      else if (dx > -256 && dx < 256) { flag += XSHORT; if (dx > 0) flag += XSAME; xCoordBuf[xbi++] = dx > 0 ? dx : -dx; encodedCoordSize += 1; }
      else { xCoordBuf[xbi++] = (dx >> 8) & 0xFF; xCoordBuf[xbi++] = dx & 0xFF; encodedCoordSize += 2; }
      if (dy === 0) { flag += YSAME; }
      else if (dy > -256 && dy < 256) { flag += YSHORT; if (dy > 0) flag += YSAME; yCoordBuf[ybi++] = dy > 0 ? dy : -dy; encodedCoordSize += 1; }
      else { yCoordBuf[ybi++] = (dy >> 8) & 0xFF; yCoordBuf[ybi++] = dy & 0xFF; encodedCoordSize += 2; }

      if (flag === prevFlag) {
        if (repeatPoint === -1) {
          repeatPoint = fi - 1;
          flagsC[repeatPoint] |= REPEAT;
          flagsC[fi++] = 1;
        } else if (flagsC[repeatPoint + 1] < 255) {
          ++flagsC[repeatPoint + 1];
        } else {
          /* 优化188: repeat count 达到 255 上限，结束当前 repeat 并开始新 flag */
          repeatPoint = -1;
          flagsC[fi++] = flag;
          prevFlag = flag;
        }
      } else {
        repeatPoint = -1;
        flagsC[fi++] = flag;
        prevFlag = flag;
      }
    }
  }

  flagsC = flagsC.subarray(0, fi);

  /* 优化201: 使用鸭子类型替代空数组分配，只提供 length 属性 */
  glyf.contours = { length: numContours };
  glyf._flatContours = true;
  /* 优化103: 存储每个 contour 的点数，供 write 计算 endPtsOfContours */
  glyf._pointsPerContour = new Array(numContours);
  for (var ci = 0; ci < numContours; ci++) {
    glyf._pointsPerContour[ci] = (ci === 0 ? endPts[0] + 1 : endPts[ci] - endPts[ci - 1]);
  }
  glyf._numContours = numContours;
  glyf._totalPoints = numPoints;

  /** 优化256: 在写入方直接 trim subarray，消除 sizeof.js 二次 slicing */
  glyf._preFlags = flagsC;
  glyf._preEncodedCoordSize = encodedCoordSize;
  glyf._preXBuf = xCoordBuf.subarray(0, xbi);
  glyf._preYBuf = yCoordBuf.subarray(0, ybi);
  glyf._preXLen = xbi;
  glyf._preYLen = ybi;

  glyf._xArr = null;
  glyf._flags = null;
  glyf.endPtsOfContours = null;
}

/**
 * 优化84+98+149: 合并 ceil+reduce+flagsAndSize 为单次遍历
 * 优化256: 写入方直接 trim subarray，消除 sizeof.js 二次 slicing
 */
function ceilReduceAndSizeFlat(glyf) {
  /** 优化279: _precomputedGlyfSupport 守卫提前，避免已缓存 glyph 的无效 contour 过滤 */
  if (glyf._precomputedGlyfSupport) {
    return;
  }

  var contours = glyf.contours;
  /* 优化279: 合并 contour 过滤和 totalPoints 计算 + _pointsPerContour 缓存为单次遍历 */
  var writeIdx = 0;
  var totalPoints = 0;
  var ppcArr = new Array(contours.length);
  for (var j = 0, cl = contours.length; j < cl; j++) {
    if (contours[j].length > 6) {
      var pts = contours[j].length / 3 | 0;
      ppcArr[writeIdx] = pts;
      totalPoints += pts;
      contours[writeIdx] = contours[j];
      writeIdx++;
    }
  }
  contours.length = writeIdx;
  ppcArr.length = writeIdx;
  if (0 === contours.length) {
    glyf.contours = null;
    return;
  }
  glyf._pointsPerContour = ppcArr;

  var ONCURVE = _ONCURVE;
  var XSHORT = _XSHORT;
  var YSHORT = _YSHORT;
  var XSAME = _XSAME;
  var YSAME = _YSAME;
  var REPEAT = _REPEAT;
  var flagsC = new Uint8Array(totalPoints);
  var fi = 0;
  var prevFlag = -1;
  var repeatPoint = -1;
  var encodedCoordSize = 0;

  /* 每个字形独立分配 buffer */
  var neededSize = totalPoints * 2;
  var xCoordBuf = new Uint8Array(neededSize);
  var yCoordBuf = new Uint8Array(neededSize);
  var xbi = 0, ybi = 0;

  /** 优化213: 首点提取到循环外，消除 per-point 条件分支 */
  var firstContour = contours[0];
  var fpx = firstContour[0], fpy = firstContour[1];
  var fOnCurve = firstContour[2];
  var fFlag = fOnCurve ? ONCURVE : 0;
  if (fpx === 0) fFlag += XSAME;
  else if (fpx > -256 && fpx < 256) { fFlag += XSHORT; if (fpx > 0) fFlag += XSAME; xCoordBuf[xbi++] = fpx > 0 ? fpx : -fpx; encodedCoordSize += 1; }
  else { xCoordBuf[xbi++] = (fpx >> 8) & 0xFF; xCoordBuf[xbi++] = fpx & 0xFF; encodedCoordSize += 2; }
  if (fpy === 0) fFlag += YSAME;
  else if (fpy > -256 && fpy < 256) { fFlag += YSHORT; if (fpy > 0) fFlag += YSAME; yCoordBuf[ybi++] = fpy > 0 ? fpy : -fpy; encodedCoordSize += 1; }
  else { yCoordBuf[ybi++] = (fpy >> 8) & 0xFF; yCoordBuf[ybi++] = fpy & 0xFF; encodedCoordSize += 2; }
  flagsC[fi++] = prevFlag = fFlag;
  var prevX = fpx, prevY = fpy;

  /** 优化213+262: 首点提取到循环外，第一个 contour 从 i=3 开始跳过首点，消除 per-point skipFirst 分支 */
  var skipFirstContour = true;
  for (var j = 0, cl2 = contours.length; j < cl2; j++) {
    var contour = contours[j];
    var startI = skipFirstContour ? 3 : 0;
    skipFirstContour = false;
    for (var i = startI, l = contour.length; i < l; i += 3) {
      var px = contour[i];
      var py = contour[i + 1];
      var onCurve = contour[i + 2];
      var flag = onCurve ? ONCURVE : 0;
      var dx = px - prevX, dy = py - prevY;
      prevX = px; prevY = py;

      if (dx === 0) {
        flag += XSAME;
      } else if (dx > -256 && dx < 256) {
        flag += XSHORT;
        if (dx > 0) flag += XSAME;
        var absDx = dx > 0 ? dx : -dx;
        xCoordBuf[xbi++] = absDx;
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
        var absDy = dy > 0 ? dy : -dy;
        yCoordBuf[ybi++] = absDy;
        encodedCoordSize += 1;
      } else {
        yCoordBuf[ybi++] = (dy >> 8) & 0xFF;
        yCoordBuf[ybi++] = dy & 0xFF;
        encodedCoordSize += 2;
      }

      if (flag === prevFlag) {
        if (repeatPoint === -1) {
          repeatPoint = fi - 1;
          flagsC[repeatPoint] |= REPEAT;
          flagsC[fi++] = 1;
        } else if (flagsC[repeatPoint + 1] < 255) {
          ++flagsC[repeatPoint + 1];
        } else {
          /* 优化188: repeat count 达到 255 上限，结束当前 repeat 并开始新 flag */
          repeatPoint = -1;
          flagsC[fi++] = flag;
          prevFlag = flag;
        }
      } else {
        repeatPoint = -1;
        flagsC[fi++] = flag;
        prevFlag = flag;
      }
    }
  }

  flagsC = flagsC.subarray(0, fi);

  /** 优化256: 在写入方直接 trim subarray，消除 sizeof.js 二次 slicing */
  glyf._preFlags = flagsC;
  glyf._preEncodedCoordSize = encodedCoordSize;
  glyf._preXBuf = xCoordBuf.subarray(0, xbi);
  glyf._preYBuf = yCoordBuf.subarray(0, ybi);
  glyf._preXLen = xbi;
  glyf._preYLen = ybi;
  glyf._totalPoints = totalPoints;
  glyf._numContours = contours.length;
}

/**
 * 优化99+103+112+116+120: 单次遍历优化所有字形，同时预计算 OS2/head/hhea metrics
 */
function optimizettf(ttf) {
  var checkUnicodeRepeat = {};
  var repeatList = [];
  var glyfs = ttf.glyf;
  var hasCompound = false;

  /* 优化120: 在主循环中同时计算 OS2/head/hhea metrics，消除 OS2.size() 的全 glyf 遍历 */
  var m_xMin = 16384, m_yMin = 16384, m_xMax = -16384, m_yMax = -16384;
  var m_advWMax = -1;
  var m_minLSB = 16384, m_minRSB = 16384;
  var m_xAvgSum = 0, m_glyfNotEmpty = 0;
  var m_firstChar = 0x10FFFF, m_lastChar = -1;
  var m_maxPoints = 0, m_maxContours = 0;

  for (var index = 0, gl = glyfs.length; index < gl; index++) {
    var glyf = glyfs[index];
    if (glyf.compound) {
      hasCompound = true;
    }
    if (glyf.unicode) {
      if (glyf.unicode.length > 1) {
        glyf.unicode.sort(numericSort);
      }
      var unicode = glyf.unicode;
      for (var ui = 0, ul = unicode.length; ui < ul; ui++) {
        var u = unicode[ui];
        if (checkUnicodeRepeat[u]) {
          repeatList.push(index);
        } else {
          checkUnicodeRepeat[u] = true;
        }
        /* 优化120: 同时收集 firstChar/lastChar */
        if (u !== 0xFFFF) {
          if (u < m_firstChar) m_firstChar = u;
          if (u > m_lastChar) m_lastChar = u;
        }
      }
    }
    if (!glyf.compound) {
      /* 优化94+116+149+150: 优先从 TypedArray 构建 contour + precompute，使用共享 buffer 池 */
      if (glyf._xArr) {
        ceilReduceAndSizeFromTypedArrays(glyf);
        /* 优化120: 从 _numContours/_totalPoints 收集 metrics */
        if (glyf._numContours > 0) {
          if (glyf._numContours > m_maxContours) m_maxContours = glyf._numContours;
          if (glyf._totalPoints > m_maxPoints) m_maxPoints = glyf._totalPoints;
        }
      } else if (glyf.contours) {
        if (glyf._flatContours) {
          ceilReduceAndSizeFlat(glyf);
          /**
           * ⚠️ 关键：必须收集 maxPoints/maxContours，否则 maxp 表中这两个值为 0，
           * 浏览器会据此跳过渲染（表现为字体加载成功但文字显示为空白/fallback）。
           * ceilReduceAndSizeFlat 已缓存 _totalPoints 和 _numContours。
           */
          if (glyf.contours) {
            if (glyf._numContours > m_maxContours) m_maxContours = glyf._numContours;
            if (glyf._totalPoints > m_maxPoints) m_maxPoints = glyf._totalPoints;
          }
        } else {
          /* 对象 contours 格式也需要收集 maxPoints/maxContours */
          var numC = glyf.contours.length;
          if (numC > 0) {
            if (numC > m_maxContours) m_maxContours = numC;
            var totalPts = 0;
            for (var ci = 0; ci < numC; ci++) {
              totalPts += glyf.contours[ci].length;
            }
            if (totalPts > m_maxPoints) m_maxPoints = totalPts;
          }
          /* 优化153: pathCeil 已在 transformContour 中完成，无需重复调用 */
          (0, _reduceGlyf.default)(glyf);
        }
      }
    }

    /* 优化120: 收集 metrics（跳过 Math.round，值已经是整数） */
    var gXMin = glyf.xMin || 0;
    var gYMin = glyf.yMin || 0;
    var gXMax = glyf.xMax || 0;
    var gYMax = glyf.yMax || 0;
    if (gXMin < m_xMin) m_xMin = gXMin;
    if (gYMin < m_yMin) m_yMin = gYMin;
    if (gXMax > m_xMax) m_xMax = gXMax;
    if (gYMax > m_yMax) m_yMax = gYMax;
    var gAdvW = glyf.advanceWidth || 0;
    if (gAdvW > m_advWMax) m_advWMax = gAdvW;
    var gLSB = glyf.leftSideBearing || 0;
    if (gLSB < m_minLSB) m_minLSB = gLSB;
    /* 优化120: 同时计算 minRightSideBearing = advanceWidth - xMax */
    var gRSB = gAdvW - gXMax;
    if (gRSB < m_minRSB) m_minRSB = gRSB;
    if (glyf.advanceWidth != null) {
      m_xAvgSum += gAdvW;
      m_glyfNotEmpty++;
    }
    glyf.xMin = gXMin;
    glyf.xMax = gXMax;
    glyf.yMin = gYMin;
    glyf.yMax = gYMax;
    glyf.leftSideBearing = gLSB;
    glyf.advanceWidth = gAdvW;
  }

  /* 优化112: 标记 unicode 已排序且已检查重复，resolveTTF 可跳过 */
  ttf._unicodeSorted = true;

  /* 优化120: 存储 OS2/head/hhea 预计算 metrics */
  ttf._metrics = {
    xMin: m_xMin, yMin: m_yMin, xMax: m_xMax, yMax: m_yMax,
    advanceWidthMax: m_advWMax,
    minLeftSideBearing: m_minLSB,
    minRightSideBearing: m_minRSB,
    xMaxExtent: m_xMax,
    xAvgCharWidth: m_xAvgSum / (m_glyfNotEmpty || 1),
    usFirstCharIndex: m_firstChar,
    usLastCharIndex: m_lastChar,
    maxPoints: m_maxPoints,
    maxContours: m_maxContours,
    glyfNotEmpty: m_glyfNotEmpty
  };

  /* 原逻辑会删除「无轮廓字形」（_numContours === 0），但这会误删两类必须保留的字形：
   *  (1) space（U+0020）等空白字符——无轮廓但 cmap 引用，删除后该码点渲染为 .notdef；
   *  (2) GSUB 连字的 spacer/seq target（如 FiraCode 的 equal.spacer）——无轮廓的占位字形，
   *      是 GSUB ChainedContext 替换的目标，删除后连字规则 target gid 失效，连字不渲染。
   *  无轮廓字形在 OpenType 中合法（.notdef 即常见无轮廓字形），保留它们仅增加极小体积，
   *  因此这里不再按轮廓数过滤，保留全部字形，glyf 顺序与 subsetGids 保持一一对应，
   *  使调用方（rewriteLayoutTablesForSubset）的 原gid→新gid 映射稳定可靠。 */
  if (!hasCompound) {
    if (ttf.support && ttf.support.maxp) {
      ttf.support.maxp.numGlyphs = glyfs.length;
    }
  }
  if (!repeatList.length) {
    return true;
  }
  return {
    repeat: repeatList
  };
}
