/**
 * @file 对 ttf 对象进行优化，查找错误，去除冗余点（TS 版，自 optimizettf.js 重写）
 * @author mengke01(kekee000@gmail.com)
 */
import reduceGlyf from "./reduceGlyf";
import glyFlag from "../enum/glyFlag";

/** 轮廓：对象格式为连续 [x, y, onCurve] 三元组的扁平数组 */
type TripletContour = number[];

/** 预编码阶段的鸭子类型轮廓（仅提供 length，供 sizeof/write 识别为"有内容"的字形） */
interface DuckContour {
  length: number;
}

/** glyf 记录（optimizettf 视角的最小字段集，其余字段由 parse/write 侧动态使用） */
interface GlyfRecord {
  /** 是否复合字形 */
  compound?: boolean;
  /** 映射的 unicode 码点列表 */
  unicode?: number[];
  /** 轮廓数组；预编码后为鸭子类型，空字形为 null */
  contours?: TripletContour[] | DuckContour | null;
  /** 轮廓是否为扁平三元组格式 */
  _flatContours?: boolean;
  /** parse 阶段缓存的原始字节（简单字形快路径，非空表示跳过坐标解析） */
  _origBuf?: Uint8Array | null;
  /** parse 阶段的 x 坐标数组（optimizettf 消费后置 null） */
  _xArr?: ArrayLike<number> | null;
  /** parse 阶段的 y 坐标数组（消费后置 null） */
  _yArr?: ArrayLike<number> | null;
  /** parse 阶段的 flag 数组（消费后置 null） */
  _flags?: Uint8Array | null;
  /** 每个 contour 的末端点索引（消费后置 null） */
  endPtsOfContours?: number[] | null;
  /** 预计算的 flag 序列（含 REPEAT 编码） */
  _preFlags?: Uint8Array;
  /** 预编码坐标字节总数 */
  _preEncodedCoordSize?: number;
  /** 预编码 x 坐标字节 */
  _preXBuf?: Uint8Array;
  /** 预编码 y 坐标字节 */
  _preYBuf?: Uint8Array;
  /** 每个 contour 的点数缓存 */
  _pointsPerContour?: number[];
  /** contour 数量缓存 */
  _numContours?: number;
  /** 总点数缓存 */
  _totalPoints?: number;
  /** 是否已预计算（写入方据此跳过重复预计算） */
  _precomputedGlyfSupport?: boolean;
  /** 水平最小 x */
  xMin?: number;
  /** 垂直最小 y */
  yMin?: number;
  /** 水平最大 x */
  xMax?: number;
  /** 垂直最大 y */
  yMax?: number;
  /** 左侧承载量 */
  leftSideBearing?: number;
  /** 前进宽度 */
  advanceWidth?: number;
}

/** OS2/head/hhea 预计算 metrics（优化120，消除各表的全 glyf 重复遍历） */
interface TtfMetrics {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  advanceWidthMax: number;
  minLeftSideBearing: number;
  minRightSideBearing: number;
  xMaxExtent: number;
  xAvgCharWidth: number;
  usFirstCharIndex: number;
  usLastCharIndex: number;
  maxPoints: number;
  maxContours: number;
  glyfNotEmpty: number;
}

/** ttf 对象（optimizettf 视角的最小字段集） */
interface TtfRecord {
  /** 字形记录数组 */
  glyf: GlyfRecord[];
  /** 优化112: unicode 已排序且已查重，resolveTTF 据此跳过 */
  _unicodeSorted?: boolean;
  /** 预计算 metrics */
  _metrics?: TtfMetrics;
  /** 表支持对象 */
  support?: { maxp?: { numGlyphs?: number } } | null;
}

/** 枚举常量提升到模块级别，消除每个 glyph 调用时的属性查找 */
const ONCURVE = glyFlag.ONCURVE;
const XSHORT = glyFlag.XSHORT;
const YSHORT = glyFlag.YSHORT;
const XSAME = glyFlag.XSAME;
const YSAME = glyFlag.YSAME;
const REPEAT = glyFlag.REPEAT;

/** 模块级排序函数，避免每个 glyph 创建闭包 */
function numericSort(a: number, b: number): number {
  return a - b;
}

/**
 * 优化103+116: 从 parse 阶段的 TypedArray 直接计算 precomputed 数据，跳过 contour 数组构建
 * 每个字形独立分配 buffer，避免共享 buffer 的复杂性
 */
function ceilReduceAndSizeFromTypedArrays(glyf: GlyfRecord): void {
  const xArr = glyf._xArr!;
  const yArr = glyf._yArr!;
  const flagsArr = glyf._flags!;
  const endPts = glyf.endPtsOfContours!;
  const numContours = endPts.length;

  const numPoints = xArr.length;
  let flagsC = new Uint8Array(numPoints);
  let fi = 0;
  let prevFlag = -1;
  let repeatPoint = -1;
  let encodedCoordSize = 0;

  /* 每个字形独立分配 buffer */
  const neededSize = numPoints * 2;
  const xCoordBuf = new Uint8Array(neededSize);
  const yCoordBuf = new Uint8Array(neededSize);
  let xbi = 0, ybi = 0;

  /** 优化: 首点提取到循环外，消除 isFirst 条件分支 */
  if (numPoints > 0) {
    let px = xArr[0], py = yArr[0];
    let onCurve = !!(flagsArr[0] & ONCURVE);
    let flag = onCurve ? ONCURVE : 0;
    if (px === 0) flag += XSAME;
    else if (px > -256 && px < 256) { flag += XSHORT; if (px > 0) flag += XSAME; xCoordBuf[xbi++] = px > 0 ? px : -px; encodedCoordSize += 1; }
    else { xCoordBuf[xbi++] = (px >> 8) & 0xFF; xCoordBuf[xbi++] = px & 0xFF; encodedCoordSize += 2; }
    if (py === 0) flag += YSAME;
    else if (py > -256 && py < 256) { flag += YSHORT; if (py > 0) flag += YSAME; yCoordBuf[ybi++] = py > 0 ? py : -py; encodedCoordSize += 1; }
    else { yCoordBuf[ybi++] = (py >> 8) & 0xFF; yCoordBuf[ybi++] = py & 0xFF; encodedCoordSize += 2; }
    flagsC[fi++] = prevFlag = flag;
    let prevX = px, prevY = py;

    for (let pi = 1; pi < numPoints; pi++) {
      px = xArr[pi]; py = yArr[pi];
      onCurve = !!(flagsArr[pi] & ONCURVE);
      flag = onCurve ? ONCURVE : 0;
      const dx = px - prevX, dy = py - prevY;
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
  for (let ci = 0; ci < numContours; ci++) {
    glyf._pointsPerContour[ci] = (ci === 0 ? endPts[0] + 1 : endPts[ci] - endPts[ci - 1]);
  }
  glyf._numContours = numContours;
  glyf._totalPoints = numPoints;

  /** 优化256: 在写入方直接 trim subarray，消除 sizeof.js 二次 slicing */
  glyf._preFlags = flagsC;
  glyf._preEncodedCoordSize = encodedCoordSize;
  glyf._preXBuf = xCoordBuf.subarray(0, xbi);
  glyf._preYBuf = yCoordBuf.subarray(0, ybi);

  /** 优化308: _xArr/_yArr/_flags 都是 parse 阶段产物，optimizettf 消费后全部清空释放内存。
   *  原 _xArr/_flags 已置 null，_yArr 漏置（悬挂内存，其唯一消费者 transformGlyfContours
   *  在 optimize 后因 _xArr=null 守卫进不去，实际无读取点）。_preXLen/_preYLen 是 dead write（全库零读取点，subarray.length 已携带长度），删除。 */
  glyf._xArr = null;
  glyf._yArr = null;
  glyf._flags = null;
  glyf.endPtsOfContours = null;
}

/**
 * 优化84+98+149: 合并 ceil+reduce+flagsAndSize 为单次遍历
 * 优化256: 写入方直接 trim subarray，消除 sizeof.js 二次 slicing
 */
function ceilReduceAndSizeFlat(glyf: GlyfRecord): void {
  /** 优化279: _precomputedGlyfSupport 守卫提前，避免已缓存 glyph 的无效 contour 过滤 */
  if (glyf._precomputedGlyfSupport) {
    return;
  }

  const rawContours = glyf.contours;
  if (!Array.isArray(rawContours)) {
    throw new Error("ceilReduceAndSizeFlat: contours 必须为扁平三元组数组");
  }
  const contours: TripletContour[] = rawContours;

  /* 优化279: 合并 contour 过滤和 totalPoints 计算 + _pointsPerContour 缓存为单次遍历 */
  let writeIdx = 0;
  let totalPoints = 0;
  const ppcArr = new Array<number>(contours.length);
  for (let j = 0, cl = contours.length; j < cl; j++) {
    if (contours[j].length > 6) {
      const pts = contours[j].length / 3 | 0;
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

  const flagsC = new Uint8Array(totalPoints);
  let fi = 0;
  let prevFlag = -1;
  let repeatPoint = -1;
  let encodedCoordSize = 0;

  /* 每个字形独立分配 buffer */
  const neededSize = totalPoints * 2;
  const xCoordBuf = new Uint8Array(neededSize);
  const yCoordBuf = new Uint8Array(neededSize);
  let xbi = 0, ybi = 0;

  /** 优化213: 首点提取到循环外，消除 per-point 条件分支 */
  const firstContour = contours[0];
  const fpx = firstContour[0], fpy = firstContour[1];
  const fOnCurve = firstContour[2];
  let fFlag = fOnCurve ? ONCURVE : 0;
  if (fpx === 0) fFlag += XSAME;
  else if (fpx > -256 && fpx < 256) { fFlag += XSHORT; if (fpx > 0) fFlag += XSAME; xCoordBuf[xbi++] = fpx > 0 ? fpx : -fpx; encodedCoordSize += 1; }
  else { xCoordBuf[xbi++] = (fpx >> 8) & 0xFF; xCoordBuf[xbi++] = fpx & 0xFF; encodedCoordSize += 2; }
  if (fpy === 0) fFlag += YSAME;
  else if (fpy > -256 && fpy < 256) { fFlag += YSHORT; if (fpy > 0) fFlag += YSAME; yCoordBuf[ybi++] = fpy > 0 ? fpy : -fpy; encodedCoordSize += 1; }
  else { yCoordBuf[ybi++] = (fpy >> 8) & 0xFF; yCoordBuf[ybi++] = fpy & 0xFF; encodedCoordSize += 2; }
  flagsC[fi++] = prevFlag = fFlag;
  let prevX = fpx, prevY = fpy;

  /** 优化213+262: 首点提取到循环外，第一个 contour 从 i=3 开始跳过首点，消除 per-point skipFirst 分支 */
  let skipFirstContour = true;
  for (let j = 0, cl2 = contours.length; j < cl2; j++) {
    const contour = contours[j];
    const startI = skipFirstContour ? 3 : 0;
    skipFirstContour = false;
    for (let i = startI, l = contour.length; i < l; i += 3) {
      const px = contour[i];
      const py = contour[i + 1];
      const onCurve = contour[i + 2];
      let flag = onCurve ? ONCURVE : 0;
      const dx = px - prevX, dy = py - prevY;
      prevX = px; prevY = py;

      if (dx === 0) {
        flag += XSAME;
      } else if (dx > -256 && dx < 256) {
        flag += XSHORT;
        if (dx > 0) flag += XSAME;
        const absDx = dx > 0 ? dx : -dx;
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
        const absDy = dy > 0 ? dy : -dy;
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

  /** 优化256: 在写入方直接 trim subarray，消除 sizeof.js 二次 slicing */
  glyf._preFlags = flagsC.subarray(0, fi);
  glyf._preEncodedCoordSize = encodedCoordSize;
  glyf._preXBuf = xCoordBuf.subarray(0, xbi);
  glyf._preYBuf = yCoordBuf.subarray(0, ybi);
  glyf._totalPoints = totalPoints;
  glyf._numContours = contours.length;
}

/**
 * 优化99+103+112+120: 单次遍历优化所有字形，同时预计算 OS2/head/hhea metrics
 */
function optimizettf(ttf: TtfRecord): true | { repeat: number[] } {
  const checkUnicodeRepeat: Record<number, boolean> = {};
  const repeatList: number[] = [];
  const glyfs = ttf.glyf;
  let hasCompound = false;

  /* 优化120: 在主循环中同时计算 OS2/head/hhea metrics，消除 OS2.size() 的全 glyf 遍历 */
  let m_xMin = 16384, m_yMin = 16384, m_xMax = -16384, m_yMax = -16384;
  let m_advWMax = -1;
  let m_minLSB = 16384, m_minRSB = 16384;
  let m_xAvgSum = 0, m_glyfNotEmpty = 0;
  let m_firstChar = 0x10FFFF, m_lastChar = -1;
  let m_maxPoints = 0, m_maxContours = 0;

  for (let index = 0, gl = glyfs.length; index < gl; index++) {
    const glyf = glyfs[index];
    if (glyf.compound) {
      hasCompound = true;
    }
    if (glyf.unicode) {
      if (glyf.unicode.length > 1) {
        glyf.unicode.sort(numericSort);
      }
      for (const u of glyf.unicode) {
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
      /**
       * 优化310: simple 字形原始字节快路径。
       * 有 _origBuf 的字形已跳过坐标解析，_numContours/_totalPoints 已在 parse 阶段算好，
       * 这里只收集 metrics（maxContours/maxPoints），跳过 ceilReduceAndSizeFromTypedArrays。
       * contours 设为鸭子类型 {length}，供 sizeof/write 识别为"有内容"的字形。
       */
      if (glyf._origBuf) {
        if (glyf._numContours! > 0) {
          glyf.contours = { length: glyf._numContours! };
          if (glyf._numContours! > m_maxContours) m_maxContours = glyf._numContours!;
          if (glyf._totalPoints! > m_maxPoints) m_maxPoints = glyf._totalPoints!;
        }
      } else if (glyf._xArr) {
        ceilReduceAndSizeFromTypedArrays(glyf);
        /* 优化120: 从 _numContours/_totalPoints 收集 metrics */
        if (glyf._numContours! > 0) {
          if (glyf._numContours! > m_maxContours) m_maxContours = glyf._numContours!;
          if (glyf._totalPoints! > m_maxPoints) m_maxPoints = glyf._totalPoints!;
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
            if (glyf._numContours! > m_maxContours) m_maxContours = glyf._numContours!;
            if (glyf._totalPoints! > m_maxPoints) m_maxPoints = glyf._totalPoints!;
          }
        } else if (Array.isArray(glyf.contours)) {
          /* 对象 contours 格式也需要收集 maxPoints/maxContours */
          const contours = glyf.contours;
          const numC = contours.length;
          if (numC > 0) {
            if (numC > m_maxContours) m_maxContours = numC;
            let totalPts = 0;
            for (let ci = 0; ci < numC; ci++) {
              totalPts += contours[ci].length;
            }
            if (totalPts > m_maxPoints) m_maxPoints = totalPts;
          }
          /* 优化153: pathCeil 已在 transformContour 中完成，无需重复调用 */
          reduceGlyf(glyf);
        }
      }
    }

    /* 优化120: 收集 metrics（跳过 Math.round，值已经是整数） */
    const gXMin = glyf.xMin || 0;
    const gYMin = glyf.yMin || 0;
    const gXMax = glyf.xMax || 0;
    const gYMax = glyf.yMax || 0;
    if (gXMin < m_xMin) m_xMin = gXMin;
    if (gYMin < m_yMin) m_yMin = gYMin;
    if (gXMax > m_xMax) m_xMax = gXMax;
    if (gYMax > m_yMax) m_yMax = gYMax;
    const gAdvW = glyf.advanceWidth || 0;
    if (gAdvW > m_advWMax) m_advWMax = gAdvW;
    const gLSB = glyf.leftSideBearing || 0;
    if (gLSB < m_minLSB) m_minLSB = gLSB;
    /* 优化120: 同时计算 minRightSideBearing = advanceWidth - xMax */
    const gRSB = gAdvW - gXMax;
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

export default optimizettf;
export { ceilReduceAndSizeFlat };
export type { GlyfRecord, TtfMetrics, TtfRecord };
