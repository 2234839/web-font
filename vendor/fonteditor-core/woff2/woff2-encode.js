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

/** 向 Uint8Array 写入有符号 16 位大端序 */
function writeI16(buf, v, p) { buf[p] = v >> 8; buf[p + 1] = v & 0xFF; }

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
 * 从 4 字节 tag 获取 Known Table Tag 索引
 */
function getTagIndex(tag) {
  const idx = KNOWN_TAG_MAP.get(tag);
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
  buf[offset + 1] = (value >> 8) & 0xFF;
  buf[offset + 2] = value & 0xFF;
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
function dataSizeFromTriplet(ti) {
  return TRIPLET_DATA_SIZES[ti];
}

/**
 * 仅计算 triplet flag 字节，不写入数据
 * 优化: Pass 1 只需要 flag，数据写入由 Pass 2 的 writePointDataByFlag 完成
 */
function calcTripletFlag(onCurve, dx, dy) {
  const curveBit = onCurve ? 0 : 128;
  const absDx = dx < 0 ? -dx : dx;
  const absDy = dy < 0 ? -dy : dy;
  const xSignBit = dx >= 0 ? 1 : 0;
  const ySignBit = dy >= 0 ? 1 : 0;
  const xySignBits = xSignBit + 2 * ySignBit;

  /* dx=0, Y 单轴 1 数据字节 (flag 0-9) */
  if (dx === 0 && absDy < 1280) {
    return curveBit + ((absDy & 0xF00) >> 7) + ySignBit;
  }

  /* dy=0, dx≠0, X 单轴 1 数据字节 (flag 10-19) */
  if (dy === 0 && dx !== 0 && absDx < 1280) {
    return curveBit + 10 + ((absDx & 0xF00) >> 7) + xSignBit;
  }

  /* 双轴 1 数据字节 (flag 20-83): 1 ≤ |dx| ≤ 64, 1 ≤ |dy| ≤ 64 */
  if (dx !== 0 && dy !== 0 && absDx < 65 && absDy < 65) {
    const ax = absDx - 1;
    const ay = absDy - 1;
    return curveBit + 20 + (ax & 0x30) + ((ay & 0x30) >> 2) + xySignBits;
  }

  /* 双轴 2 数据字节 (flag 84-119): 1 ≤ |dx| ≤ 768, 1 ≤ |dy| ≤ 768 */
  if (dx !== 0 && dy !== 0 && absDx < 769 && absDy < 769) {
    const ax = absDx - 1;
    const ay = absDy - 1;
    return curveBit + 84 + 12 * ((ax & 0x300) >> 8) + ((ay & 0x300) >> 6) + xySignBits;
  }

  /* 双轴 3 数据字节 (flag 120-123) */
  if (absDx < 4096 && absDy < 4096) {
    return curveBit + 120 + xySignBits;
  }

  /* 兜底 4 数据字节 (flag 124-127) */
  return curveBit + 124 + xySignBits;
}

/**
 * 仅写入数据字节（不含 flag），利用缓存的 flag 值避免重复分支判断
 * flag 的低 7 位 (tripletIndex) 决定数据字节布局
 * 优化182: 返回写入的字节数，消除调用方 TRIPLET_DATA_SIZES 重复查找
 */
function writePointDataByFlag(flag, dx, dy, buf, offset) {
  const ti = flag & 0x7F;
  const absDx = dx < 0 ? -dx : dx;
  const absDy = dy < 0 ? -dy : dy;

  if (ti < 10) {
    /* Y 单轴 1 字节 */
    buf[offset] = absDy & 0xFF;
    return 1;
  } else if (ti < 20) {
    /* X 单轴 1 字节 */
    buf[offset] = absDx & 0xFF;
    return 1;
  } else if (ti < 84) {
    /* 双轴 1 字节 */
    const ax = absDx - 1;
    const ay = absDy - 1;
    buf[offset] = ((ax & 0xF) << 4) | (ay & 0xF);
    return 1;
  } else if (ti < 120) {
    /* 双轴 2 字节 */
    const ax = absDx - 1;
    const ay = absDy - 1;
    buf[offset] = ax & 0xFF;
    buf[offset + 1] = ay & 0xFF;
    return 2;
  } else if (ti < 124) {
    /* 双轴 3 字节 */
    buf[offset] = absDx >> 4;
    buf[offset + 1] = ((absDx & 0xF) << 4) | (absDy >> 8);
    buf[offset + 2] = absDy & 0xFF;
    return 3;
  } else {
    /* 兜底 4 字节 */
    buf[offset] = (absDx >> 8) & 0xFF;
    buf[offset + 1] = absDx & 0xFF;
    buf[offset + 2] = (absDy >> 8) & 0xFF;
    buf[offset + 3] = absDy & 0xFF;
    return 4;
  }
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

    /** 优化226: 合并 endPts 读取与 nPoints 编码，消除 endPtsOfContours TypedArray 分配 */
    const nPointsEncoded = new Uint8Array(numberOfContours * 3);
    let nPointsBytes = 0;
    let prevEnd = -1;
    let lastEndPt = -1;
    for (let c = 0; c < numberOfContours; c++) {
      const endPt = readU16(glyfData, dataOff);
      dataOff += 2;
      nPointsBytes += encode255UInt16(endPt - prevEnd, nPointsEncoded, nPointsBytes);
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

    /* 解码 X 坐标 */
    const xCoords = new Int32Array(numPoints);
    let px = 0;
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
    }

    /* 解码 Y 坐标 + 同时计算 bbox */
    const yCoords = new Int32Array(numPoints);
    let py = 0;
    let calcXMin = xCoords[0], calcYMin = py, calcXMax = xCoords[0], calcYMax = py;
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
      const px2 = xCoords[yi];
      if (px2 < calcXMin) calcXMin = px2;
      else if (px2 > calcXMax) calcXMax = px2;
      if (py < calcYMin) calcYMin = py;
      else if (py > calcYMax) calcYMax = py;
    }

    /* 优化183: 就地覆盖 flagsArr 为 triplet flags，省掉单独的 cachedFlags 分配 */
    if (numberOfContours > 0) {
      const bboxMatches = calcXMin === xMin && calcYMin === yMin && calcXMax === xMax && calcYMax === yMax;
      if (!bboxMatches) {
        bboxBitmap[gi >> 3] |= (0x80 >> (gi & 7));
        bboxStreamSize += 8;
      }

      /** 优化: Pass 1 就地覆盖 xCoords/yCoords 为 delta，消除 Pass 2 重复减法 */
      let prevX = 0, prevY = 0;
      for (let pi = 0; pi < numPoints; pi++) {
        const onCurve = !!(flagsArr[pi] & ONCURVE_FLAG);
        const dx = xCoords[pi] - prevX;
        const dy = yCoords[pi] - prevY;
        const flag = calcTripletFlag(onCurve, dx, dy);
        flagsArr[pi] = flag;
        xCoords[pi] = dx;
        yCoords[pi] = dy;
        glyphStreamSize += TRIPLET_DATA_SIZES[flag & 0x7F];
        prevX += dx;
        prevY += dy;
      }
      glyphStreamSize += size255UInt16(instructionLength);
    }

    /* 优化: 仅存储 Pass 2 实际需要的字段，减少对象大小 */
    glyphInfos[gi] = {
      composite: false,
      numberOfContours,
      nPointsEncoded,
      nPointsBytes,
      instructions,
      xCoords, yCoords, flags: flagsArr,
      calcXMin, calcYMin, calcXMax, calcYMax,
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
    if (!g) {
      writeI16(result, 0, nContourPos); nContourPos += 2;
      continue;
    }
    if (g.composite) {
      writeI16(result, -1, nContourPos); nContourPos += 2;
    } else {
      writeI16(result, g.numberOfContours, nContourPos); nContourPos += 2;
    }

    if (g.composite) {
      result.set(glyfData.subarray(g.rawOffset, g.rawOffset + g.rawLength), glyphPos);
      glyphPos += g.rawLength;
      writeI16(result, g.xMin, bboxPos); bboxPos += 2;
      writeI16(result, g.yMin, bboxPos); bboxPos += 2;
      writeI16(result, g.xMax, bboxPos); bboxPos += 2;
      writeI16(result, g.yMax, bboxPos); bboxPos += 2;
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

    /* nPointsStream: 直接使用预编码的 delta 数据 */
    result.set(g.nPointsEncoded.subarray(0, g.nPointsBytes), nPointsPos);
    nPointsPos += g.nPointsBytes;

    const instrLen = g.instructions ? g.instructions.length : 0;
    if (instrLen > 0) {
      result.set(glyfData.subarray(g.instructions.offset, g.instructions.offset + instrLen), instrPos);
      instrPos += instrLen;
    }

    /**
     * flag + glyph 子流 — xCoords/yCoords 已在 Pass 1 就地覆盖为 delta
     * 直接读取 delta，消除 prevX/prevY 追踪和减法运算
     */
    const numPts = g.xCoords.length;
    const xCoords = g.xCoords;
    const yCoords = g.yCoords;
    const tripletFlags = g.flags;
    for (let pi = 0; pi < numPts; pi++) {
      const flag = tripletFlags[pi];
      result[flagPos++] = flag;
      glyphPos += writePointDataByFlag(flag, xCoords[pi], yCoords[pi], result, glyphPos);
    }

    glyphPos += encode255UInt16(instrLen, result, glyphPos);

    if (bboxBitmap[gi >> 3] & (0x80 >> (gi & 7))) {
      writeI16(result, g.calcXMin, bboxPos); bboxPos += 2;
      writeI16(result, g.calcYMin, bboxPos); bboxPos += 2;
      writeI16(result, g.calcXMax, bboxPos); bboxPos += 2;
      writeI16(result, g.calcYMax, bboxPos); bboxPos += 2;
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

/** 优化242: 模块级排序函数，避免每次 encodeTTFToWOFF2 创建闭包 */
function sortDirEntries(a, b) {
  var d = a.tagIndex - b.tagIndex;
  return d ? d : (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
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
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
    const offset = readU32(data, off + 8);
    const length = readU32(data, off + 12);
    tables.push({ tag, offset, length, tagIndex: getTagIndex(tag) });
  }

  /* 移除 DSIG，按 tag 升序排列 */
  const filtered = tables.filter(t => t.tag !== "DSIG");
  filtered.sort(sortDirEntries);

  /* 查找关键表 */
  let indexToLocFormat = 0;
  let numGlyphs = 0;
  let glyfTable = null;
  let locaTable = null;

  /* 优化: for...of → for 循环，消除迭代器协议开销 */
  for (var fi = 0, fl = filtered.length; fi < fl; fi++) {
    var t = filtered[fi];
    if (t.tag === "head") indexToLocFormat = readU16(data, t.offset + 50);
    if (t.tag === "maxp") numGlyphs = readU16(data, t.offset + 4);
    if (t.tag === "glyf") glyfTable = t;
    if (t.tag === "loca") locaTable = t;
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
  const dirEntries = [];
  let totalDirSize = 0;

  for (var fi2 = 0, fl2 = filtered.length; fi2 < fl2; fi2++) {
    var t = filtered[fi2];
    if (t.tag === "loca") {
      /** 优化：直接使用 transformGlyfAndLoca 返回的 locaOrigLength，避免重复计算 */
      const origLength = glyfTransformed ? glyfTransformed.locaOrigLength : t.length;
      dirEntries.push({
        tag: t.tag, tagIndex: t.tagIndex,
        flags: t.tagIndex,
        origLength,
        transformLength: 0,
        data: EMPTY_UINT8,
        hasTransform: true,
      });
      totalDirSize += 1 + sizeUIntBase128(origLength) + sizeUIntBase128(0);
      continue;
    }

    if (t.tag === "glyf" && glyfTransformed) {
      dirEntries.push({
        tag: t.tag, tagIndex: t.tagIndex,
        flags: t.tagIndex,
        origLength: t.length,
        transformLength: glyfTransformed.transformedGlyf.length,
        data: glyfTransformed.transformedGlyf,
        hasTransform: true,
      });
      totalDirSize += 1 + sizeUIntBase128(t.length) + sizeUIntBase128(glyfTransformed.transformedGlyf.length);
      continue;
    }

    let tableData = data.subarray(t.offset, t.offset + t.length);

    dirEntries.push({
      tag: t.tag, tagIndex: t.tagIndex,
      flags: t.tagIndex,
      origLength: t.length,
      transformLength: t.length,
      data: tableData,
      isHead: t.tag === "head",
    });
    totalDirSize += 1 + sizeUIntBase128(t.length);
  }

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

  /* Brotli 压缩，传入 SIZE_HINT 帮助预分配内部缓冲区 */
  if (totalTableDataSize > 0) BROTLI_OPTIONS_WITH_HINT.params[BROTLI_PARAM_SIZE_HINT] = totalTableDataSize;
  const compressedData = brotliCompressSync(uncompressedData, totalTableDataSize > 0 ? BROTLI_OPTIONS_WITH_HINT : BROTLI_OPTIONS_BASE);

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
      for (let ci = 0; ci < 4; ci++) woff2[dirPos++] = entry.tag.charCodeAt(ci);
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

  return woff2.buffer;
}

module.exports = { encodeTTFToWOFF2 };
