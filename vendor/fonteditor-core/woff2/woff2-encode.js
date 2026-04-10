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

/** 编码 UIntBase128（最多 5 字节，高位在前） */
function encodeUIntBase128(value, buf, offset) {
  const size = calcUIntBase128Size(value);
  let pos = offset;
  for (let i = size - 1; i >= 0; i--) {
    const byte = (value >>> (7 * i)) & 0x7F;
    if (i > 0) {
      buf[pos++] = byte | 0x80;
    } else {
      buf[pos++] = byte;
    }
  }
  return size;
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
 * 编码一个点到 glyphStream，返回 triplet flag 字节
 * 直接写入 buf，不分配数组
 */
function encodePointToBuf(onCurve, dx, dy, buf, offset) {
  const curveBit = onCurve ? 0 : 128;
  const absDx = dx < 0 ? -dx : dx;
  const absDy = dy < 0 ? -dy : dy;
  const xSignBit = dx >= 0 ? 1 : 0;
  const ySignBit = dy >= 0 ? 1 : 0;
  const xySignBits = xSignBit + 2 * ySignBit;

  /* dx=0, Y 单轴 1 数据字节 (flag 0-9) */
  if (dx === 0 && absDy < 1280) {
    const flag = curveBit + ((absDy & 0xF00) >> 7) + ySignBit;
    buf[offset] = absDy & 0xFF;
    return flag;
  }

  /* dy=0, dx≠0, X 单轴 1 数据字节 (flag 10-19) */
  if (dy === 0 && dx !== 0 && absDx < 1280) {
    const flag = curveBit + 10 + ((absDx & 0xF00) >> 7) + xSignBit;
    buf[offset] = absDx & 0xFF;
    return flag;
  }

  /* 双轴 1 数据字节 (flag 20-83): 1 ≤ |dx| ≤ 64, 1 ≤ |dy| ≤ 64 */
  if (dx !== 0 && dy !== 0 && absDx < 65 && absDy < 65) {
    const ax = absDx - 1;
    const ay = absDy - 1;
    const flag = curveBit + 20 + (ax & 0x30) + ((ay & 0x30) >> 2) + xySignBits;
    buf[offset] = ((ax & 0xF) << 4) | (ay & 0xF);
    return flag;
  }

  /* 双轴 2 数据字节 (flag 84-119): 1 ≤ |dx| ≤ 768, 1 ≤ |dy| ≤ 768 */
  if (dx !== 0 && dy !== 0 && absDx < 769 && absDy < 769) {
    const ax = absDx - 1;
    const ay = absDy - 1;
    const flag = curveBit + 84 + 12 * ((ax & 0x300) >> 8) + ((ay & 0x300) >> 6) + xySignBits;
    buf[offset] = ax & 0xFF;
    buf[offset + 1] = ay & 0xFF;
    return flag;
  }

  /* 双轴 3 数据字节 (flag 120-123) */
  if (absDx < 4096 && absDy < 4096) {
    const flag = curveBit + 120 + xySignBits;
    buf[offset] = absDx >> 4;
    buf[offset + 1] = ((absDx & 0xF) << 4) | (absDy >> 8);
    buf[offset + 2] = absDy & 0xFF;
    return flag;
  }

  /* 兜底 4 数据字节 (flag 124-127) */
  const flag = curveBit + 124 + xySignBits;
  buf[offset] = (absDx >> 8) & 0xFF;
  buf[offset + 1] = absDx & 0xFF;
  buf[offset + 2] = (absDy >> 8) & 0xFF;
  buf[offset + 3] = absDy & 0xFF;
  return flag;
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
  const glyfView = new DataView(glyfData.buffer, glyfData.byteOffset, glyfData.byteLength);
  const locaView = new DataView(locaData.buffer, locaData.byteOffset, locaData.byteLength);

  /* 读取 loca 表获取每个 glyph 的偏移 */
  const offsets = new Int32Array(numGlyphs + 1);
  if (indexFormat === 0) {
    for (let i = 0; i <= numGlyphs; i++) {
      offsets[i] = locaView.getUint16(i * 2, false) * 2;
    }
  } else {
    for (let i = 0; i <= numGlyphs; i++) {
      offsets[i] = locaView.getUint32(i * 4, false);
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

  const bboxBitmapSize = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = new Uint8Array(bboxBitmapSize);
  const overlapBitmap = new Uint8Array(bboxBitmapSize);
  const tmpBuf = new Uint8Array(4);

  /* 收集每个 glyph 的信息 */
  const glyphInfos = new Array(numGlyphs);

  for (let gi = 0; gi < numGlyphs; gi++) {
    const glyphStart = offsets[gi];
    const glyphEnd = offsets[gi + 1];

    if (glyphStart === glyphEnd) {
      glyphInfos[gi] = null;
      continue;
    }

    const numberOfContours = glyfView.getInt16(glyphStart, false);
    const xMin = glyfView.getInt16(glyphStart + 2, false);
    const yMin = glyfView.getInt16(glyphStart + 4, false);
    const xMax = glyfView.getInt16(glyphStart + 6, false);
    const yMax = glyfView.getInt16(glyphStart + 8, false);

    if (numberOfContours < 0) {
      /* 复合 glyph */
      let compOff = glyphStart + 10;
      let haveInstructions = false;
      let instrLength = 0;
      let instructions = null;

      const MORE_COMPONENTS = 0x0020;
      const WE_HAVE_INSTRUCTIONS = 0x0100;
      while (compOff < glyphEnd) {
        const compFlags = glyfView.getUint16(compOff, false);
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
        instrLength = glyfView.getUint16(compOff, false);
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

    const endPtsOfContours = new Uint16Array(numberOfContours);
    for (let c = 0; c < numberOfContours; c++) {
      endPtsOfContours[c] = glyfView.getUint16(dataOff, false);
      dataOff += 2;
    }

    /* ★ 合并：totalNPointsSize 计算 + 缓存 255UInt16 编码结果 */
    const nPointsEncoded = new Uint8Array(numberOfContours * 3);
    let nPointsBytes = 0;
    let prevEnd = -1;
    for (let c = 0; c < numberOfContours; c++) {
      nPointsBytes += encode255UInt16(endPtsOfContours[c] - prevEnd, nPointsEncoded, nPointsBytes);
      prevEnd = endPtsOfContours[c];
    }
    totalNPointsSize += nPointsBytes;

    const instructionLength = glyfView.getUint16(dataOff, false);
    dataOff += 2;
    const instructions = instructionLength > 0 ? { offset: dataOff, length: instructionLength } : null;
    dataOff += instructionLength;

    /* ★ 合并：instructionStreamSize 累加 */
    instructionStreamSize += instructionLength;

    const numPoints = numberOfContours > 0 ? endPtsOfContours[numberOfContours - 1] + 1 : 0;

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
        const count = Math.min(repeat, numPoints - fi);
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

      let prevX = 0, prevY = 0;
      for (let pi = 0; pi < numPoints; pi++) {
        const onCurve = !!(flagsArr[pi] & ONCURVE_FLAG);
        const dx = xCoords[pi] - prevX;
        const dy = yCoords[pi] - prevY;
        const flag = encodePointToBuf(onCurve, dx, dy, tmpBuf, 0);
        flagsArr[pi] = flag;
        glyphStreamSize += TRIPLET_DATA_SIZES[flag & 0x7F];
        prevX = xCoords[pi];
        prevY = yCoords[pi];
      }
      glyphStreamSize += size255UInt16(instructionLength);
    }

    glyphInfos[gi] = {
      composite: false,
      numberOfContours,
      nPointsEncoded,
      nPointsBytes,
      instructions,
      xCoords, yCoords, flags: flagsArr,
      hasOverlap,
      xMin, yMin, xMax, yMax,
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
  const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
  let pos = 0;

  /* Header */
  resultView.setUint16(pos, 0, false); pos += 2;
  resultView.setUint16(pos, hasOverlapBitmap ? 1 : 0, false); pos += 2;
  resultView.setUint16(pos, numGlyphs, false); pos += 2;
  resultView.setUint16(pos, indexFormat, false); pos += 2;
  resultView.setUint32(pos, nContourStreamSize, false); pos += 4;
  resultView.setUint32(pos, totalNPointsSize, false); pos += 4;
  resultView.setUint32(pos, flagStreamSize, false); pos += 4;
  resultView.setUint32(pos, glyphStreamSize, false); pos += 4;
  resultView.setUint32(pos, 0, false); pos += 4;
  resultView.setUint32(pos, bboxBitmapSize + bboxStreamSize, false); pos += 4;
  resultView.setUint32(pos, instructionStreamSize, false); pos += 4;

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
      resultView.setInt16(nContourPos, 0, false); nContourPos += 2;
      continue;
    }
    if (g.composite) {
      resultView.setInt16(nContourPos, -1, false); nContourPos += 2;
    } else {
      resultView.setInt16(nContourPos, g.numberOfContours, false); nContourPos += 2;
    }

    if (g.composite) {
      result.set(glyfData.subarray(g.rawOffset, g.rawOffset + g.rawLength), glyphPos);
      glyphPos += g.rawLength;
      resultView.setInt16(bboxPos, g.xMin, false); bboxPos += 2;
      resultView.setInt16(bboxPos, g.yMin, false); bboxPos += 2;
      resultView.setInt16(bboxPos, g.xMax, false); bboxPos += 2;
      resultView.setInt16(bboxPos, g.yMax, false); bboxPos += 2;
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
     * flag + glyph 子流 — 使用缓存的 triplet flag + writePointDataByFlag
     * 避免写入阶段的完整分支判断链（6 层 if-else），改用 flag 值直接定位数据布局
     */
    const numPts = g.xCoords.length;
    const xCoords = g.xCoords;
    const yCoords = g.yCoords;
    const tripletFlags = g.flags;
    let prevX = 0, prevY = 0;
    for (let pi = 0; pi < numPts; pi++) {
      const dx = xCoords[pi] - prevX;
      const dy = yCoords[pi] - prevY;
      const flag = tripletFlags[pi];
      result[flagPos++] = flag;
      glyphPos += writePointDataByFlag(flag, dx, dy, result, glyphPos);
      prevX = xCoords[pi];
      prevY = yCoords[pi];
    }

    glyphPos += encode255UInt16(instrLen, result, glyphPos);

    if (bboxBitmap[gi >> 3] & (0x80 >> (gi & 7))) {
      resultView.setInt16(bboxPos, g.calcXMin, false); bboxPos += 2;
      resultView.setInt16(bboxPos, g.calcYMin, false); bboxPos += 2;
      resultView.setInt16(bboxPos, g.calcXMax, false); bboxPos += 2;
      resultView.setInt16(bboxPos, g.calcYMax, false); bboxPos += 2;
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

const WOFF2_SIGNATURE = 0x774F4632;
const WOFF2_HEADER_SIZE = 48;

/**
 * 将 TTF buffer 编码为 WOFF2 buffer
 */
function encodeTTFToWOFF2(ttfBuffer) {
  const data = ttfBuffer instanceof Uint8Array ? ttfBuffer : new Uint8Array(ttfBuffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  /* 解析 sfnt header */
  const flavor = view.getUint32(0, false);
  const numTables = view.getUint16(4, false);

  /* 解析 Table Directory */
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
    const offset = view.getUint32(off + 8, false);
    const length = view.getUint32(off + 12, false);
    tables.push({ tag, offset, length, tagIndex: getTagIndex(tag) });
  }

  /* 移除 DSIG，按 tag 升序排列 */
  const filtered = tables.filter(t => t.tag !== "DSIG");
  filtered.sort((a, b) => a.tagIndex - b.tagIndex || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  /* 查找关键表 */
  let indexToLocFormat = 0;
  let numGlyphs = 0;
  let glyfTable = null;
  let locaTable = null;

  for (const t of filtered) {
    if (t.tag === "head") indexToLocFormat = view.getUint16(t.offset + 50, false);
    if (t.tag === "maxp") numGlyphs = view.getUint16(t.offset + 4, false);
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

  for (const t of filtered) {
    if (t.tag === "loca") {
      /** 优化：直接使用 transformGlyfAndLoca 返回的 locaOrigLength，避免重复计算 */
      const origLength = glyfTransformed ? glyfTransformed.locaOrigLength : t.length;
      dirEntries.push({
        tag: t.tag, tagIndex: t.tagIndex,
        flags: t.tagIndex,
        origLength,
        transformLength: 0,
        data: new Uint8Array(0),
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
  for (const entry of dirEntries) {
    if (entry.transformLength > 0) {
      uncompressedData.set(entry.data, dataPos);
      if (entry.isHead) {
        /* head 表原地修改：清零 checkSumAdjustment，设置 bit 11（headFlags），避免额外拷贝 */
        const uView = new DataView(uncompressedData.buffer, uncompressedData.byteOffset + dataPos, entry.transformLength);
        uView.setUint32(8, 0, false);
        const headFlags = uView.getUint16(44, false);
        uView.setUint16(44, headFlags | (1 << 11), false);
      }
      dataPos += entry.transformLength;
    }
  }

  /* Brotli 压缩，传入 SIZE_HINT 帮助预分配内部缓冲区 */
  const brotliOptions = totalTableDataSize > 0
    ? { params: {
        [BROTLI_PARAM_QUALITY]: 8,
        [BROTLI_PARAM_SIZE_HINT]: totalTableDataSize,
      }}
    : BROTLI_OPTIONS_BASE;
  const compressedData = brotliCompressSync(uncompressedData, brotliOptions);

  /* 组装 WOFF2（预计算 padding，避免额外拷贝） */
  const rawLength = WOFF2_HEADER_SIZE + totalDirSize + compressedData.length;
  const paddedLength = (rawLength + 3) & ~3;
  const woff2 = new Uint8Array(paddedLength);
  const woff2View = new DataView(woff2.buffer, woff2.byteOffset, woff2.byteLength);

  /* Header */
  woff2View.setUint32(0, WOFF2_SIGNATURE, false);
  woff2View.setUint32(4, flavor, false);
  woff2View.setUint32(8, paddedLength, false);
  woff2View.setUint16(12, dirEntries.length, false);
  woff2View.setUint16(14, 0, false);
  woff2View.setUint32(16, totalSfntSize, false);
  woff2View.setUint32(20, compressedData.length, false);
  woff2View.setUint16(24, 1, false);
  woff2View.setUint16(26, 0, false);
  woff2View.setUint32(28, 0, false);
  woff2View.setUint32(32, 0, false);
  woff2View.setUint32(36, 0, false);
  woff2View.setUint32(40, 0, false);
  woff2View.setUint32(44, 0, false);

  /* Table Directory */
  let dirPos = WOFF2_HEADER_SIZE;
  for (const entry of dirEntries) {
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
