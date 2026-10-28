/**
 * @file 写glyf数据
 * @author mengke01(kekee000@gmail.com)
 */

import componentFlag from "../../enum/componentFlag";

/** 复合字形 component 的变换矩阵与定位描述 */
interface GlyfComponentTransform {
  /** a 分量（缩放/斜切） */
  a: number;
  /** b 分量（旋转/斜切） */
  b: number;
  /** c 分量（旋转/斜切） */
  c: number;
  /** d 分量（缩放/斜切） */
  d: number;
  /** 平移 e（无 points 时使用） */
  e: number;
  /** 平移 f（无 points 时使用） */
  f: number;
}

/** 复合字形的单个 component 描述 */
interface GlyfComponent {
  /** 被引用的 component glyph id */
  glyphIndex: number;
  /** 变换矩阵与平移 */
  transform: GlyfComponentTransform;
  /** 覆盖点位（存在时 args 为 points 匹配模式，否则为 xy 值模式） */
  points?: number[];
  /** 是否使用 my metrics 标记 */
  useMyMetrics?: boolean;
  /** 是否 overlap compound 标记 */
  overlapCompound?: boolean;
}

/** glyf 数组单项：simple 字形轮廓数据或复合字形，以及优化快路径的原始字节引用 */
interface GlyfEntry {
  /** 是否复合字形 */
  compound?: boolean;
  /** 轮廓数组（simple 字形）；扁平模式下每项为坐标平铺数组，否则每项为点数组 */
  contours?: number[][];
  /** 包围盒 */
  xMin?: number;
  /** 包围盒 */
  yMin?: number;
  /** 包围盒 */
  xMax?: number;
  /** 包围盒 */
  yMax?: number;
  /** 复合字形的 component 列表 */
  glyfs?: GlyfComponent[];
  /** instructions（hinting 开启时写入） */
  instructions?: Uint8Array | number[];
  /** 每个轮廓的点数（优化快路径，优先于 contours 推导 endPts） */
  _pointsPerContour?: number[];
  /** contours 是否为坐标扁平存储（每 3 个数一个点） */
  _flatContours?: boolean;
  /** 预解析的轮廓数（快路径，避免 contours 展开） */
  _numContours?: number;
  /** 原始 glyf 字节所在缓冲（快路径） */
  _origBuf?: ArrayBuffer;
  /** 原始 glyf 字节在 _origBuf 中的偏移 */
  _origOff?: number;
  /** 原始 glyf 字节长度 */
  _origLen?: number;
  /** instructionLength 字段相对 view 的绝对偏移（-1 表示无 instructions） */
  _instrOff?: number;
  /** instructions 字节数 */
  _instrLen?: number;
}

/** 每个字形的写支撑数据（由 support 阶段预编码） */
interface GlyfSupport {
  /** 字形数据字节长度（用于 4 字节对齐） */
  glyfSize: number;
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

/** 写入器最小结构接口（lib/ttf/writer 的 Writer 实例满足此结构） */
interface GlyfWriter {
  /** 底层 DataView */
  view: DataView;
  /** 当前写入偏移 */
  offset: number;
}

/** 写 glyf 时的 ttf 上下文数据的最小结构 */
interface GlyfWriteTtf {
  /** 写选项 */
  writeOptions?: {
    /** 是否保留 hinting */
    hinting?: boolean;
    /** 是否写空轮廓字形的数据 */
    writeZeroContoursGlyfData?: boolean;
  } | null;
  /** 各表的支撑数据 */
  support: {
    /** glyf 支撑数据（与 glyf 数组同下标） */
    glyf: GlyfSupport[];
  };
  /** 字形数组 */
  glyf: GlyfEntry[];
}

/** 复合字形标记位：arg1/arg2 为 16 位字 */
const ARG_1_AND_2_ARE_WORDS = componentFlag.ARG_1_AND_2_ARE_WORDS;
/** 复合字形标记位：坐标网格取整 */
const ROUND_XY_TO_GRID = componentFlag.ROUND_XY_TO_GRID;
/** 复合字形标记位：单一缩放 */
const WE_HAVE_A_SCALE = componentFlag.WE_HAVE_A_SCALE;
/** 复合字形标记位：xy 双缩放 */
const WE_HAVE_AN_X_AND_Y_SCALE = componentFlag.WE_HAVE_AN_X_AND_Y_SCALE;
/** 复合字形标记位：2x2 变换矩阵 */
const WE_HAVE_A_TWO_BY_TWO = componentFlag.WE_HAVE_A_TWO_BY_TWO;
/** 复合字形标记位：args 为 xy 值 */
const ARGS_ARE_XY_VALUES = componentFlag.ARGS_ARE_XY_VALUES;
/** 复合字形标记位：使用 my metrics */
const USE_MY_METRICS = componentFlag.USE_MY_METRICS;
/** 复合字形标记位：compound 重叠 */
const OVERLAP_COMPOUND = componentFlag.OVERLAP_COMPOUND;
/** 复合字形标记位：还有更多 component */
const MORE_COMPONENTS = componentFlag.MORE_COMPONENTS;

/**
 * 优化11+21+25+31+32+50+51+52+53+58: glyf write 全面优化
 */
function write(writer: GlyfWriter, ttf: GlyfWriteTtf): GlyfWriter {
  /** 优化290: 缓存 writeOptions 到局部变量，消除重复属性链查找 */
  const writeOpts = ttf.writeOptions || {};
  const hinting = writeOpts.hinting;
  const writeZeroContoursGlyfData = writeOpts.writeZeroContoursGlyfData;

  /* 优化53: 缓存 glyfSupport 到局部变量 */
  const glyfSupport = ttf.support.glyf;
  const glyfs = ttf.glyf;
  const view = writer.view;
  /** 优化141+165: 复用 Uint8Array 视图，避免每次 set 创建临时视图 */
  const buf = view.buffer;
  const vbo = view.byteOffset;
  const fullView = new Uint8Array(buf, vbo);

  for (let index = 0, gl = glyfs.length; index < gl; index++) {
    const glyf = glyfs[index];
    /* 优化117: 缓存 glyfSupport 引用到循环顶部 */
    const gSupport = glyfSupport[index];

    /* 优化51: return → continue */
    if (!glyf.compound && !writeZeroContoursGlyfData && (!glyf.contours || !glyf.contours.length)) {
      continue;
    }

    let pos = writer.offset;

    /**
     * 优化310: simple 字形原始字节快路径——直接 set 原始 glyf 字节段（含 header），
     * 跳过 header 重写 + endPts/instructions/flags/坐标 编码。
     */
    /** 优化314: 原始字节引用展平为 _origBuf/_origOff/_origLen，消除 _origGlyfRef 子对象解引用 */
    const origBuf = glyf._origBuf;
    if (origBuf) {
      /** SSIM 优化：hinting 开启时保留原始 instructions 整段拷贝（不剥离），
       *  浏览器 grid-fitting 行为与完整字体逐像素一致 */
      if (writeOpts.hinting) {
        const origBytesKeep = new Uint8Array(origBuf, glyf._origOff!, glyf._origLen!);
        fullView.set(origBytesKeep, pos);
        pos += glyf._origLen!;
      } else if (glyf._instrOff! >= 0) {
        const instrRelOff = glyf._instrOff! - glyf._origOff!;
        /** instructionLength 字段前（header+endPts+flags+x+y 已写部分？不——flags/x/y 在 instructions 之后）。
         *  实际：instrRelOff 之前是 header(10)+endPts(nc*2)。instrRelOff 处是 instructionLength(2)，
         *  之后是 instructions(_instrLen)，再之后是 flags+x+y 直到 _origLen。 */
        /** 前 segment：[_origOff, _origOff+instrRelOff) = header+endPts */
        fullView.set(new Uint8Array(origBuf, glyf._origOff!, instrRelOff), pos);
        pos += instrRelOff;
        /** instructionLength = 0（替换原 2 字节值） */
        view.setUint16(pos, 0, false);
        pos += 2;
        /** 后 segment：跳过 instructions(_instrLen)，写 [_origOff+instrRelOff+2+_instrLen, _origOff+_origLen) = flags+x+y */
        const afterOff = glyf._origOff! + instrRelOff + 2 + glyf._instrLen!;
        const afterLen = glyf._origLen! - (instrRelOff + 2 + glyf._instrLen!);
        if (afterLen > 0) {
          fullView.set(new Uint8Array(origBuf, afterOff, afterLen), pos);
          pos += afterLen;
        }
      } else {
        const origBytes = new Uint8Array(origBuf, glyf._origOff!, glyf._origLen!);
        fullView.set(origBytes, pos);
        pos += glyf._origLen!;
      }
    } else {

    /* 优化31+103: header 直接 view 写入 10 字节，优先使用 _numContours */
    /** 优化284: 避免 || [] 创建临时空数组 */
    const numC = glyf._numContours != null ? glyf._numContours : (glyf.contours ? glyf.contours.length : 0);
    view.setInt16(pos, glyf.compound ? -1 : numC, false);
    view.setInt16(pos + 2, glyf.xMin!, false);
    view.setInt16(pos + 4, glyf.yMin!, false);
    view.setInt16(pos + 6, glyf.xMax!, false);
    view.setInt16(pos + 8, glyf.yMax!, false);
    pos += 10;

    if (glyf.compound) {
      const subGlyfs = glyf.glyfs!;
      for (let gi = 0, gl2 = subGlyfs.length; gi < gl2; gi++) {
        const g = subGlyfs[gi];
        let flags = g.points ? 0 : ARGS_ARE_XY_VALUES | ROUND_XY_TO_GRID;
        if (gi < gl2 - 1) flags |= MORE_COMPONENTS;
        if (g.useMyMetrics) flags |= USE_MY_METRICS;
        if (g.overlapCompound) flags |= OVERLAP_COMPOUND;
        const transform = g.transform;
        const a = transform.a;
        const b = transform.b;
        const c = transform.c;
        const d = transform.d;
        /** 优化290: 缓存 g.points 避免双重属性查找 */
        const pts = g.points;
        const e = pts ? pts[0] : transform.e;
        const f = pts ? pts[1] : transform.f;
        if (e < 0 || e > 0x7F || f < 0 || f > 0x7F) {
          flags |= ARG_1_AND_2_ARE_WORDS;
        }
        if (b || c) {
          flags |= WE_HAVE_A_TWO_BY_TWO;
        } else if ((a !== 1 || d !== 1) && a === d) {
          flags |= WE_HAVE_A_SCALE;
        } else if (a !== 1 || d !== 1) {
          flags |= WE_HAVE_AN_X_AND_Y_SCALE;
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
        /** 优化293: 预计算 F2Dot14 值，避免在分支内重复乘法 */
        const sa = a * 16384 + 0.5 | 0;
        if (WE_HAVE_A_SCALE & flags) {
          view.setInt16(pos, sa, false); pos += 2;
        } else if (WE_HAVE_AN_X_AND_Y_SCALE & flags) {
          const sd = d * 16384 + 0.5 | 0;
          view.setInt16(pos, sa, false); pos += 2;
          view.setInt16(pos, sd, false); pos += 2;
        } else if (WE_HAVE_A_TWO_BY_TWO & flags) {
          const sb = b * 16384 + 0.5 | 0;
          const sc = c * 16384 + 0.5 | 0;
          const sd2 = d * 16384 + 0.5 | 0;
          view.setInt16(pos, sa, false); pos += 2;
          view.setInt16(pos, sb, false); pos += 2;
          view.setInt16(pos, sc, false); pos += 2;
          view.setInt16(pos, sd2, false); pos += 2;
        }
      }
    } else {
      /* 优化32+66+103: endPtsOfContours 直接 view 写入，支持 _pointsPerContour */
      /** 优化284: 避免 || [] 创建临时空数组 */
      /** contours 为 null/undefined 是零轮廓字形（writeZeroContoursGlyfData 开启时走到此），
       *  无 endPts 写入，下方 instrLen=0 + 空 flags/coords 共 12B，与 sizeof.getFlagsAndSize 对齐 */
      const contours = glyf.contours;
      let endPts = -1;
      const ppc = glyf._pointsPerContour;
      if (ppc) {
        for (let ci = 0, cl = ppc.length; ci < cl; ci++) {
          endPts += ppc[ci];
          view.setUint16(pos, endPts, false);
          pos += 2;
        }
      } else if (contours) {
        const isFlat = glyf._flatContours;
        for (let ci2 = 0, cl2 = contours.length; ci2 < cl2; ci2++) {
          endPts += isFlat ? contours[ci2].length / 3 : contours[ci2].length;
          view.setUint16(pos, endPts, false);
          pos += 2;
        }
      }

      /* 优化25+80: instructions 使用 Uint8Array.set 批量写入 */
      if (hinting && glyf.instructions) {
        const instructions = glyf.instructions;
        view.setUint16(pos, instructions.length, false);
        pos += 2;
        if (instructions.length > 0) {
          const instrArr = instructions instanceof Uint8Array ? instructions : new Uint8Array(instructions);
          fullView.set(instrArr, pos);
        }
        pos += instructions.length;
      } else {
        view.setUint16(pos, 0, false);
        pos += 2;
      }

      /* 优化11+79+135+230+237: flags 是 Uint8Array，直接 set 批量写入替代逐字节循环 */
      const flags = gSupport.flags;
      if (flags && flags.length > 0) {
        fullView.set(flags, pos);
        pos += flags.length;
      }

      /* 优化21+98+119+165: xCoord 预编码 Uint8Array 直接 set，复用全局视图 */
      if (gSupport.xEncoded) {
        fullView.set(gSupport.xEncoded, pos);
        pos += gSupport.xEncoded.length;
      } else {
        const xCoord = gSupport.xCoord || [];
        for (let xi = 0, xl = xCoord.length; xi < xl; xi++) {
          const xv = xCoord[xi];
          if (0 <= xv && xv <= 0xFF) {
            view.setUint8(pos, xv);
            pos += 1;
          } else {
            view.setInt16(pos, xv, false);
            pos += 2;
          }
        }
      }

      /* 优化21+58+98+119+165: yCoord 预编码 Uint8Array 直接 set，复用全局视图 */
      if (gSupport.yEncoded) {
        fullView.set(gSupport.yEncoded, pos);
        pos += gSupport.yEncoded.length;
      } else {
        const yCoord = gSupport.yCoord || [];
        for (let yi = 0, yl = yCoord.length; yi < yl; yi++) {
          const yv = yCoord[yi];
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
    } /* 优化310: 关闭 _origGlyfRef 的 else 块 */

    /* 优化81+171: 4字节对齐使用 fill(0) 替代逐字节写入 */
    const glyfSize = gSupport.glyfSize;
    const pad = glyfSize % 4;
    if (pad) {
      fullView.fill(0, pos, pos + (4 - pad));
      pos += 4 - pad;
    }

    writer.offset = pos;
  }
  return writer;
}

export default write;
export { write };
