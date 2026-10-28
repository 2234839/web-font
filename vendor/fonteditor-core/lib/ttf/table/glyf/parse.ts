/**
 * @file 解析glyf轮廓
 * @author mengke01(kekee000@gmail.com)
 */
import glyFlag from "../../enum/glyFlag";
import componentFlag from "../../enum/componentFlag";

/** 单条指令长度上限（超过则不解析 instructions） */
const MAX_INSTRUCTION_LENGTH = 5000;
/** 坐标点数上限（超过则放弃解析坐标） */
const MAX_NUMBER_OF_COORDINATES = 20000;

/** glyf 读取器的最小结构（ttf/reader.js 的 Reader） */
interface GlyfReader {
  /** 当前读取偏移（相对 view 起始位置） */
  offset: number;
  /** 底层 DataView 视图 */
  view: DataView;
  /** 移动到指定偏移 */
  seek(offset: number): void;
}

/** parseGlyf 入参中的 ttf 上下文（仅消费 readOptions.hinting） */
interface GlyfParseTtf {
  /** 读取选项 */
  readOptions?: {
    /** 是否保留 hinting 指令 */
    hinting?: boolean;
  };
}

/** 复合字形的单个组件引用 */
interface CompoundGlyphComponent {
  /** 组件 flags（原始位标记） */
  flags: number;
  /** 被引用的组件 glyph id */
  glyphIndex: number;
  /** 是否使用母字形 metrics（USE_MY_METRICS） */
  useMyMetrics?: boolean;
  /** 组件重叠标记（OVERLAP_COMPOUND） */
  overlapCompound?: boolean;
  /** 点对齐模式下的 [arg1, arg2] 匹配点 */
  points?: number[];
  /** 仿射变换矩阵（F2DOT14 解码后的 a~f 六分量） */
  transform: {
    /** a 分量（x 缩放） */
    a: number;
    /** b 分量 */
    b: number;
    /** c 分量 */
    c: number;
    /** d 分量（y 缩放） */
    d: number;
    /** e 分量（x 平移） */
    e: number;
    /** f 分量（y 平移） */
    f: number;
  };
}

/** 解析得到的 glyf 轮廓数据 */
interface ParsedGlyf {
  /** x 最小值 */
  xMin?: number;
  /** y 最小值 */
  yMin?: number;
  /** x 最大值 */
  xMax?: number;
  /** y 最大值 */
  yMax?: number;
  /** 各轮廓结束点索引（简单字形） */
  endPtsOfContours?: number[];
  /** hinting 指令字节序列 */
  instructions?: number[];
  /** 是否复合字形 */
  compound?: boolean;
  /** 复合字形的组件引用列表 */
  glyfs?: CompoundGlyphComponent[];
  /** 优化94: 各点 x 绝对坐标（延迟 contour 构建到 optimize 阶段） */
  _xArr?: Int32Array;
  /** 优化94: 各点 y 绝对坐标 */
  _yArr?: Int32Array;
  /** 优化94: 各点原始 flag */
  _flags?: Uint8Array;
}

/**
 * 优化92+94: parseSimpleGlyf 使用 TypedArray，延迟 contour 构建到 optimize 阶段
 */
function parseSimpleGlyf(reader: GlyfReader, glyf: ParsedGlyf): ParsedGlyf {
  const offset = reader.offset;
  void offset;
  const endPtsOfContours = glyf.endPtsOfContours!;
  const numberOfCoordinates = endPtsOfContours[endPtsOfContours.length - 1] + 1;

  if (numberOfCoordinates > MAX_NUMBER_OF_COORDINATES) {
    return glyf;
  }

  const REPEAT = glyFlag.REPEAT;
  const XSHORT = glyFlag.XSHORT;
  const XSAME = glyFlag.XSAME;
  const YSHORT = glyFlag.YSHORT;
  const YSAME = glyFlag.YSAME;
  const ONCURVE = glyFlag.ONCURVE;
  void ONCURVE;

  const view = reader.view;
  let vOffset = view.byteOffset + reader.offset;
  const flags = new Uint8Array(numberOfCoordinates);
  let fi = 0;
  while (fi < numberOfCoordinates) {
    const flag = view.getUint8(vOffset++);
    flags[fi++] = flag;
    if (flag & REPEAT && fi < numberOfCoordinates) {
      const repeat = view.getUint8(vOffset++);
      const fillCount = repeat < numberOfCoordinates - fi ? repeat : numberOfCoordinates - fi;
      flags.fill(flag, fi, fi + fillCount);
      fi += fillCount;
    }
  }

  const xArr = new Int32Array(numberOfCoordinates);
  let prevX = 0;
  for (let xi = 0; xi < numberOfCoordinates; xi++) {
    let x = 0;
    const xflag = flags[xi];
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

  const yArr = new Int32Array(numberOfCoordinates);
  let prevY = 0;
  for (let yi = 0; yi < numberOfCoordinates; yi++) {
    let y = 0;
    const yflag = flags[yi];
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
const _ARG_1_AND_2_ARE_WORDS = componentFlag.ARG_1_AND_2_ARE_WORDS;
const _WE_HAVE_A_SCALE = componentFlag.WE_HAVE_A_SCALE;
const _WE_HAVE_AN_X_AND_Y_SCALE = componentFlag.WE_HAVE_AN_X_AND_Y_SCALE;
const _WE_HAVE_A_TWO_BY_TWO = componentFlag.WE_HAVE_A_TWO_BY_TWO;
const _ARGS_ARE_XY_VALUES = componentFlag.ARGS_ARE_XY_VALUES;
const _USE_MY_METRICS = componentFlag.USE_MY_METRICS;
const _OVERLAP_COMPOUND = componentFlag.OVERLAP_COMPOUND;
const _MORE_COMPONENTS = componentFlag.MORE_COMPONENTS;
const _WE_HAVE_INSTRUCTIONS = componentFlag.WE_HAVE_INSTRUCTIONS;

function parseCompoundGlyf(reader: GlyfReader, glyf: ParsedGlyf): ParsedGlyf {
  glyf.compound = true;
  glyf.glyfs = [];
  let flags = 0;
  const ARG_1_AND_2_ARE_WORDS = _ARG_1_AND_2_ARE_WORDS;
  const WE_HAVE_A_SCALE = _WE_HAVE_A_SCALE;
  const WE_HAVE_AN_X_AND_Y_SCALE = _WE_HAVE_AN_X_AND_Y_SCALE;
  const WE_HAVE_A_TWO_BY_TWO = _WE_HAVE_A_TWO_BY_TWO;
  const ARGS_ARE_XY_VALUES = _ARGS_ARE_XY_VALUES;
  const USE_MY_METRICS = _USE_MY_METRICS;
  const OVERLAP_COMPOUND = _OVERLAP_COMPOUND;
  const MORE_COMPONENTS = _MORE_COMPONENTS;
  const WE_HAVE_INSTRUCTIONS = _WE_HAVE_INSTRUCTIONS;

  const view = reader.view;
  let vOffset = view.byteOffset + reader.offset;

  /** 优化293: F2DOT14 逆比例常量提升到循环外（raw * (1/16384) 浮点解码） */
  const F2DOT14_INV = 0.00006103515625;
  do {
    flags = view.getUint16(vOffset, false); vOffset += 2;
    const glyphIndex = view.getUint16(vOffset, false); vOffset += 2;
    let arg1 = 0;
    let arg2 = 0;
    let scaleX = 16384;
    let scaleY = 16384;
    let scale01 = 0;
    let scale10 = 0;
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
      glyf.glyfs!.push({
        flags: flags,
        glyphIndex: glyphIndex,
        useMyMetrics: !!(flags & USE_MY_METRICS),
        overlapCompound: !!(flags & OVERLAP_COMPOUND),
        transform: { a: scaleX * F2DOT14_INV, b: scale01 * F2DOT14_INV, c: scale10 * F2DOT14_INV, d: scaleY * F2DOT14_INV, e: arg1, f: arg2 }
      });
    } else {
      glyf.glyfs!.push({
        flags: flags,
        glyphIndex: glyphIndex,
        points: [arg1, arg2],
        transform: { a: scaleX * F2DOT14_INV, b: scale01 * F2DOT14_INV, c: scale10 * F2DOT14_INV, d: scaleY * F2DOT14_INV, e: 0, f: 0 }
      });
    }
  } while (MORE_COMPONENTS & flags);

  if (WE_HAVE_INSTRUCTIONS & flags) {
    const length = view.getUint16(vOffset, false); vOffset += 2;
    if (length < MAX_INSTRUCTION_LENGTH) {
      const instructions = new Array<number>(length);
      for (let i = 0; i < length; ++i) {
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
function parseGlyf(reader: GlyfReader, ttf: GlyfParseTtf, offset?: number): ParsedGlyf {
  if (null != offset) {
    reader.seek(offset);
  }
  const glyf: ParsedGlyf = {};
  /** 优化290: 缓存 ttf.readOptions 到局部变量，消除重复属性链查找 */
  const readOpts = ttf.readOptions || {};
  const hinting = readOpts.hinting;

  /* 优化41: 直接 view 读取 header 的 10 字节 */
  const view = reader.view;
  let vOffset = view.byteOffset + reader.offset;
  const numberOfContours = view.getInt16(vOffset, false);
  glyf.xMin = view.getInt16(vOffset + 2, false);
  glyf.yMin = view.getInt16(vOffset + 4, false);
  glyf.xMax = view.getInt16(vOffset + 6, false);
  glyf.yMax = view.getInt16(vOffset + 8, false);
  vOffset += 10;

  if (numberOfContours >= 0) {
    /* 优化41: endPtsOfContours 预分配 + 直接 view 读取 */
    if (numberOfContours > 0) {
      const endPtsOfContours = new Array<number>(numberOfContours);
      for (let i = 0; i < numberOfContours; i++) {
        endPtsOfContours[i] = view.getUint16(vOffset, false);
        vOffset += 2;
      }
      glyf.endPtsOfContours = endPtsOfContours;
    } else {
      /** 优化245: undefined → 0，避免 V8 隐藏类转换，后续取默认值 0 */
      glyf.xMin = 0;
      glyf.yMin = 0;
      glyf.xMax = 0;
      glyf.yMax = 0;
    }

    /* 优化12+42: 非 hinting 模式只跳过 instructions */
    const instrLength = view.getUint16(vOffset, false);
    vOffset += 2;
    if (hinting && instrLength && instrLength < MAX_INSTRUCTION_LENGTH) {
      const instructions = new Array<number>(instrLength);
      for (let j = 0; j < instrLength; j++) {
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

export { parseGlyf };
export default parseGlyf;
