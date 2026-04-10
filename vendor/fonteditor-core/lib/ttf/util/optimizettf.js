"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = optimizettf;
exports.ceilReduceAndSizeFlat = ceilReduceAndSizeFlat;
var _reduceGlyf = _interopRequireDefault(require("./reduceGlyf"));
var _glyFlag = _interopRequireDefault(require("../enum/glyFlag"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
/**
 * @file 对ttf对象进行优化，查找错误，去除冗余点
 * @author mengke01(kekee000@gmail.com)
 */

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

  var ONCURVE = _glyFlag.default.ONCURVE;
  var XSHORT = _glyFlag.default.XSHORT;
  var YSHORT = _glyFlag.default.YSHORT;
  var XSAME = _glyFlag.default.XSAME;
  var YSAME = _glyFlag.default.YSAME;
  var REPEAT = _glyFlag.default.REPEAT;

  var numPoints = xArr.length;
  var flagsC = new Array(numPoints);
  var fi = 0;
  var prevX = 0, prevY = 0;
  var isFirst = true;
  var prevFlag = -1;
  var repeatPoint = -1;
  var encodedCoordSize = 0;

  /* 每个字形独立分配 buffer */
  var neededSize = numPoints * 2;
  var xCoordBuf = new Uint8Array(neededSize);
  var yCoordBuf = new Uint8Array(neededSize);
  var xbi = 0, ybi = 0;

  for (var pi = 0; pi < numPoints; pi++) {
    var px = xArr[pi];
    var py = yArr[pi];
    var onCurve = !!(flagsArr[pi] & ONCURVE);

    var dx, dy;
    var flag = onCurve ? ONCURVE : 0;
    if (isFirst) {
      dx = px; dy = py; isFirst = false;
    } else {
      dx = px - prevX; dy = py - prevY;
    }
    prevX = px;
    prevY = py;

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

    if (flag === prevFlag && !isFirst) {
      if (repeatPoint === -1) {
        repeatPoint = fi - 1;
        flagsC[repeatPoint] |= REPEAT;
        flagsC[fi++] = 1;
      } else {
        ++flagsC[repeatPoint + 1];
      }
    } else {
      repeatPoint = -1;
      flagsC[fi++] = flag;
      prevFlag = flag;
    }
  }

  flagsC.length = fi;

  /* 优化103: 不构建 contour 数组，直接存储元数据 */
  glyf.contours = new Array(numContours);
  glyf._flatContours = true;
  /* 优化103: 存储每个 contour 的点数，供 write 计算 endPtsOfContours */
  glyf._pointsPerContour = new Array(numContours);
  for (var ci = 0; ci < numContours; ci++) {
    glyf._pointsPerContour[ci] = (ci === 0 ? endPts[0] + 1 : endPts[ci] - endPts[ci - 1]);
  }
  glyf._numContours = numContours;
  glyf._totalPoints = numPoints;

  glyf._precomputedGlyfSupport = {
    flags: flagsC,
    encodedCoordSize: encodedCoordSize,
    xBuf: xCoordBuf,
    xLen: xbi,
    yBuf: yCoordBuf,
    yLen: ybi
  };

  delete glyf._xArr;
  delete glyf._yArr;
  delete glyf._flags;
  delete glyf.endPtsOfContours;
}

/**
 * 优化84+98+149: 合并 ceil+reduce+flagsAndSize 为单次遍历
 */
function ceilReduceAndSizeFlat(glyf) {
  var contours = glyf.contours;
  /* 优化91+164: 跳过 reducePathFlat，用 write-index 替代 splice */
  var writeIdx = 0;
  for (var j = 0, cl = contours.length; j < cl; j++) {
    if (contours[j].length > 6) {
      contours[writeIdx++] = contours[j];
    }
  }
  contours.length = writeIdx;
  if (0 === contours.length) {
    delete glyf.contours;
    return;
  }

  if (glyf._precomputedGlyfSupport) {
    return;
  }

  var ONCURVE = _glyFlag.default.ONCURVE;
  var XSHORT = _glyFlag.default.XSHORT;
  var YSHORT = _glyFlag.default.YSHORT;
  var XSAME = _glyFlag.default.XSAME;
  var YSAME = _glyFlag.default.YSAME;
  var REPEAT = _glyFlag.default.REPEAT;

  var totalPoints = 0;
  for (var j = 0, cl = contours.length; j < cl; j++) {
    totalPoints += contours[j].length / 3;
  }
  var flagsC = new Array(totalPoints);
  var fi = 0;
  var prevX = 0, prevY = 0;
  var isFirst = true;
  var prevFlag = -1;
  var repeatPoint = -1;
  var encodedCoordSize = 0;

  /* 每个字形独立分配 buffer */
  var neededSize = totalPoints * 2;
  var xCoordBuf = new Uint8Array(neededSize);
  var yCoordBuf = new Uint8Array(neededSize);
  var xbi = 0, ybi = 0;

  for (var j = 0, cl2 = contours.length; j < cl2; j++) {
    var contour = contours[j];
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

      if (flag === prevFlag && !isFirst) {
        if (repeatPoint === -1) {
          repeatPoint = fi - 1;
          flagsC[repeatPoint] |= REPEAT;
          flagsC[fi++] = 1;
        } else {
          ++flagsC[repeatPoint + 1];
        }
      } else {
        repeatPoint = -1;
        flagsC[fi++] = flag;
        prevFlag = flag;
      }
    }
  }

  flagsC.length = fi;

  glyf._precomputedGlyfSupport = {
    flags: flagsC,
    encodedCoordSize: encodedCoordSize,
    xBuf: xCoordBuf,
    xLen: xbi,
    yBuf: yCoordBuf,
    yLen: ybi
  };
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

  /* 优化120+cmap: 在主循环中同时构建预排序的 cmap unicode/id 数组 */
  var cmapUnicodeArr = [];
  var cmapIdArr = [];
  var cmapCount = 0;

  for (var index = 0, gl = glyfs.length; index < gl; index++) {
    var glyf = glyfs[index];
    if (glyf.compound) {
      hasCompound = true;
    }
    if (glyf.unicode) {
      if (glyf.unicode.length > 1) {
        glyf.unicode.sort(function (a, b) { return a - b; });
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
           * 这是 OTF→TTF 转换字形的必经路径（_flatContours 由 parseCFFGlyph 生成），
           * 之前已因为同样的问题修复过对象 contours 路径（commit 97f4d72），
           * 所有涉及 contours 的分支都必须更新这两个值！
           * 注意：ceilReduceAndSizeFlat 可能删除 glyf.contours（当所有 contour 长度 ≤ 6 时），
           * 所以必须在调用之后检查 glyf.contours 是否仍存在。
           */
          if (glyf.contours) {
            var flatNumC = glyf.contours.length;
            if (flatNumC > 0) {
              if (flatNumC > m_maxContours) m_maxContours = flatNumC;
              var flatTotalPts = 0;
              for (var fci = 0; fci < flatNumC; fci++) {
                flatTotalPts += glyf.contours[fci].length / 3;
              }
              if (flatTotalPts > m_maxPoints) m_maxPoints = flatTotalPts;
            }
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

  /* 优化99+103: hasCompound 已在主循环中追踪，过滤使用 _numContours 或 contours.length */
  if (!hasCompound) {
    /* 优化：glyf 过滤时同步重映射 cmap 索引，防止 format12 startId 超出 numGlyphs */
    var filtered = [glyfs[0]];
    var indexMap = [0];
    for (var gi = 1; gi < gl; gi++) {
      var g = glyfs[gi];
      if (g._numContours != null ? g._numContours > 0 : (g.contours && g.contours.length)) {
        indexMap[gi] = filtered.length;
        filtered.push(g);
      }
    }
    ttf.glyf = filtered;
    if (ttf._cmapSortedIdArr) {
      var cmapIdArr = ttf._cmapSortedIdArr;
      for (var ci = 0, cl = cmapIdArr.length; ci < cl; ci++) {
        var oldIdx = cmapIdArr[ci];
        if (oldIdx > 0) {
          var newIdx = indexMap[oldIdx];
          if (newIdx !== undefined) { cmapIdArr[ci] = newIdx; }
        }
      }
    }
    if (ttf.support && ttf.support.maxp) {
      ttf.support.maxp.numGlyphs = filtered.length;
    }
  }
  if (!repeatList.length) {
    return true;
  }
  return {
    repeat: repeatList
  };
}
