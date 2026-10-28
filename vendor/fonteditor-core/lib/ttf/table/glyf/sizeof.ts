/**
 * @file 获取glyf的大小，同时对glyf写入进行预处理
 * @author mengke01(kekee000@gmail.com)
 */
import glyFlag from "../../enum/glyFlag";

/** 每个字形的写支撑数据（由 sizeof 阶段预编码，write 阶段消费） */
interface GlyfSupport {
  /** 字形数据字节长度（用于 4 字节对齐） */
  glyfSize?: number;
  /** 对齐后的字形数据长度 */
  size?: number;
  /** 预编码的 flags 字节 */
  flags?: Uint8Array;
  /** 预编码的 x 坐标字节 */
  xEncoded?: Uint8Array;
  /** 未预编码的 x 坐标数组 */
  xCoord?: number[];
  /** 预编码的 y 坐标字节 */
  yEncoded?: Uint8Array;
  /** 未预编码的 y 坐标数组 */
  yCoord?: number[];
}

/** 复合字形 component（sizeof 只消费 transform） */
interface SizeofComponent {
  /** 仿射变换矩阵与平移 */
  transform: {
    /** a 分量（x 缩放） */
    a: number;
    /** b 分量 */
    b: number;
    /** c 分量 */
    c: number;
    /** d 分量（y 缩放） */
    d: number;
    /** 平移 e */
    e: number;
    /** 平移 f */
    f: number;
  };
}

/** glyf 数组单项（sizeof 视角的最小字段集） */
interface SizeofGlyfEntry {
  /** 是否复合字形 */
  compound?: boolean;
  /**
   * 轮廓数组：扁平三元组格式为连续 [x, y, onCurve]，对象格式为点对象数组（legacy），
   * optimizettf 预编码后可为鸭子类型 { length }（此时必有 _preFlags 走预编码快路径）
   */
  contours?: any;
  /** contours 是否为坐标扁平存储（每 3 个数一个点） */
  _flatContours?: boolean;
  /** 预解析的轮廓数（快路径，避免 contours 展开） */
  _numContours?: number;
  /** 原始 glyf 字节所在缓冲（simple 字形快路径） */
  _origBuf?: ArrayBuffer | Uint8Array;
  /** 原始 glyf 字节长度 */
  _origLen?: number;
  /** instructionLength 字段相对 view 的绝对偏移（-1 表示无 instructions） */
  _instrOff?: number;
  /** instructions 字节数 */
  _instrLen?: number;
  /** instructions（hinting 开启时计入大小） */
  instructions?: Uint8Array | number[];
  /** 预计算的 flag 序列（含 REPEAT 编码） */
  _preFlags?: Uint8Array;
  /** 预编码 x 坐标字节 */
  _preXBuf?: Uint8Array;
  /** 预编码 y 坐标字节 */
  _preYBuf?: Uint8Array;
  /** 预编码坐标字节总数 */
  _preEncodedCoordSize?: number;
  /** 预编码产物字段（外部注入的支撑对象形态） */
  flags?: Uint8Array;
  /** 预编码 x 坐标字节（支撑对象形态） */
  xBuf?: Uint8Array;
  /** 预编码 y 坐标字节（支撑对象形态） */
  yBuf?: Uint8Array;
  /** 预编码坐标字节总数（支撑对象形态） */
  encodedCoordSize?: number;
  /** 未预编码的 x 坐标数组 */
  xCoord?: number[];
  /** 未预编码的 y 坐标数组 */
  yCoord?: number[];
  /** 是否已预编码（支撑对象引用；未被赋值过） */
  _precomputedGlyfSupport?: SizeofGlyfEntry | null;
  /** 复合字形的 component 列表 */
  glyfs?: SizeofComponent[];
}

/** sizeof 阶段的 ttf 上下文最小结构 */
interface GlyfSizeofTtf {
  /** 字形数组 */
  glyf: SizeofGlyfEntry[];
  /** 各表支撑数据（sizeof 预填充 glyf 支撑数组） */
  support: {
    /** glyf 支撑数据（与 glyf 数组同下标） */
    glyf: GlyfSupport[];
  };
  /** head 表（写 indexToLocFormat） */
  head: {
    /** loca 格式：0=短索引 1=长索引 */
    indexToLocFormat: number;
  };
  /** 写选项 */
  writeOptions?: {
    /** 是否保留 hinting */
    hinting?: boolean;
    /** 是否写空轮廓字形的数据 */
    writeZeroContoursGlyfData?: boolean;
  } | null;
}

/** 优化279: 枚举常量提升到模块级别，消除每个 glyph 调用时的属性查找 */
const _ONCURVE = glyFlag.ONCURVE;
const _XSHORT = glyFlag.XSHORT;
const _YSHORT = glyFlag.YSHORT;
const _XSAME = glyFlag.XSAME;
const _YSAME = glyFlag.YSAME;
const _REPEAT = glyFlag.REPEAT;

/**
 * 优化33+38+39+40+48+49+57+66: getFlagsAndSize 单遍扫描替代两遍扫描，支持扁平 contours
 */
function getFlagsAndSize(glyf: SizeofGlyfEntry, glyfSupport: GlyfSupport, hinting: boolean | undefined): number {
  if (!glyf.contours || glyf.contours.length === 0) {
    /* writeZeroContoursGlyfData 开启时零轮廓字形写出 12B（header 10 + instructionLength 2），
     * 与 write 侧 else 编码路径对齐（无 endPts、instrLen=0、空 flags/coords） */
    return 12;
  }

  /* 优化84+98+103+223: 直接复用 optimize 阶段预计算的 flags/encodedCoordSize + 预编码 buffer */
  const pre = glyf._precomputedGlyfSupport || (glyf._preFlags ? glyf : null);
  if (pre) {
    glyfSupport.flags = pre.flags || pre._preFlags;
    /* 优化256: buffer 已在写入方 trim，直接使用，消除二次 subarray slicing */
    const pxBuf = pre.xBuf || pre._preXBuf;
    if (pxBuf) {
      glyfSupport.xEncoded = pxBuf;
      glyfSupport.yEncoded = pre.yBuf || pre._preYBuf;
    } else {
      glyfSupport.xCoord = pre.xCoord;
      glyfSupport.yCoord = pre.yCoord;
    }
    glyf._precomputedGlyfSupport = null;
    const instructionSize = (hinting && glyf.instructions) ? glyf.instructions.length : 0;
    /* 优化103: 优先使用 _numContours */
    const nc = glyf._numContours != null ? glyf._numContours : glyf.contours.length;
    const encSz = pre.encodedCoordSize || pre._preEncodedCoordSize || 0;
    return 12 + nc * 2 + glyfSupport.flags!.length + encSz + instructionSize;
  }

  const ONCURVE = _ONCURVE;
  const XSHORT = _XSHORT;
  const YSHORT = _YSHORT;
  const XSAME = _XSAME;
  const YSAME = _YSAME;
  const REPEAT = _REPEAT;

  const contours = glyf.contours;
  const isFlat = glyf._flatContours;

  /** 预计算总点数，一次性分配 TypedArray */
  let totalPts = 0;
  for (let tc = 0, tcl = contours.length; tc < tcl; tc++) {
    totalPts += isFlat ? contours[tc].length / 3 | 0 : contours[tc].length;
  }

  let flagsC = new Uint8Array(totalPts);
  const xCoordBuf = new Uint8Array(totalPts * 2);
  const yCoordBuf = new Uint8Array(totalPts * 2);
  let xbi = 0, ybi = 0;
  let prevX = 0, prevY = 0;
  let prevFlag = -1;
  let repeatPoint = -1;
  let fi = 0;

  let encodedCoordSize = 0;

  /** 优化: isFirst 提取到循环外，消除每个点的条件分支 */
  let started = false;

  for (let j = 0, cl = contours.length; j < cl; j++) {
    const contour = contours[j];
    /** 优化293: 统一 isFlat 和非 isFlat 的编码循环，消除 60 行重复代码 */
    let step, cLen;
    if (isFlat) {
      step = 3; cLen = contour.length;
    } else {
      step = 1; cLen = contour.length;
    }
    for (let i = 0; i < cLen; i += step) {
      let px, py, onCurve;
      if (isFlat) {
        px = contour[i]; py = contour[i + 1]; onCurve = contour[i + 2];
      } else {
        px = contour[i].x; py = contour[i].y; onCurve = contour[i].onCurve;
      }
      let flag = onCurve ? ONCURVE : 0;
      let dx, dy;

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

  const instructionSize = (hinting && glyf.instructions) ? glyf.instructions.length : 0;
  return 12 + contours.length * 2 + flagsC.length + encodedCoordSize + instructionSize;
}

/**
 * 优化48: sizeofCompound forEach → for 循环
 */
function sizeofCompound(glyf: SizeofGlyfEntry): number {
  let size = 10;
  const glyfs = glyf.glyfs!;
  for (let i = 0, l = glyfs.length; i < l; i++) {
    /** 优化212: 解构 transform 属性，消除重复属性查找 */
    const transform = glyfs[i].transform;
    const e = transform.e, f = transform.f;
    const a = transform.a, b = transform.b, c = transform.c, d = transform.d;
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

/** 优化262: 空 glyph 预分配单例，避免每个空 glyph 创建新对象 */
const EMPTY_GLYF_SUPPORT: GlyfSupport = { glyfSize: 0, size: 0 };

/**
 * 优化49: sizeof glyf.forEach → for 循环
 */
function sizeof(ttf: GlyfSizeofTtf): number {
  const glyfs = ttf.glyf;
  const glyfSupportArr = new Array<GlyfSupport>(glyfs.length);
  ttf.support.glyf = glyfSupportArr;
  let tableSize = 0;
  const opts = ttf.writeOptions || {};
  const hinting = opts.hinting;
  const writeZeroContoursGlyfData = opts.writeZeroContoursGlyfData;

  for (let i = 0, gl = glyfs.length; i < gl; i++) {
    const glyf = glyfs[i];
    let glyfSupport: GlyfSupport;
    let glyfSize;
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
      glyfSize = glyf._origLen! - (!hinting && glyf._instrOff! >= 0 ? glyf._instrLen! : 0);
    } else {
      glyfSupport = {};
      glyfSize = getFlagsAndSize(glyf, glyfSupport, hinting);
    }

    const size = (glyfSize + 3) & ~3;
    glyfSupport.glyfSize = glyfSize;
    glyfSupport.size = size;
    glyfSupportArr[i] = glyfSupport;
    tableSize += size;
  }
  ttf.head.indexToLocFormat = tableSize > 65536 ? 1 : 0;
  return tableSize;
}

export default sizeof;
export { sizeof };
