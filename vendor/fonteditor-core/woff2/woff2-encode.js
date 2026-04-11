/**
 * @file 纯 JavaScript 实现的 WOFF2 编码器
 * 替代原 wasm 实现，使用 Brotli 压缩
 *
 * WOFF2 格式参考: https://www.w3.org/TR/WOFF2/
 * 兼容 Node.js (require("node:zlib"))、LLRT (require("zlib")) 及浏览器环境
 */

/** @type {typeof import("zlib")} */
let zlib;
try {
  zlib = require("node:zlib");
} catch (_) {
  zlib = require("zlib");
}
const brotliCompressSync = zlib.brotliCompressSync;

/** LLRT 的 zlib 没有 constants，直接使用数值常量（与 Node.js zlib.constants 一致） */
const BROTLI_PARAM_QUALITY = zlib.constants?.BROTLI_PARAM_QUALITY ?? 3;
const BROTLI_PARAM_SIZE_HINT = zlib.constants?.BROTLI_PARAM_SIZE_HINT ?? 4;

/**
 * Brotli 压缩参数：quality 8
 * 测试表明 FONT 模式对小数据集（<200KB）无速度优势且增加 0.14% 体积，保持 GENERIC
 */
const BROTLI_OPTIONS_BASE = {
  params: { [BROTLI_PARAM_QUALITY]: 8 },
};
/** 优化: 预分配 options 模板，避免每次 encode 创建 computed property name 对象 */
const BROTLI_OPTIONS_WITH_HINT = {
  params: { [BROTLI_PARAM_QUALITY]: 8, [BROTLI_PARAM_SIZE_HINT]: 0 },
};

/* ======== 大端序读写工具函数（模块级，消除闭包分配） ======== */

/** 从 Uint8Array 读取无符号 16 位大端序 */
function readU16(arr, off) { return (arr[off] << 8) | arr[off + 1]; }

/** 从 Uint8Array 读取有符号 16 位大端序 */
function readI16(arr, off) { const v = (arr[off] << 8) | arr[off + 1]; return v > 0x7FFF ? v - 0x10000 : v; }

/** 从 Uint8Array 读取无符号 32 位大端序 */
function readU32(arr, off) { return (arr[off] << 24 | arr[off + 1] << 16 | arr[off + 2] << 8 | arr[off + 3]) >>> 0; }

/** 向 Uint8Array 写入无符号 16 位大端序 */
function writeU16(buf, v, p) { buf[p] = v >> 8; buf[p + 1] = v & 0xFF; }

/** 向 Uint8Array 写入无符号 32 位大端序 */
function writeU32(buf, v, p) { buf[p] = v >> 24; buf[p + 1] = (v >> 16) & 0xFF; buf[p + 2] = (v >> 8) & 0xFF; buf[p + 3] = v & 0xFF; }

/* ======== Known Table Tags 索引表 ======== */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep ", "CFF ", "VORG ", "EBDT",
  "EBLC", "EBSC", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix",
  "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat",
  "fmtx", "fvar", "gvar", "gdef", "hsty", "jstf", "lcar", "mort",
  "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc",
  "Feat", "Sill",
];

/**
 * 优化：预构建 tag→index Map，消除每次 getTagIndex 的 O(63) 线性搜索
 */
/** 优化: 模块级常量，避免每次 loca 表创建 new Uint8Array(0) */
const EMPTY_UINT8 = new Uint8Array(0);

const KNOWN_TAG_MAP = new Map();
for (let i = 0; i < KNOWN_TAGS.length; i++) {
  KNOWN_TAG_MAP.set(KNOWN_TAGS[i], i);
}

/**
 * 优化262: 预构建 tag uint32 → index Map，用于 getTagIndexU32
 */
const KNOWN_TAG_U32_MAP = new Map();
for (let i = 0; i < KNOWN_TAGS.length; i++) {
  const t = KNOWN_TAGS[i];
  KNOWN_TAG_U32_MAP.set((t.charCodeAt(0) << 24 | t.charCodeAt(1) << 16 | t.charCodeAt(2) << 8 | t.charCodeAt(3)) >>> 0, i);
}

/**
 * 从 4 字节 tag uint32 获取 Known Table Tag 索引
 */
function getTagIndex(tag) {
  const idx = KNOWN_TAG_MAP.get(tag);
  return idx !== undefined ? idx : 63;
}

function getTagIndexU32(tagU32) {
  const idx = KNOWN_TAG_U32_MAP.get(tagU32);
  return idx !== undefined ? idx : 63;
}

/* ======== 变长整数编码 ======== */

/** 计算 UIntBase128 编码后的字节数 */
function calcUIntBase128Size(value) {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x200000) return 3;
  if (value < 0x10000000) return 4;
  return 5;
}

/** 编码 UIntBase128（最多 5 字节，高位在前），优化234: 展开常见路径 */
function encodeUIntBase128(value, buf, offset) {
  if (value < 0x80) {
    buf[offset] = value;
    return 1;
  }
  if (value < 0x4000) {
    buf[offset] = (value >>> 7) | 0x80;
    buf[offset + 1] = value & 0x7F;
    return 2;
  }
  if (value < 0x200000) {
    buf[offset] = (value >>> 14) | 0x80;
    buf[offset + 1] = ((value >>> 7) & 0x7F) | 0x80;
    buf[offset + 2] = value & 0x7F;
    return 3;
  }
  if (value < 0x10000000) {
    buf[offset] = (value >>> 21) | 0x80;
    buf[offset + 1] = ((value >>> 14) & 0x7F) | 0x80;
    buf[offset + 2] = ((value >>> 7) & 0x7F) | 0x80;
    buf[offset + 3] = value & 0x7F;
    return 4;
  }
  buf[offset] = (value >>> 28) | 0x80;
  buf[offset + 1] = ((value >>> 21) & 0x7F) | 0x80;
  buf[offset + 2] = ((value >>> 14) & 0x7F) | 0x80;
  buf[offset + 3] = ((value >>> 7) & 0x7F) | 0x80;
  buf[offset + 4] = value & 0x7F;
  return 5;
}

/** 编码 255UInt16（1-3 字节变长） */
function encode255UInt16(value, buf, offset) {
  if (value < 253) {
    buf[offset] = value;
    return 1;
  }
  if (value < 506) {
    buf[offset] = 255;
    buf[offset + 1] = value - 253;
    return 2;
  }
  if (value < 762) {
    buf[offset] = 254;
    buf[offset + 1] = value - 506;
    return 2;
  }
  buf[offset] = 253;
  /** 优化291: Uint8Array 赋值自动截断，消除冗余的 & 0xFF */
  buf[offset + 1] = value >> 8;
  buf[offset + 2] = value;
  return 3;
}

/** 计算 255UInt16 编码后的字节数 */
function size255UInt16(value) {
  if (value <= 252) return 1;
  if (value <= 762) return 2;
  return 3;
}

const sizeUIntBase128 = calcUIntBase128Size;

/* ======== Triplet 编码 ======== */

/**
 * 从 triplet flag 推断数据字节数（避免重复计算）
 * tripletIndex = flag & 0x7F
 * 优化：预计算查找表，消除函数调用和条件分支
 */
const TRIPLET_DATA_SIZES = new Uint8Array(128);
for (let i = 0; i < 84; i++) TRIPLET_DATA_SIZES[i] = 1;
for (let i = 84; i < 120; i++) TRIPLET_DATA_SIZES[i] = 2;
for (let i = 120; i < 124; i++) TRIPLET_DATA_SIZES[i] = 3;
for (let i = 124; i < 128; i++) TRIPLET_DATA_SIZES[i] = 4;

/**
 * 仅计算 triplet flag 字节，不写入数据
 * 优化: Pass 1 只需要 flag，数据写入由 Pass 2 的 writePointDataByFlag 完成
 */
/**
 * 计算 triplet flag 并同时写入数据字节，消除重复的 absDx/absDy 计算和二次分支判断
 * 优化291: 合并 calcTripletFlag + writePointDataByFlag 为单一函数
 */
function calcTripletAndWrite(curveBit, dx, dy, buf, offset) {
  const absDx = dx < 0 ? -dx : dx;
  const absDy = dy < 0 ? -dy : dy;
  const xSignBit = dx >= 0 ? 1 : 0;
  const ySignBit = dy >= 0 ? 1 : 0;
  const xySignBits = xSignBit + 2 * ySignBit;

  /* dx=0, Y 单轴 1 数据字节 (flag 0-9) */
  if (dx === 0 && absDy < 1280) {
    buf[offset] = absDy & 0xFF;
    return curveBit + ((absDy & 0xF00) >> 7) + ySignBit;
  }

  /* dy=0, dx≠0, X 单轴 1 数据字节 (flag 10-19) */
  if (dy === 0 && dx !== 0 && absDx < 1280) {
    buf[offset] = absDx & 0xFF;
    return curveBit + 10 + ((absDx & 0xF00) >> 7) + xSignBit;
  }

  /* 双轴 1 数据字节 (flag 20-83): 1 ≤ |dx| ≤ 64, 1 ≤ |dy| ≤ 64 */
  if (dx !== 0 && dy !== 0 && absDx < 65 && absDy < 65) {
    const ax = absDx - 1;
    const ay = absDy - 1;
    buf[offset] = ((ax & 0xF) << 4) | (ay & 0xF);
    return curveBit + 20 + (ax & 0x30) + ((ay & 0x30) >> 2) + xySignBits;
  }

  /* 双轴 2 数据字节 (flag 84-119): 1 ≤ |dx| ≤ 768, 1 ≤ |dy| ≤ 768 */
  if (dx !== 0 && dy !== 0 && absDx < 769 && absDy < 769) {
    const ax = absDx - 1;
    const ay = absDy - 1;
    buf[offset] = ax & 0xFF;
    buf[offset + 1] = ay & 0xFF;
    return curveBit + 84 + 12 * ((ax & 0x300) >> 8) + ((ay & 0x300) >> 6) + xySignBits;
  }

  /* 双轴 3 数据字节 (flag 120-123) */
  if (absDx < 4096 && absDy < 4096) {
    buf[offset] = absDx >> 4;
    buf[offset + 1] = ((absDx & 0xF) << 4) | (absDy >> 8);
    buf[offset + 2] = absDy & 0xFF;
    return curveBit + 120 + xySignBits;
  }

  /* 兜底 4 数据字节 (flag 124-127) */
  buf[offset] = (absDx >> 8) & 0xFF;
  buf[offset + 1] = absDx & 0xFF;
  buf[offset + 2] = (absDy >> 8) & 0xFF;
  buf[offset + 3] = absDy & 0xFF;
  return curveBit + 124 + xySignBits;
}

/* ======== glyf + loca 表变换 ======== */

/**
 * 对 glyf + loca 表执行 WOFF2 变换
 */
function transformGlyfAndLoca(glyfData, locaData, indexFormat, numGlyphs) {
  /** 优化222: 使用模块级 readU16/readI16/readU32，消除闭包分配 */

  /* 读取 loca 表获取每个 glyph 的偏移 */
  const offsets = new Int32Array(numGlyphs + 1);
  if (indexFormat === 0) {
    for (let i = 0; i <= numGlyphs; i++) {
      offsets[i] = readU16(locaData, i * 2) * 2;
    }
  } else {
    for (let i = 0; i <= numGlyphs; i++) {
      offsets[i] = readU32(locaData, i * 4);
    }
  }

  const XSHORT_FLAG = 2;
  const XSAME_FLAG = 16;
  const YSHORT_FLAG = 4;
  const YSAME_FLAG = 32;
  const REPEAT_FLAG = 8;
  const OVERLAP_FLAG = 64;
  const ONCURVE_FLAG = 1;

  /**
   * 优化：合并第 1 遍（解码 glyph）和第 2 遍（预计算 stream 大小 + 缓存 triplet flag）
   * 消除一次完整的 numGlyphs 遍历，利用解码后数据仍在 L1 cache 的优势
   */
  let totalNPointsSize = 0;
  let flagStreamSize = 0;
  let glyphStreamSize = 0;
  let bboxStreamSize = 0;
  let instructionStreamSize = 0;
  let hasOverlapBitmap = false;
  let totalPoints = 0;

  const bboxBitmapSize = ((numGlyphs + 31) >>> 5) << 2;
  const bboxBitmap = new Uint8Array(bboxBitmapSize);
  const overlapBitmap = new Uint8Array(bboxBitmapSize);

  /* 收集每个 glyph 的信息 */
  const glyphInfos = new Array(numGlyphs);

  for (let gi = 0; gi < numGlyphs; gi++) {
    const glyphStart = offsets[gi];
    const glyphEnd = offsets[gi + 1];

    if (glyphStart === glyphEnd) {
      glyphInfos[gi] = null;
      continue;
    }

    const numberOfContours = readI16(glyfData, glyphStart);
    const xMin = readI16(glyfData, glyphStart + 2);
    const yMin = readI16(glyfData, glyphStart + 4);
    const xMax = readI16(glyfData, glyphStart + 6);
    const yMax = readI16(glyfData, glyphStart + 8);

    if (numberOfContours < 0) {
      /* 复合 glyph */
      let compOff = glyphStart + 10;
      let haveInstructions = false;
      let instrLength = 0;
      let instructions = null;

      const MORE_COMPONENTS = 0x0020;
      const WE_HAVE_INSTRUCTIONS = 0x0100;
      while (compOff < glyphEnd) {
        const compFlags = readU16(glyfData, compOff);
        compOff += 2;
        compOff += 2; /* glyphIndex */

        if (compFlags & 0x0001) compOff += 4;
        else compOff += 2;
        if (compFlags & 0x0008) compOff += 2;
        else if (compFlags & 0x0040) compOff += 4;
        else if (compFlags & 0x0080) compOff += 8;

        if (!(compFlags & MORE_COMPONENTS)) {
          haveInstructions = !!(compFlags & WE_HAVE_INSTRUCTIONS);
          break;
        }
      }

      const componentDataEnd = compOff;

      if (haveInstructions && compOff + 2 <= glyphEnd) {
        instrLength = readU16(glyfData, compOff);
        compOff += 2;
        if (instrLength > 0 && compOff + instrLength <= glyphEnd) {
          instructions = { offset: compOff, length: instrLength };
        }
      }

      const rawLength = componentDataEnd - glyphStart - 10;

      glyphInfos[gi] = {
        composite: true,
        xMin, yMin, xMax, yMax,
        rawOffset: glyphStart + 10,
        rawLength,
        instructions,
        haveInstructions,
      };

      /* ★ 合并：复合 glyph 的统计量 */
      bboxBitmap[gi >> 3] |= (0x80 >> (gi & 7));
      bboxStreamSize += 8;
      glyphStreamSize += rawLength;
      if (haveInstructions) {
        instructionStreamSize += instrLength;
        glyphStreamSize += size255UInt16(instrLength);
      }
      continue;
    }

    /* 简单 glyph */
    let dataOff = glyphStart + 10;

    /** 优化291: Pass 1 只计算 nPointsBytes + 存储 delta，延迟编码到 Pass 2，消除临时 buffer 分配和 memcpy */
    const nPointsDeltas = new Int16Array(numberOfContours);
    let nPointsBytes = 0;
    let prevEnd = -1;
    let lastEndPt = -1;
    for (let c = 0; c < numberOfContours; c++) {
      const endPt = readU16(glyfData, dataOff);
      dataOff += 2;
      const delta = endPt - prevEnd;
      nPointsDeltas[c] = delta;
      nPointsBytes += size255UInt16(delta);
      prevEnd = endPt;
    }
    lastEndPt = prevEnd;
    totalNPointsSize += nPointsBytes;

    const instructionLength = readU16(glyfData, dataOff);
    dataOff += 2;
    const instructions = instructionLength > 0 ? { offset: dataOff, length: instructionLength } : null;
    dataOff += instructionLength;

    /* ★ 合并：instructionStreamSize 累加 */
    instructionStreamSize += instructionLength;

    const numPoints = numberOfContours > 0 ? lastEndPt + 1 : 0;

    /* 优化183: flagsArr 复用为 cachedFlags，消除每个 glyph 一次 Uint8Array 分配 */
    const flagsArr = new Uint8Array(numPoints);
    let hasOverlap = false;
    let fi = 0;
    while (fi < numPoints) {
      const flag = glyfData[dataOff++];
      if (flag & OVERLAP_FLAG) hasOverlap = true;
      flagsArr[fi++] = flag;
      if (flag & REPEAT_FLAG && fi < numPoints) {
        const repeat = glyfData[dataOff++];
        const count = repeat < numPoints - fi ? repeat : numPoints - fi;
        flagsArr.fill(flag, fi, fi + count);
        fi += count;
      }
    }

    /* ★ 合并：overlapBitmap + flagStreamSize + totalPoints */
    if (numberOfContours > 0) {
      if (hasOverlap) {
        hasOverlapBitmap = true;
        overlapBitmap[gi >> 3] |= (0x80 >> (gi & 7));
      }
      flagStreamSize += numPoints;
      totalPoints += numPoints;
    }

    /** 优化293: coords 拆分为独立 xCoords/yCoords，顺序内存访问更利于 CPU 缓存预取 */
    const xCoords = new Int32Array(numPoints);
    const yCoords = new Int32Array(numPoints);
    let px = 0;
    let calcXMin, calcXMax;
    for (let xi = 0; xi < numPoints; xi++) {
      const f = flagsArr[xi];
      if (f & XSHORT_FLAG) {
        const b = glyfData[dataOff++];
        px += (f & XSAME_FLAG) ? b : -b;
      } else if (!(f & XSAME_FLAG)) {
        let dx = (glyfData[dataOff] << 8) | glyfData[dataOff + 1];
        if (dx > 0x7FFF) dx -= 0x10000;
        px += dx;
        dataOff += 2;
      }
      xCoords[xi] = px;
      if (xi === 0) { calcXMin = px; calcXMax = px; }
      else if (px < calcXMin) calcXMin = px;
      else if (px > calcXMax) calcXMax = px;
    }

    let py = 0;
    let calcYMin, calcYMax;
    for (let yi = 0; yi < numPoints; yi++) {
      const f = flagsArr[yi];
      if (f & YSHORT_FLAG) {
        const b = glyfData[dataOff++];
        py += (f & YSAME_FLAG) ? b : -b;
      } else if (!(f & YSAME_FLAG)) {
        let dy = (glyfData[dataOff] << 8) | glyfData[dataOff + 1];
        if (dy > 0x7FFF) dy -= 0x10000;
        py += dy;
        dataOff += 2;
      }
      yCoords[yi] = py;
      if (yi === 0) { calcYMin = py; calcYMax = py; }
      else if (py < calcYMin) calcYMin = py;
      else if (py > calcYMax) calcYMax = py;
    }

    /* 优化282: bbox 检查 + triplet 计算 + glyphStreamSize 累加 */
    let glyphStreamBuf = null;
    let gsbi = 0;
    if (numberOfContours > 0) {
      const bboxMatches = calcXMin === xMin && calcYMin === yMin && calcXMax === xMax && calcYMax === yMax;
      if (!bboxMatches) {
        bboxBitmap[gi >> 3] |= (0x80 >> (gi & 7));
        bboxStreamSize += 8;
      }

      let prevX = 0, prevY = 0;
      const maxGlyphStreamBytes = numPoints * 4 + 3;
      glyphStreamBuf = new Uint8Array(maxGlyphStreamBytes);
      /** 优化291: 使用合并函数，消除重复 absDx/absDy + 二次分支 + 重复坐标读取 */
      for (let pi = 0; pi < numPoints; pi++) {
        const cx = xCoords[pi];
        const cy = yCoords[pi];
        /** 优化293: 内联 curveBit 计算，消除 !! onCurve + 函数内三元运算 */
        const curveBit = (flagsArr[pi] & 1) ? 0 : 128;
        const dx = cx - prevX;
        const dy = cy - prevY;
        const flag = calcTripletAndWrite(curveBit, dx, dy, glyphStreamBuf, gsbi);
        flagsArr[pi] = flag;
        gsbi += TRIPLET_DATA_SIZES[flag & 0x7F];
        prevX = cx;
        prevY = cy;
      }
      glyphStreamSize += gsbi + size255UInt16(instructionLength);
    }

    /* 优化277: 存储 glyphStreamBuf，Pass 2 直接 set 拷贝，不再需要 writePointDataByFlag */
    glyphInfos[gi] = numberOfContours > 0
      ? {
          composite: false,
          numberOfContours,
          /** 优化291: 存储 nPointsDeltas 替代 nPointsEncoded，延迟编码到 Pass 2 */
          nPointsDeltas,
          nPointsBytes,
          instructions,
          flags: flagsArr,
          calcXMin, calcYMin, calcXMax, calcYMax,
          glyphStreamBuf, glyphStreamBytes: gsbi,
        }
      : {
          composite: false,
          numberOfContours: 0,
        };
  }

  const nContourStreamSize = numGlyphs * 2;
  const headerSize = 36;
  const overlapBitmapSize = hasOverlapBitmap ? bboxBitmapSize : 0;
  const totalSize = headerSize
    + nContourStreamSize
    + totalNPointsSize
    + flagStreamSize
    + glyphStreamSize
    + bboxBitmapSize
    + bboxStreamSize
    + instructionStreamSize
    + overlapBitmapSize;

  const result = new Uint8Array(totalSize);
  /** 优化222: 使用模块级 writeU16/writeI16/writeU32，消除闭包分配 */
  let pos = 0;

  /* Header */
  writeU16(result, 0, pos); pos += 2;
  writeU16(result, hasOverlapBitmap ? 1 : 0, pos); pos += 2;
  writeU16(result, numGlyphs, pos); pos += 2;
  writeU16(result, indexFormat, pos); pos += 2;
  writeU32(result, nContourStreamSize, pos); pos += 4;
  writeU32(result, totalNPointsSize, pos); pos += 4;
  writeU32(result, flagStreamSize, pos); pos += 4;
  writeU32(result, glyphStreamSize, pos); pos += 4;
  writeU32(result, 0, pos); pos += 4;
  writeU32(result, bboxBitmapSize + bboxStreamSize, pos); pos += 4;
  writeU32(result, instructionStreamSize, pos); pos += 4;

  /**
   * 优化：合并原第 3/4/5 次遍历为 1 次
   * nContourStream + nPointsStream + 所有子流写入合并在单次 glyph 遍历中
   */
  const nContourEnd = pos + nContourStreamSize;
  let nContourPos = pos;
  let nPointsPos = nContourEnd;
  pos = nContourEnd + totalNPointsSize;

  const flagStreamStart = pos;
  pos += flagStreamSize;
  const glyphStreamStart = pos;
  pos += glyphStreamSize;
  const bboxBitmapStart = pos;
  pos += bboxBitmapSize;
  const bboxStreamStart = pos;
  pos += bboxStreamSize;
  const instructionStreamStart = pos;
  pos += instructionStreamSize;
  const overlapBitmapStart = pos;

  let flagPos = flagStreamStart;
  let glyphPos = glyphStreamStart;
  let bboxPos = bboxStreamStart;
  let instrPos = instructionStreamStart;

  for (let gi = 0; gi < numGlyphs; gi++) {
    const g = glyphInfos[gi];

    /* nContourStream: 每个 glyph 写入 numberOfContours */
    /** 优化291: writeI16 内联为直接数组写入 */
    if (!g) {
      nContourPos += 2;
      continue;
    }
    if (g.composite) {
      result[nContourPos] = 0xFF; result[nContourPos + 1] = 0xFF;
    } else {
      const nc = g.numberOfContours;
      result[nContourPos] = nc >> 8; result[nContourPos + 1] = nc & 0xFF;
    }
    nContourPos += 2;

    if (g.composite) {
      result.set(glyfData.subarray(g.rawOffset, g.rawOffset + g.rawLength), glyphPos);
      glyphPos += g.rawLength;
      /** 优化291: bbox 四次 writeI16 内联为直接 view 写入 */
      result[bboxPos] = g.xMin >> 8; result[bboxPos + 1] = g.xMin & 0xFF;
      result[bboxPos + 2] = g.yMin >> 8; result[bboxPos + 3] = g.yMin & 0xFF;
      result[bboxPos + 4] = g.xMax >> 8; result[bboxPos + 5] = g.xMax & 0xFF;
      result[bboxPos + 6] = g.yMax >> 8; result[bboxPos + 7] = g.yMax & 0xFF;
      bboxPos += 8;
      if (g.haveInstructions) {
        const instrLen = g.instructions ? g.instructions.length : 0;
        if (instrLen > 0) {
          result.set(glyfData.subarray(g.instructions.offset, g.instructions.offset + instrLen), instrPos);
          instrPos += instrLen;
        }
        glyphPos += encode255UInt16(instrLen, result, glyphPos);
      }
      continue;
    }

    if (g.numberOfContours === 0) continue;

    /* 优化291: nPointsStream 直接编码到 result，消除临时 buffer 和 memcpy */
    const deltas = g.nPointsDeltas;
    const nc = g.numberOfContours;
    for (let c = 0; c < nc; c++) {
      nPointsPos += encode255UInt16(deltas[c], result, nPointsPos);
    }

    const instrLen = g.instructions ? g.instructions.length : 0;
    if (instrLen > 0) {
      result.set(glyfData.subarray(g.instructions.offset, g.instructions.offset + instrLen), instrPos);
      instrPos += instrLen;
    }

    /**
     * 优化291: flag + glyph 子流 — Pass 1 已预写入 glyphStreamBuf，直接 set 拷贝
     * flag stream 使用 TypedArray.set 替代逐字节循环
     */
    result.set(g.flags, flagPos);
    flagPos += g.flags.length;
    result.set(g.glyphStreamBuf.subarray(0, g.glyphStreamBytes), glyphPos);
    glyphPos += g.glyphStreamBytes;

    glyphPos += encode255UInt16(instrLen, result, glyphPos);

    if (bboxBitmap[gi >> 3] & (0x80 >> (gi & 7))) {
      /** 优化291: bbox 四次 writeI16 内联 */
      result[bboxPos] = g.calcXMin >> 8; result[bboxPos + 1] = g.calcXMin & 0xFF;
      result[bboxPos + 2] = g.calcYMin >> 8; result[bboxPos + 3] = g.calcYMin & 0xFF;
      result[bboxPos + 4] = g.calcXMax >> 8; result[bboxPos + 5] = g.calcXMax & 0xFF;
      result[bboxPos + 6] = g.calcYMax >> 8; result[bboxPos + 7] = g.calcYMax & 0xFF;
      bboxPos += 8;
    }
  }

  result.set(bboxBitmap, bboxBitmapStart);

  if (hasOverlapBitmap) {
    result.set(overlapBitmap, overlapBitmapStart);
  }

  const locaOrigLength = indexFormat === 0 ? (numGlyphs + 1) * 2 : (numGlyphs + 1) * 4;

  return {
    transformedGlyf: result,
    locaOrigLength,
    locaTransformLength: 0,
  };
}

/* ======== 主编码函数 ======== */

/** 优化242+262: 模块级排序函数，使用 tagU32 数值比较替代字符串比较 */
function sortDirEntries(a, b) {
  var d = a.tagIndex - b.tagIndex;
  return d ? d : (a.tagU32 < b.tagU32 ? -1 : a.tagU32 > b.tagU32 ? 1 : 0);
}

const WOFF2_SIGNATURE = 0x774F4632;
const WOFF2_HEADER_SIZE = 48;

/**
 * 将 TTF buffer 编码为 WOFF2 buffer
 */
function encodeTTFToWOFF2(ttfBuffer) {
  const data = ttfBuffer instanceof Uint8Array ? ttfBuffer : new Uint8Array(ttfBuffer);
  /** 优化222+242: 直接调用模块级函数，消除 .bind() 闭包分配 */
  /* 解析 sfnt header */
  const flavor = readU32(data, 0);
  const numTables = readU16(data, 4);

  /* 解析 Table Directory */
  /** 优化284: 预分配 tables 数组，索引赋值替代 push */
  const tables = new Array(numTables);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tagU32 = (data[off] << 24 | data[off + 1] << 16 | data[off + 2] << 8 | data[off + 3]) >>> 0;
    const offset = readU32(data, off + 8);
    const length = readU32(data, off + 12);
    tables[i] = { tagU32, offset, length, tagIndex: getTagIndexU32(tagU32) };
  }

  /* tag uint32 常量 */
  const TAG_DSIG = (68 << 24 | 83 << 16 | 73 << 8 | 71) >>> 0;
  const TAG_head = (104 << 24 | 101 << 16 | 97 << 8 | 100) >>> 0;
  const TAG_maxp = (109 << 24 | 97 << 16 | 120 << 8 | 112) >>> 0;
  const TAG_glyf = (103 << 24 | 108 << 16 | 121 << 8 | 102) >>> 0;
  const TAG_loca = (108 << 24 | 111 << 16 | 99 << 8 | 97) >>> 0;

  /* 移除 DSIG，按 tag 升序排列 */
  /** 优化284: 原地过滤替代 .filter()，消除中间数组分配 */
  let writeIdx = 0;
  for (let i = 0; i < numTables; i++) {
    if (tables[i].tagU32 !== TAG_DSIG) {
      tables[writeIdx++] = tables[i];
    }
  }
  tables.length = writeIdx;
  const filtered = tables;
  filtered.sort(sortDirEntries);

  /* 查找关键表 */
  let indexToLocFormat = 0;
  let numGlyphs = 0;
  let glyfTable = null;
  let locaTable = null;

  /* 优化: for...of → for 循环，消除迭代器协议开销 */
  for (var fi = 0, fl = filtered.length; fi < fl; fi++) {
    var t = filtered[fi];
    if (t.tagU32 === TAG_head) indexToLocFormat = readU16(data, t.offset + 50);
    if (t.tagU32 === TAG_maxp) numGlyphs = readU16(data, t.offset + 4);
    if (t.tagU32 === TAG_glyf) glyfTable = t;
    if (t.tagU32 === TAG_loca) locaTable = t;
  }

  /* glyf + loca 变换 */
  let glyfTransformed = null;
  if (glyfTable && locaTable) {
    const glyfData = data.subarray(glyfTable.offset, glyfTable.offset + glyfTable.length);
    const locaData = data.subarray(locaTable.offset, locaTable.offset + locaTable.length);
    const result = transformGlyfAndLoca(glyfData, locaData, indexToLocFormat, numGlyphs);
    glyfTransformed = result;
  }

  /* 构建 Table Directory entries */
  /** 优化284: 预分配 dirEntries 数组，索引赋值替代 push */
  const dirEntries = new Array(filtered.length);
  let dirIdx = 0;
  let totalDirSize = 0;

  for (var fi2 = 0, fl2 = filtered.length; fi2 < fl2; fi2++) {
    var t = filtered[fi2];
    if (t.tagU32 === TAG_loca) {
      /** 优化：直接使用 transformGlyfAndLoca 返回的 locaOrigLength，避免重复计算 */
      const origLength = glyfTransformed ? glyfTransformed.locaOrigLength : t.length;
      dirEntries[dirIdx++] = {
        tagU32: t.tagU32, tagIndex: t.tagIndex,
        flags: t.tagIndex,
        origLength,
        transformLength: 0,
        data: EMPTY_UINT8,
        hasTransform: true,
      };
      totalDirSize += 1 + sizeUIntBase128(origLength) + sizeUIntBase128(0);
      continue;
    }

    if (t.tagU32 === TAG_glyf && glyfTransformed) {
      dirEntries[dirIdx++] = {
        tagU32: t.tagU32, tagIndex: t.tagIndex,
        flags: t.tagIndex,
        origLength: t.length,
        transformLength: glyfTransformed.transformedGlyf.length,
        data: glyfTransformed.transformedGlyf,
        hasTransform: true,
      };
      totalDirSize += 1 + sizeUIntBase128(t.length) + sizeUIntBase128(glyfTransformed.transformedGlyf.length);
      continue;
    }

    let tableData = data.subarray(t.offset, t.offset + t.length);

    dirEntries[dirIdx++] = {
      tagU32: t.tagU32, tagIndex: t.tagIndex,
      flags: t.tagIndex,
      origLength: t.length,
      transformLength: t.length,
      data: tableData,
      isHead: t.tagU32 === TAG_head,
    };
    totalDirSize += 1 + sizeUIntBase128(t.length);
  }
  dirEntries.length = dirIdx;

  /* 计算 totalSfntSize */
  let totalSfntSize = 12 + filtered.length * 16;
  for (let i = 0; i < filtered.length; i++) {
    const len = filtered[i].length;
    totalSfntSize += len + (len & 3 ? 4 - (len & 3) : 0);
  }

  /* 拼接表数据 */
  let totalTableDataSize = 0;
  for (let i = 0; i < dirEntries.length; i++) totalTableDataSize += dirEntries[i].transformLength;
  const uncompressedData = new Uint8Array(totalTableDataSize);
  let dataPos = 0;
  /* 优化: for 循环替代 for...of，避免迭代器对象分配 */
  for (let di = 0; di < dirEntries.length; di++) {
    const entry = dirEntries[di];
    if (entry.transformLength > 0) {
      uncompressedData.set(entry.data, dataPos);
      if (entry.isHead) {
        /* 优化: 用 Uint8Array 直接写入替代 DataView，消除每次 head 表的 DataView 分配 */
        const base = dataPos;
        uncompressedData[base + 8] = uncompressedData[base + 9] = uncompressedData[base + 10] = uncompressedData[base + 11] = 0;
        const headFlags = (uncompressedData[base + 44] << 8) | uncompressedData[base + 45];
        const newFlags = headFlags | (1 << 11);
        uncompressedData[base + 44] = (newFlags >> 8) & 0xFF;
        uncompressedData[base + 45] = newFlags & 0xFF;
      }
      dataPos += entry.transformLength;
    }
  }

  /** 优化286: 复用 BROTLI_OPTIONS_WITH_HINT 模板，只修改 sizeHint 值，避免每次创建新 options */
  if (totalTableDataSize > 0) {
    BROTLI_OPTIONS_WITH_HINT.params[BROTLI_PARAM_SIZE_HINT] = totalTableDataSize;
    var brotliOptions = BROTLI_OPTIONS_WITH_HINT;
  } else {
    var brotliOptions = BROTLI_OPTIONS_BASE;
  }
  const compressedData = brotliCompressSync(uncompressedData, brotliOptions);

  /* 组装 WOFF2（预计算 padding，避免额外拷贝） */
  const rawLength = WOFF2_HEADER_SIZE + totalDirSize + compressedData.length;
  const paddedLength = (rawLength + 3) & ~3;
  const woff2 = new Uint8Array(paddedLength);
  /** 优化222+242: 直接调用模块级函数，消除 .bind() 闭包分配 */

  /* Header */
  writeU32(woff2, WOFF2_SIGNATURE, 0);
  writeU32(woff2, flavor, 4);
  writeU32(woff2, paddedLength, 8);
  writeU16(woff2, dirEntries.length, 12);
  writeU16(woff2, 0, 14);
  writeU32(woff2, totalSfntSize, 16);
  writeU32(woff2, compressedData.length, 20);
  writeU16(woff2, 1, 24);
  writeU16(woff2, 0, 26);
  writeU32(woff2, 0, 28);
  writeU32(woff2, 0, 32);
  writeU32(woff2, 0, 36);
  writeU32(woff2, 0, 40);
  writeU32(woff2, 0, 44);

  /* Table Directory */
  let dirPos = WOFF2_HEADER_SIZE;
  for (let di = 0; di < dirEntries.length; di++) {
    const entry = dirEntries[di];
    woff2[dirPos++] = entry.flags;
    if (entry.tagIndex === 63) {
      var tu = entry.tagU32;
      woff2[dirPos++] = (tu >>> 24) & 0xFF;
      woff2[dirPos++] = (tu >>> 16) & 0xFF;
      woff2[dirPos++] = (tu >>> 8) & 0xFF;
      woff2[dirPos++] = tu & 0xFF;
    }
    dirPos += encodeUIntBase128(entry.origLength, woff2, dirPos);
    if (entry.hasTransform) {
      dirPos += encodeUIntBase128(entry.transformLength, woff2, dirPos);
    }
  }

  /* 压缩数据 */
  woff2.set(compressedData, dirPos);

  /* WOFF2 规范要求文件大小 4 字节对齐（Round4）
     已在分配时预留 padding 空间，无需额外拷贝 */

  /** 优化267: 直接返回 Uint8Array，消除 woff2/index.js 的 new Uint8Array 包装 */
  return woff2;
}

module.exports = { encodeTTFToWOFF2 };
