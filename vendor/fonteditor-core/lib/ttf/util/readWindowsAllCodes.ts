/* eslint-disable */

/**
 * @file 读取windows支持的字符集
 * @author mengke01(kekee000@gmail.com)
 */

/** cmap 子表（各格式字段的鸭子类型集合，未用到的字段为 undefined） */
interface CmapSubTable {
  platformID?: number;
  encodingID?: number;
  format?: number;
  nGroups?: number;
  groups?: any;
  _flatGroups?: boolean;
  segCountX2?: number;
  segCount?: number;
  startCode?: number[];
  endCode?: number[];
  idDelta?: number[];
  idRangeOffset?: number[];
  glyphIdArray?: number[];
  glyphIdArrayIndexOffset?: number;
  glyphIdArrayOffset?: number;
  idRangeOffsetOffset?: number;
  _lazySegs?: boolean;
  _cmapView?: DataView;
  _endCodeOff?: number;
  _startCodeOff?: number;
  _idDeltaOff?: number;
  _idRangeOffsetOff?: number;
  _lazyGroups?: boolean;
  _groupsOffset?: number;
  subHeadKeys?: number[];
  subHeads?: any[];
  glyphs?: number[];
  maxPos?: number;
}

/** 读取上下文 ttf 对象（仅消费 readOptions 与 maxp） */
interface ReadTtf {
  readOptions?: {
    subset?: number[];
    presetCmap?: Record<number, number>;
    [key: string]: any;
  };
  maxp?: { numGlyphs?: number };
}

/**
 * 优化65+88: format12 二分查找，支持扁平数组格式
 * 优化300: 支持 _lazyGroups 延迟模式，直接从 view 二分查找（每 group 12 字节、已升序）
 *
 * @param format12 format12 子表
 * @param unicode unicode 码点
 * @return glyphId，未找到返回 -1
 */
function lookupFormat12(format12: CmapSubTable, unicode: number): number {
  /** 延迟模式：直接从 view 读取，避免展开数万 group */
  if (format12._lazyGroups) {
    const view = format12._cmapView!;
    const base = format12._groupsOffset!;
    let lo = 0, hi = format12.nGroups! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const gOff = base + mid * 12;
      const gStart = view.getUint32(gOff, false);
      const gEnd = view.getUint32(gOff + 4, false);
      if (unicode < gStart) {
        hi = mid - 1;
      } else if (unicode > gEnd) {
        lo = mid + 1;
      } else {
        return view.getUint32(gOff + 8, false) + (unicode - gStart);
      }
    }
    return -1;
  }
  const groups = format12.groups;
  let lo2 = 0, hi2 = groups.length / 3 - 1;
  while (lo2 <= hi2) {
    const mid2 = (lo2 + hi2) >> 1;
    const gi = mid2 * 3;
    const gStart2 = groups[gi];
    const gEnd2 = groups[gi + 1];
    if (unicode < gStart2) {
      hi2 = mid2 - 1;
    } else if (unicode > gEnd2) {
      lo2 = mid2 + 1;
    } else {
      return groups[gi + 2] + (unicode - gStart2);
    }
  }
  return -1;
}

/**
 * 优化114: format4 二分查找 segment，替代线性扫描
 * 优化293: 接受预计算的 graphIdArrayIndexOffset 参数，避免每次调用重复计算
 * 优化（subset 延迟）：_lazySegs 模式下各段未展开为数组，二分时按需从 view 读取
 *
 * @param format4 format4 子表
 * @param unicode unicode 码点
 * @param _graphIdArrayIndexOffset 预计算的 glyphIdArray 索引偏移
 * @return glyphId，未找到返回 -1
 */
function lookupFormat4(format4: CmapSubTable, unicode: number, _graphIdArrayIndexOffset?: number): number {
  const segCount = format4.segCount || format4.segCountX2! / 2;

  /* 延迟模式：各段在 view 中连续，按 mid*2 偏移读取。命中后再读 idDelta/idRangeOffset */
  if (format4._lazySegs) {
    const view = format4._cmapView!;
    const endOff = format4._endCodeOff!;
    const startOff = format4._startCodeOff!;
    const deltaOff = format4._idDeltaOff!;
    const rangeOff = format4._idRangeOffsetOff!;
    let lo = 0, hi = segCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m2 = mid * 2;
      const sCode = view.getUint16(startOff + m2, false);
      if (unicode < sCode) {
        hi = mid - 1;
      } else if (unicode > view.getUint16(endOff + m2, false)) {
        lo = mid + 1;
      } else {
        const idR = view.getUint16(rangeOff + m2, false);
        if (idR === 0) {
          /* idDelta 用 getUint16 读（与原急切模式一致），依赖 % 0x10000 处理符号 */
          return (unicode + view.getUint16(deltaOff + m2, false)) % 0x10000;
        }
        const graphIdArrayIndexOffset =
          _graphIdArrayIndexOffset != null
            ? _graphIdArrayIndexOffset
            : (format4.glyphIdArrayOffset! - format4.idRangeOffsetOffset!) / 2;
        const index = mid + (idR >> 1) + (unicode - sCode) - graphIdArrayIndexOffset;
        const graphId = view.getUint16(format4.glyphIdArrayOffset! + index * 2, false);
        if (graphId !== 0) {
          return (graphId + view.getUint16(deltaOff + m2, false)) % 0x10000;
        }
        return 0;
      }
    }
    return -1;
  }

  const startCode = format4.startCode!;
  const endCode = format4.endCode!;
  const idDelta = format4.idDelta!;
  const idRangeOffset = format4.idRangeOffset!;

  let lo2 = 0, hi2 = segCount - 1;
  while (lo2 <= hi2) {
    const mid2 = (lo2 + hi2) >> 1;
    if (unicode < startCode[mid2]) {
      hi2 = mid2 - 1;
    } else if (unicode > endCode[mid2]) {
      lo2 = mid2 + 1;
    } else {
      const i = mid2;
      if (idRangeOffset[i] === 0) {
        return (unicode + idDelta[i]) % 0x10000;
      }
      const graphIdArrayIndexOffset2 =
        _graphIdArrayIndexOffset != null
          ? _graphIdArrayIndexOffset
          : (format4.glyphIdArrayOffset! - format4.idRangeOffsetOffset!) / 2;
      const index2 = i + (idRangeOffset[i] >> 1) + (unicode - startCode[i]) - graphIdArrayIndexOffset2;
      let graphId2: number;
      if (format4.glyphIdArray) {
        graphId2 = format4.glyphIdArray[index2];
      } else if (format4._cmapView) {
        graphId2 = format4._cmapView.getUint16(format4.glyphIdArrayOffset! + index2 * 2, false);
      } else {
        return 0;
      }
      if (graphId2 !== 0) {
        return (graphId2 + idDelta[i]) % 0x10000;
      }
      return 0;
    }
  }
  return -1;
}

/**
 * 读取ttf中windows字符表的字符
 *
 * @param tables cmap表结构
 * @param ttf ttf对象
 * @return 字符字典索引，unicode => glyf index
 */
export default function readWindowsAllCodes(tables: CmapSubTable[], ttf: ReadTtf): Record<number, number> {
  const subset = ttf.readOptions && ttf.readOptions.subset;

  /**
   * 优化315: 复用 probeGsubAndCmap 预计算的 codepoint→gid 映射，跳过 subset 模式下的 format4/12 二分查找循环。
   * subset 模式下 readWindowsAllCodes 仅对 subset 字符做 lookupFormat4/lookupFormat12 二分（format0/format14
   * 已在 parse 阶段跳过，glyphIdArray/groups 为空不贡献 codes），这与 probeGsubAndCmap 的 probe.lookup
   * （backend/font_util/gsub-probe.ts，仅 format4/12 查找，算法一致）完全等价。
   * fontSubset 已先跑 probe，将 probe.lookup 转为普通对象经 readOptions.presetCmap 注入，此处直接返回，
   * 消除 readWindowsAllCodes 内 N 次（subset 长度）二分查找的重复计算（千字文 cmap.read -约50%）。
   * 仅 subset 模式 + presetCmap 存在时启用；非 subset 或无 preset 走原逻辑。
   */
  if (subset && subset.length > 0 && ttf.readOptions && ttf.readOptions.presetCmap) {
    return ttf.readOptions.presetCmap;
  }

  const codes: Record<number, number> = {};

  /* 优化65: 合并5次 tables.find 为单次遍历 */
  let format0: CmapSubTable | null = null, format12: CmapSubTable | null = null, format4: CmapSubTable | null = null, format2: CmapSubTable | null = null, format14: CmapSubTable | null = null;
  for (let fi = 0; fi < tables.length; fi++) {
    const t = tables[fi];
    if (t.format === 0 && !format0) format0 = t;
    else if (t.platformID === 3 && t.encodingID === 10 && t.format === 12 && !format12) format12 = t;
    else if (t.platformID === 3 && t.encodingID === 1 && t.format === 4 && !format4) format4 = t;
    else if (t.platformID === 3 && t.encodingID === 3 && t.format === 2 && !format2) format2 = t;
    else if (t.platformID === 0 && t.encodingID === 5 && t.format === 14 && !format14) format14 = t;
  }

  /* 优化65: subset 模式 - 只查找 subset 字符的 glyphId */
  if (subset && subset.length > 0) {
    /** 优化293: 预计算 graphIdArrayIndexOffset，避免在 subset 循环中重复计算 */
    const f4GIAO = format4
      ? format4.glyphIdArrayIndexOffset != null
        ? format4.glyphIdArrayIndexOffset
        : (format4.glyphIdArrayOffset! - format4.idRangeOffsetOffset!) / 2
      : -1;
    if (format12) {
      for (let si = 0, sl = subset.length; si < sl; si++) {
        const u = subset[si];
        if (u < 0x10000 && format4) {
          const gid = lookupFormat4(format4, u, f4GIAO);
          if (gid >= 0) { codes[u] = gid; continue; }
        }
        const gid12 = lookupFormat12(format12, u);
        if (gid12 >= 0) { codes[u] = gid12; }
      }
    } else if (format4) {
      for (let si2 = 0, sl2 = subset.length; si2 < sl2; si2++) {
        const u2 = subset[si2];
        const gid4 = lookupFormat4(format4, u2, f4GIAO);
        if (gid4 >= 0) { codes[u2] = gid4; }
      }
    }

    /* 优化93: format0/format14 在 subset 模式下跳过了解析，glyphIdArray/groups 为空 */
    if (format0 && format0.glyphIdArray) {
      for (let i = 0, l = format0.glyphIdArray.length; i < l; i++) {
        if (format0.glyphIdArray[i]) {
          codes[i] = format0.glyphIdArray[i];
        }
      }
    }
    if (format14 && format14.groups && format14.groups.length) {
      for (let vi = 0, vl = format14.groups.length; vi < vl; vi++) {
        const vg = format14.groups[vi];
        if (vg.unicode) {
          codes[vg.unicode] = vg.glyphId;
        }
      }
    }

    return codes;
  }

  /* 非subset模式 - 全量展开（原始逻辑） */
  if (format0 && format0.glyphIdArray) {
    for (let i2 = 0, l2 = format0.glyphIdArray.length; i2 < l2; i2++) {
      if (format0.glyphIdArray[i2]) {
        codes[i2] = format0.glyphIdArray[i2];
      }
    }
  }
  if (format14) {
    for (let vi2 = 0, vl2 = format14.groups.length; vi2 < vl2; vi2++) {
      const vg2 = format14.groups[vi2];
      if (vg2.unicode) {
        codes[vg2.unicode] = vg2.glyphId;
      }
    }
  }
  if (format12) {
    const f12Groups = format12.groups;
    if (format12._flatGroups) {
      for (let gi = 0, gl = f12Groups.length; gi < gl; gi += 3) {
        /** startId 在循环内自增，必须 let（const 会运行时 TypeError） */
        let startId = f12Groups[gi + 2];
        let start = f12Groups[gi];
        const end = f12Groups[gi + 1];
        for (; start <= end;) {
          codes[start++] = startId++;
        }
      }
    } else {
      for (let gi2 = 0, gl2 = format12.nGroups!; gi2 < gl2; gi2++) {
        const group = f12Groups[gi2];
        /** startId 在循环内自增，必须 let（const 会运行时 TypeError） */
        let startId2 = group.startId;
        let start2 = group.start;
        const end2 = group.end;
        for (; start2 <= end2;) {
          codes[start2++] = startId2++;
        }
      }
    }
  } else if (format4) {
    /** 优化262: 属性链缓存到局部变量 + 跳过 65535 避免 delete 导致 V8 隐藏类退化 */
    const segCount = format4.segCountX2! / 2;
    const graphIdArrayIndexOffset = (format4.glyphIdArrayOffset! - format4.idRangeOffsetOffset!) / 2;
    const f4StartCode = format4.startCode!;
    const f4EndCode = format4.endCode!;
    const f4IdDelta = format4.idDelta!;
    const f4IdRangeOffset = format4.idRangeOffset!;
    const f4GlyphIdArray = format4.glyphIdArray!;
    for (let si3 = 0; si3 < segCount; ++si3) {
      let segEnd = f4EndCode[si3];
      if (segEnd > 0xfffe) segEnd = 0xfffe;
      for (let _start = f4StartCode[si3]; _start <= segEnd; ++_start) {
        if (f4IdRangeOffset[si3] === 0) {
          codes[_start] = (_start + f4IdDelta[si3]) & 0xffff;
        } else {
          const index = si3 + (f4IdRangeOffset[si3] >> 1) + (_start - f4StartCode[si3]) - graphIdArrayIndexOffset;
          const graphId = f4GlyphIdArray[index];
          if (graphId !== 0) {
            codes[_start] = (graphId + f4IdDelta[si3]) & 0xffff;
          } else {
            codes[_start] = 0;
          }
        }
      }
    }
  } else if (format2) {
    /** 优化262: 缓存 subHeads[0] 和 subHeads[k] 到局部变量，消除重复属性链查找 */
    const subHeadKeys = format2.subHeadKeys!;
    const subHeads = format2.subHeads!;
    const glyphs = format2.glyphs!;
    const numGlyphs = ttf.maxp!.numGlyphs!;
    let _index = 0;
    const sh0 = subHeads[0];
    for (let bi = 0; bi < 256; bi++) {
      if (subHeadKeys[bi] === 0) {
        if (bi >= format2.maxPos!) {
          _index = 0;
        } else if (bi < sh0.firstCode || bi >= sh0.firstCode + sh0.entryCount || sh0.idRangeOffset + (bi - sh0.firstCode) >= glyphs.length) {
          _index = 0;
        } else if ((_index = glyphs[sh0.idRangeOffset + (bi - sh0.firstCode)]) !== 0) {
          _index = _index + sh0.idDelta;
        }
        if (_index !== 0 && _index < numGlyphs) {
          codes[bi] = _index;
        }
      } else {
        const sh = subHeads[subHeadKeys[bi]];
        const shIdRangeOffset = sh.idRangeOffset;
        const shIdDelta = sh.idDelta;
        const shFirstCode = sh.firstCode;
        for (let j = 0, entryCount = sh.entryCount; j < entryCount; j++) {
          if (shIdRangeOffset + j >= glyphs.length) {
            _index = 0;
          } else if ((_index = glyphs[shIdRangeOffset + j]) !== 0) {
            _index = _index + shIdDelta;
          }
          if (_index !== 0 && _index < numGlyphs) {
            const _unicode = (bi << 8 | j + shFirstCode) & 0xffff;
            codes[_unicode] = _index;
          }
        }
      }
    }
  }
  return codes;
}
