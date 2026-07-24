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
 * Brotli 压缩参数：quality 2
 * WOFF2 是无损容器，Brotli 质量只影响压缩率不影响解码结果——SSIM 必然不变。
 * 实测千字文 woff2 端到端 + 体积（同文本）：
 *   q6=6.31ms/42712B  q3=4.65ms/42712B  q2=4.26ms/42752B  q1=4.21ms/46432B  q0=4.12ms/47240B
 * q2 是时间/体积最优拐点：比 q3 再省 8% 时间，体积仅 +0.09%（40 字节）。
 * q1/q0 体积陡增 +8.7%/+10.6%（下载/解析代价），不值。
 */
const BROTLI_OPTIONS_BASE = {
  params: { [BROTLI_PARAM_QUALITY]: 2 },
};
/** 优化: 预分配 options 模板，避免每次 encode 创建 computed property name 对象 */
const BROTLI_OPTIONS_WITH_HINT = {
  params: { [BROTLI_PARAM_QUALITY]: 2, [BROTLI_PARAM_SIZE_HINT]: 0 },
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

/* ======== glyf + loca 表变换 ======== */

/**
 * 优化301+312: 模块级复用 x 坐标缓冲区（y 已合并进 triplet 循环，不再需要 yCoords）
 * transformGlyfAndLoca 同步单线程调用，复用安全；按需扩容，不释放
 */
let _reuseXCoords = new Int32Array(256);
/** 优化301: 复用 encode255UInt16 的 3 字节编码缓冲区 */
const _reuseEnc255 = [0, 0, 0];

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
   * 优化294: flagStream/glyphStream/instructionStream 数据在 Pass 1 直接追加写入连续累积缓冲区，
   * 消除每个简单 glyph 的 flagsArr / glyphStreamBuf 分配，以及 Pass 2 的逐 glyph set 拷贝。
   * Pass 2 仅整体 set 三个累积缓冲区到 result 对应区域。
   * 优化295: 初始容量按 glyf 表大小预分配（triplet 数据 + flag 数据均不会超过原始 glyf 字节数），
   * 避免双倍扩容触发的多次分配+拷贝
   */
  const initialCap = glyfData.length;
  let flagAccumCap = initialCap;
  let flagAccum = new Uint8Array(flagAccumCap);
  let flagAccumLen = 0;
  let glyphAccumCap = initialCap;
  let glyphAccum = new Uint8Array(glyphAccumCap);
  let glyphAccumLen = 0;
  let instrAccumCap = 256;
  let instrAccum = new Uint8Array(instrAccumCap);
  let instrAccumLen = 0;

  let totalNPointsSize = 0;
  let glyphStreamSize = 0;
  let bboxStreamSize = 0;
  let hasOverlapBitmap = false;

  const bboxBitmapSize = ((numGlyphs + 31) >>> 5) << 2;
  const bboxBitmap = new Uint8Array(bboxBitmapSize);
  const overlapBitmap = new Uint8Array(bboxBitmapSize);

  /* 收集每个 glyph 的元数据（精简：仅 Pass 2 写 nContour/nPoints/bbox 所需字段） */
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
      let instrOffset = 0;

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
          instrOffset = compOff;
        } else {
          instrLength = 0;
        }
      }

      const rawOffset = glyphStart + 10;
      const rawLength = componentDataEnd - glyphStart - 10;

      glyphInfos[gi] = {
        composite: true,
        xMin, yMin, xMax, yMax,
        rawOffset,
        rawLength,
        instrOffset,
        instrLength,
      };

      /* ★ 复合 glyph 的统计量 + glyphStream 追加 rawData */
      bboxBitmap[gi >> 3] |= (0x80 >> (gi & 7));
      bboxStreamSize += 8;

      /* glyphAccum: 追加 raw 组件数据 */
      if (glyphAccumLen + rawLength > glyphAccumCap) {
        while (glyphAccumLen + rawLength > glyphAccumCap) glyphAccumCap *= 2;
        const nb = new Uint8Array(glyphAccumCap);
        nb.set(glyphAccum.subarray(0, glyphAccumLen));
        glyphAccum = nb;
      }
      glyphAccum.set(glyfData.subarray(rawOffset, rawOffset + rawLength), glyphAccumLen);
      glyphAccumLen += rawLength;
      glyphStreamSize += rawLength;

      if (instrLength > 0) {
        /* instructionAccum 追加 */
        if (instrAccumLen + instrLength > instrAccumCap) {
          while (instrAccumLen + instrLength > instrAccumCap) instrAccumCap *= 2;
          const ib = new Uint8Array(instrAccumCap);
          ib.set(instrAccum.subarray(0, instrAccumLen));
          instrAccum = ib;
        }
        instrAccum.set(glyfData.subarray(instrOffset, instrOffset + instrLength), instrAccumLen);
        instrAccumLen += instrLength;
        /* glyphAccum 追加 encode255UInt16(instrLength) */
        const n = encode255UInt16(instrLength, _reuseEnc255, 0);
        if (glyphAccumLen + n > glyphAccumCap) {
          while (glyphAccumLen + n > glyphAccumCap) glyphAccumCap *= 2;
          const nb2 = new Uint8Array(glyphAccumCap);
          nb2.set(glyphAccum.subarray(0, glyphAccumLen));
          glyphAccum = nb2;
        }
        for (let e = 0; e < n; e++) glyphAccum[glyphAccumLen++] = _reuseEnc255[e];
        glyphStreamSize += n;
      }
      continue;
    }

    /* 简单 glyph */
    let dataOff = glyphStart + 10;

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
    const instrOffset = dataOff;
    dataOff += instructionLength;

    /* instructionAccum 追加（简单 glyph 的指令） */
    if (instructionLength > 0) {
      if (instrAccumLen + instructionLength > instrAccumCap) {
        while (instrAccumLen + instructionLength > instrAccumCap) instrAccumCap *= 2;
        const ib = new Uint8Array(instrAccumCap);
        ib.set(instrAccum.subarray(0, instrAccumLen));
        instrAccum = ib;
      }
      instrAccum.set(glyfData.subarray(instrOffset, instrOffset + instructionLength), instrAccumLen);
      instrAccumLen += instructionLength;
    }

    const numPoints = numberOfContours > 0 ? lastEndPt + 1 : 0;

    /**
     * 优化294: flagsArr 直接写入 flagAccum（连续累积），不再分配独立 Uint8Array
     * 解码 flags 的同时检查 overlap 并写入 flagAccum
     */
    if (numberOfContours > 0) {
      /* 确保 flagAccum 容量 >= flagAccumLen + numPoints */
      if (flagAccumLen + numPoints > flagAccumCap) {
        while (flagAccumLen + numPoints > flagAccumCap) flagAccumCap *= 2;
        const fb = new Uint8Array(flagAccumCap);
        fb.set(flagAccum.subarray(0, flagAccumLen));
        flagAccum = fb;
      }
    }
    let hasOverlap = false;
    let fi = 0;
    /** flagWriteBase: 当前 glyph 的 flag 在 flagAccum 的起始位置（供 triplet 循环回写 triplet flag） */
    let flagWriteBase = flagAccumLen;
    while (fi < numPoints) {
      const flag = glyfData[dataOff++];
      if (flag & OVERLAP_FLAG) hasOverlap = true;
      flagAccum[flagAccumLen++] = flag;
      fi++;
      if (flag & REPEAT_FLAG && fi < numPoints) {
        const repeat = glyfData[dataOff++];
        const count = repeat < numPoints - fi ? repeat : numPoints - fi;
        flagAccum.fill(flag, flagAccumLen, flagAccumLen + count);
        flagAccumLen += count;
        fi += count;
      }
    }

    if (numberOfContours > 0) {
      if (hasOverlap) {
        hasOverlapBitmap = true;
        overlapBitmap[gi >> 3] |= (0x80 >> (gi & 7));
      }
    }

    /** 优化312: 合并 x 解码、y 解码、triplet 编码。
     *  原 3 次遍历（x→y→triplet）+ yCoords 数组；现 2 次遍历（x→y+triplet 合并），
     *  省掉 yCoords 数组分配/写入/读取 + 第三次 numPoints 遍历。
     *  关键洞察：triplet 的 delta 语义 = TTF 的 delta（都是相对前一点的差），所以
     *  解码 y 的同时用已存的 xCoords[i] 配对编码 triplet，无需 yCoords 中转。 */
    if (numPoints > _reuseXCoords.length) {
      const cap = _reuseXCoords.length;
      const newCap = cap * 2 > numPoints ? cap * 2 : numPoints;
      _reuseXCoords = new Int32Array(newCap);
    }
    const xCoords = _reuseXCoords;
    let px = 0;
    let calcXMin, calcXMax;
    /**
     * 优化302: 坐标解码用无分支取负
     * 中文字体 87% 的点为 short 模式，其中正负各半（50/50），
     * 原三元 `(f & XSAME) ? b : -b` 是 50/50 不可预测分支，被 V8 编译成条件跳转导致流水线冲刷。
     * 改用 sign 位乘法 `(b * 2 - 1)` 消除分支：XSAME=16(bit4)，sign=(f>>4)&1。
     */
    for (let xi = 0; xi < numPoints; xi++) {
      const f = flagAccum[flagWriteBase + xi];
      if (f & XSHORT_FLAG) {
        const b = glyfData[dataOff++];
        px += b * (((f >> 4) & 1) * 2 - 1);
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
    let calcYMin = 0, calcYMax = 0;

    if (numberOfContours > 0) {
      /** 优化312: bbox bitmap 判定拆分——x 在此先判，y 在合并循环算完后补判 */
      let bboxSet = !(calcXMin === xMin && calcXMax === xMax);

      /**
       * 优化294: triplet 数据直接追加写入 glyphAccum（连续累积），不再分配 per-glyph glyphStreamBuf
       * 每个 point 最多 4 数据字节，先确保容量再写入
       */
      const maxAdd = numPoints * 4;
      if (glyphAccumLen + maxAdd > glyphAccumCap) {
        while (glyphAccumLen + maxAdd > glyphAccumCap) glyphAccumCap *= 2;
        const nb = new Uint8Array(glyphAccumCap);
        nb.set(glyphAccum.subarray(0, glyphAccumLen));
        glyphAccum = nb;
      }
      const gsBase = glyphAccumLen;
      let gsbi = 0;
      let prevX = 0, prevY = 0;
      const _gs = glyphAccum;
      const _fa = flagAccum;
      const _fwb = flagWriteBase;
      const _gd = glyfData;
      let dyBboxUnset = true;
      /**
       * 优化312: y 解码 + triplet 编码合并为单循环。
       * py 从 TTF yCoord 字节流解码（累积绝对坐标），cx 从 xCoords 取（x 已在前一循环解好），
       * triplet delta = cx - prevX / py - prevY，当场编码写入 glyphAccum。
       * bbox_y 的 min/max 也在本循环同步计算（原在独立 y 循环）。
       */
      for (let yi = 0; yi < numPoints; yi++) {
        const f = _fa[_fwb + yi];
        if (f & YSHORT_FLAG) {
          const b = _gd[dataOff++];
          py += b * (((f >> 5) & 1) * 2 - 1);
        } else if (!(f & YSAME_FLAG)) {
          let dy0 = (_gd[dataOff] << 8) | _gd[dataOff + 1];
          if (dy0 > 0x7FFF) dy0 -= 0x10000;
          py += dy0;
          dataOff += 2;
        }
        if (dyBboxUnset) { calcYMin = py; calcYMax = py; dyBboxUnset = false; }
        else if (py < calcYMin) calcYMin = py;
        else if (py > calcYMax) calcYMax = py;

        /** triplet 编码（与原 calcTripletAndWrite inline 语义一致） */
        const cx = xCoords[yi];
        const cy = py;
        const curveBit = ((f & 1) ^ 1) << 7;
        const dx = cx - prevX;
        const dy = cy - prevY;
        const absDx = dx < 0 ? -dx : dx;
        const absDy = dy < 0 ? -dy : dy;
        const wpos = gsBase + gsbi;
        let flag;
        if (dx === 0 && absDy < 1280) {
          _gs[wpos] = absDy & 0xFF;
          flag = curveBit + ((absDy & 0xF00) >> 7) + (dy >= 0 ? 1 : 0);
        } else if (dy === 0 && dx !== 0 && absDx < 1280) {
          _gs[wpos] = absDx & 0xFF;
          flag = curveBit + 10 + ((absDx & 0xF00) >> 7) + (dx >= 0 ? 1 : 0);
        } else if (dx !== 0 && dy !== 0 && absDx < 65 && absDy < 65) {
          const ax = absDx - 1;
          const ay = absDy - 1;
          _gs[wpos] = ((ax & 0xF) << 4) | (ay & 0xF);
          const xSignBit = dx >= 0 ? 1 : 0;
          const ySignBit = dy >= 0 ? 1 : 0;
          flag = curveBit + 20 + (ax & 0x30) + ((ay & 0x30) >> 2) + xSignBit + 2 * ySignBit;
        } else if (dx !== 0 && dy !== 0 && absDx < 769 && absDy < 769) {
          const ax = absDx - 1;
          const ay = absDy - 1;
          _gs[wpos] = ax & 0xFF;
          _gs[wpos + 1] = ay & 0xFF;
          const xSignBit = dx >= 0 ? 1 : 0;
          const ySignBit = dy >= 0 ? 1 : 0;
          flag = curveBit + 84 + 12 * ((ax & 0x300) >> 8) + ((ay & 0x300) >> 6) + xSignBit + 2 * ySignBit;
        } else if (absDx < 4096 && absDy < 4096) {
          _gs[wpos] = absDx >> 4;
          _gs[wpos + 1] = ((absDx & 0xF) << 4) | (absDy >> 8);
          _gs[wpos + 2] = absDy & 0xFF;
          const xSignBit = dx >= 0 ? 1 : 0;
          const ySignBit = dy >= 0 ? 1 : 0;
          flag = curveBit + 120 + xSignBit + 2 * ySignBit;
        } else {
          _gs[wpos] = (absDx >> 8) & 0xFF;
          _gs[wpos + 1] = absDx & 0xFF;
          _gs[wpos + 2] = (absDy >> 8) & 0xFF;
          _gs[wpos + 3] = absDy & 0xFF;
          const xSignBit = dx >= 0 ? 1 : 0;
          const ySignBit = dy >= 0 ? 1 : 0;
          flag = curveBit + 124 + xSignBit + 2 * ySignBit;
        }
        /** triplet flag 回写到 flagAccum（flagStream 存 triplet flag 而非原始 flag） */
        _fa[_fwb + yi] = flag;
        gsbi += TRIPLET_DATA_SIZES[flag & 0x7F];
        prevX = cx;
        prevY = cy;
      }
      /** 优化312: y 的 bbox 匹配补判 */
      if (calcYMin !== yMin || calcYMax !== yMax) bboxSet = true;
      if (bboxSet) {
        bboxBitmap[gi >> 3] |= (0x80 >> (gi & 7));
        bboxStreamSize += 8;
      }
      glyphAccumLen += gsbi;
      glyphStreamSize += gsbi;

      /* glyphAccum 追加 encode255UInt16(instructionLength) */
      const n = encode255UInt16(instructionLength, _reuseEnc255, 0);
      if (glyphAccumLen + n > glyphAccumCap) {
        while (glyphAccumLen + n > glyphAccumCap) glyphAccumCap *= 2;
        const nb2 = new Uint8Array(glyphAccumCap);
        nb2.set(glyphAccum.subarray(0, glyphAccumLen));
        glyphAccum = nb2;
      }
      for (let e = 0; e < n; e++) glyphAccum[glyphAccumLen++] = _reuseEnc255[e];
      glyphStreamSize += n;
    } else {
      /** numberOfContours === 0 的空字形：仍需消费 yCoord 字节以推进 dataOff（保持原语义） */
      for (let yi0 = 0; yi0 < numPoints; yi0++) {
        const f = flagAccum[flagWriteBase + yi0];
        if (f & YSHORT_FLAG) {
          dataOff++;
        } else if (!(f & YSAME_FLAG)) {
          dataOff += 2;
        }
      }
    }

    glyphInfos[gi] = numberOfContours > 0
      ? {
          composite: false,
          numberOfContours,
          nPointsDeltas,
          calcXMin, calcYMin, calcXMax, calcYMax,
        }
      : {
          composite: false,
          numberOfContours: 0,
        };
  }

  const nContourStreamSize = numGlyphs * 2;
  const headerSize = 36;
  const flagStreamSize = flagAccumLen;
  const instructionStreamSize = instrAccumLen;
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

  /** 优化294: Pass 2 仅写 nContourStream/nPointsStream/bboxStream，flag/glyph/instruction 整体 set */
  let bboxPos = bboxStreamStart;

  for (let gi = 0; gi < numGlyphs; gi++) {
    const g = glyphInfos[gi];

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
      result[bboxPos] = g.xMin >> 8; result[bboxPos + 1] = g.xMin & 0xFF;
      result[bboxPos + 2] = g.yMin >> 8; result[bboxPos + 3] = g.yMin & 0xFF;
      result[bboxPos + 4] = g.xMax >> 8; result[bboxPos + 5] = g.xMax & 0xFF;
      result[bboxPos + 6] = g.yMax >> 8; result[bboxPos + 7] = g.yMax & 0xFF;
      bboxPos += 8;
      continue;
    }

    if (g.numberOfContours === 0) continue;

    const deltas = g.nPointsDeltas;
    const nc = g.numberOfContours;
    for (let c = 0; c < nc; c++) {
      nPointsPos += encode255UInt16(deltas[c], result, nPointsPos);
    }

    if (bboxBitmap[gi >> 3] & (0x80 >> (gi & 7))) {
      result[bboxPos] = g.calcXMin >> 8; result[bboxPos + 1] = g.calcXMin & 0xFF;
      result[bboxPos + 2] = g.calcYMin >> 8; result[bboxPos + 3] = g.calcYMin & 0xFF;
      result[bboxPos + 4] = g.calcXMax >> 8; result[bboxPos + 5] = g.calcXMax & 0xFF;
      result[bboxPos + 6] = g.calcYMax >> 8; result[bboxPos + 7] = g.calcYMax & 0xFF;
      bboxPos += 8;
    }
  }

  /** 优化294: 三个累积缓冲区整体拷贝到 result 对应区域（单次 set 替代 per-glyph set） */
  result.set(flagAccum.subarray(0, flagStreamSize), flagStreamStart);
  result.set(glyphAccum.subarray(0, glyphStreamSize), glyphStreamStart);
  if (instructionStreamSize > 0) {
    result.set(instrAccum.subarray(0, instructionStreamSize), instructionStreamStart);
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

  /**
   * 计算单个 Table Directory entry 的序列化字节数
   * WOFF2 规范: flags(1) + (tagIndex===63 时追加 4 字节原始 tag) + origLength(Base128) + (hasTransform 时 transformLength(Base128))
   *
   * 修复: tagIndex===63（表名不在已知 63 个表内，如 GPOS/gasp/GDEF）时必须额外写 4 字节 tag。
   *      原实现漏算这 4 字节，导致含此类表的字体（如开启 kerning 保留 GPOS 后）woff2 buffer 预分配不足，
   *      woff2.set(compressedData, dirPos) 越界。
   */
  const entrySize = (tagIndex, origLength, hasTransform, transformLength) =>
    1
    + (tagIndex === 63 ? 4 : 0)
    + sizeUIntBase128(origLength)
    + (hasTransform ? sizeUIntBase128(transformLength) : 0);

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
      totalDirSize += entrySize(t.tagIndex, origLength, true, 0);
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
      totalDirSize += entrySize(t.tagIndex, t.length, true, glyfTransformed.transformedGlyf.length);
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
    totalDirSize += entrySize(t.tagIndex, t.length, false, t.length);
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
