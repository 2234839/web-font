/**
 * GPOS 表子集化器
 *
 * CJK 字体（思源黑体、霞鹜文楷等）的全角标点连续排列时，浏览器依赖 GPOS 表的
 * 标点压缩 lookup（SinglePos/PairPos）调整字间距。子集化后 glyphId 被重编号，
 * 但 fonteditor-core 的 GPOS 读写器是原始字节透传，不会按子集字形重映射 coverage，
 * 导致浏览器用新 glyphId 查 GPOS coverage 查不到，压缩规则失效，连续标点渲染变宽。
 *
 * 本模块按 OpenType 1.9.1 规范解析 GPOS，对 LookupType 1 (SinglePos) 和 2 (PairPos)
 * 的 coverage/ClassDef glyphId 做 原gid→新gid 重映射后重新序列化。
 * 遇到不支持的 lookup 类型（3-8，以及 9 包裹的非 1/2 类型）时整体降级（返回 null），
 * 调用方保留原始 GPOS 字节，不会比子集化前更差。
 *
 * @reference https://learn.microsoft.com/en-us/typography/opentype/spec/gpos
 */

import { OTWriter as Writer, OTReader as Reader, serializeScriptList, serializeFeatureList } from "./ot-bytes.js";

/** ValueFormat 位掩码 */
const VF_X_PLACEMENT = 0x0001;
const VF_Y_PLACEMENT = 0x0002;
const VF_X_ADVANCE = 0x0004;
const VF_Y_ADVANCE = 0x0008;
const VF_X_PLA_DEVICE = 0x0010;
const VF_Y_PLA_DEVICE = 0x0020;
const VF_X_ADV_DEVICE = 0x0040;
const VF_Y_ADV_DEVICE = 0x0080;

/** 一个 ValueRecord 占用的 uint16 数量（低 8 位的 set bit 数） */
function valueRecordSize(valueFormat: number): number {
  let n = 0;
  for (let bits = valueFormat & 0xff; bits; bits >>>= 1) n += bits & 1;
  return n;
}

const LT_SINGLE_POS = 1;
const LT_PAIR_POS = 2;
const LT_MARKBASE_POS = 4;
const LT_MARKLIG_POS = 5;
const LT_MARKMARK_POS = 6;
const LT_EXTENSION = 9;

/**
 * 写出一个合法的「空 Position subtable」（空 coverage / 空 MarkArray，浏览器查不到字形会跳过）。
 * 用于 unsupported lookup 的保守降级，避免单个不重映射的 lookup 拖累整个 GPOS return null。
 * 各类型最小合法结构（format 始终为 1）：
 *   - SinglePos:        format + coverageOff + valueFormat=0 + coverage
 *   - PairPos:          format + coverageOff + valueFormat1=0 + valueFormat2=0 + pairSetCount=0 + coverage
 *   - CursivePos:       format + coverageOff + entryExitCount=0 + coverage
 *   - MarkBase/MarkLig/MarkMark: format + markCoverageOff + (base/lig/mark2)CoverageOff + markClassCount=0
 *                                + markArrayOff + baseArrayOff + 空 markCoverage + 空 baseCoverage
 *                                + markArray(markCount=0) + baseArray(baseCount=0)
 *   - ContextPos/ChainContextPos: format + coverageOff + ruleSetCount=0 + coverage
 */
function writeEmptyPosSubtable(w: Writer, effectiveType: number): void {
  const subStart = w.length;
  w.writeUint16(1);

  if (
    effectiveType === LT_MARKBASE_POS ||
    effectiveType === LT_MARKLIG_POS ||
    effectiveType === LT_MARKMARK_POS
  ) {
    /** MarkBase/MarkLig/MarkMark format1：
     *  format(2) + markCoverageOff(2) + baseCoverageOff(2) + markClassCount(2)=0 + markArrayOff(2) + baseArrayOff(2) = 12 字节头 */
    const markCovHolder: number[] = [0];
    const baseCovHolder: number[] = [0];
    const markArrayHolder: number[] = [0];
    const baseArrayHolder: number[] = [0];
    w.reserveOffset16(subStart, () => markCovHolder[0]);
    w.reserveOffset16(subStart, () => baseCovHolder[0]);
    w.writeUint16(0); /** markClassCount = 0 */
    w.reserveOffset16(subStart, () => markArrayHolder[0]);
    w.reserveOffset16(subStart, () => baseArrayHolder[0]);
    markCovHolder[0] = w.length;
    writeEmptyCoverage(w);
    baseCovHolder[0] = w.length;
    writeEmptyCoverage(w);
    markArrayHolder[0] = w.length;
    w.writeUint16(0); /** markArray: markCount = 0 */
    baseArrayHolder[0] = w.length;
    w.writeUint16(0); /** baseArray: baseCount = 0 */
    return;
  }

  /** coverageOffset 槽（相对 subtable 起始），coverage 紧随本类型头部之后 */
  const coverageAfter = (() => {
    if (effectiveType === LT_SINGLE_POS) return subStart + 6;
    if (effectiveType === LT_PAIR_POS) return subStart + 10;
    return subStart + 6; /** CursivePos / ContextPos / ChainContextPos */
  })();
  w.reserveOffset16(subStart, () => coverageAfter);
  if (effectiveType === LT_SINGLE_POS) {
    w.writeUint16(0); /** valueFormat = 0 */
  } else if (effectiveType === LT_PAIR_POS) {
    w.writeUint16(0); /** valueFormat1 */
    w.writeUint16(0); /** valueFormat2 */
    w.writeUint16(0); /** pairSetCount */
  } else {
    /** CursivePos: entryExitCount=0；Context/ChainContext: ruleSetCount=0 */
    w.writeUint16(0);
  }
  writeEmptyCoverage(w);
}

/** 写入空 coverage 表（format1 + count0） */
function writeEmptyCoverage(w: Writer): void {
  w.writeUint16(1);
  w.writeUint16(0);
}

/**
 * GPOS 子集化入口
 *
 * @param gposBytes 原始 GPOS 表字节
 * @param origToNew 原gid → 新gid 映射；不在 map 中的原 gid 表示已被子集化剔除
 * @returns 重映射后的 GPOS 字节；若包含不支持的 lookup 类型则返回 null（调用方保留原字节）
 */
export function subsetGPOS(
  gposBytes: Uint8Array,
  origToNew: Map<number, number>,
): Uint8Array | null {
  const dv = new DataView(gposBytes.buffer, gposBytes.byteOffset, gposBytes.byteLength);
  const r = new Reader(dv);

  /** ---- GPOS Header ---- */
  const major = r.u16(0);
  const minor = r.u16(2);
  /** 仅支持 v1.0 / v1.1；v1.1 的 FeatureVariations 本 MVP 不处理，存在时降级 */
  if (major !== 1 || minor > 1) return null;
  const scriptListOff = r.u16(4);
  const featureListOff = r.u16(6);
  const lookupListOff = r.u16(8);
  if (minor === 1 && r.u32(10) !== 0) return null;

  /** ---- 解析 LookupList，记录每个 lookup 的类型与 subtable 绝对偏移 ---- */
  const lookupCount = r.u16(lookupListOff);
  const lookupRelOffs: number[] = [];
  for (let i = 0; i < lookupCount; i++) {
    lookupRelOffs.push(r.u16(lookupListOff + 2 + i * 2));
  }
  const lookups: Array<{
    supported: boolean;
    effectiveType: number;
    subtableAbsOffs: number[];
    origLookupOff: number;
  }> = [];

  for (let i = 0; i < lookupCount; i++) {
    const lOff = lookupListOff + lookupRelOffs[i];
    const lookupType = r.u16(lOff);
    const subTableCount = r.u16(lOff + 4);
    const subtableAbsOffs: number[] = [];
    let effectiveType = lookupType;
    for (let j = 0; j < subTableCount; j++) {
      const subOff = lOff + r.u16(lOff + 6 + j * 2);
      if (lookupType === LT_EXTENSION) {
        if (r.u16(subOff) !== 1) {
          /** 无法解包的 extension，标记为不支持 */
          effectiveType = -1;
          continue;
        }
        effectiveType = r.u16(subOff + 2);
        subtableAbsOffs.push(subOff + r.u32(subOff + 4));
      } else {
        subtableAbsOffs.push(subOff);
      }
    }
    const supported = effectiveType === LT_SINGLE_POS || effectiveType === LT_PAIR_POS;
    lookups.push({ supported, effectiveType, subtableAbsOffs, origLookupOff: lOff });
  }

  /** ---- 重新序列化 ----
   * ScriptList / FeatureList 与 glyphId 无关（仅引用 lookup index），但其子表
   * （ScriptTable/LangSys/FeatureTable）偏移相对各自 List 起始，且在原始字体中可能与
   * 其他块【物理交错】，不能按连续字节块原样拷贝。这里遍历所有子表紧凑重排并回填相对偏移
   * （serializeScriptList / serializeFeatureList），保证输出为合法连续块。
   * LookupList 逐 lookup 处理：
   *   - 支持的（SinglePos/PairPos）：gid 重映射后重新序列化
   *   - 不支持的（MarkBase/Context 等）：原样拷贝原始字节（gid 不重映射，
   *     浏览器用新 gid 查 coverage 查不到会跳过，不会破坏，保留可能的非 gid 相关规则）
   */
  const scriptListBytes = serializeScriptList(r, scriptListOff);
  const featureListBytes = serializeFeatureList(r, featureListOff);
  /** ScriptList/FeatureList 解析失败（异常表）则整体降级返回 null（调用方保留原始 GPOS 字节） */
  if (!scriptListBytes || !featureListBytes) return null;

  const w = new Writer();

  /** Header（偏移量最后回填） */
  w.writeUint16(1);
  w.writeUint16(0);
  const scriptListAbsHolder: number[] = [];
  w.reserveOffset16(0, () => scriptListAbsHolder[0]);
  const featureListAbsHolder: number[] = [];
  w.reserveOffset16(0, () => featureListAbsHolder[0]);
  const lookupListAbsHolder: number[] = [];
  w.reserveOffset16(0, () => lookupListAbsHolder[0]);

  /** ScriptList 重序列化字节 */
  scriptListAbsHolder.push(w.length);
  for (let i = 0; i < scriptListBytes.length; i++) w.writeUint8(scriptListBytes[i]);

  /** FeatureList 重序列化字节 */
  featureListAbsHolder.push(w.length);
  for (let i = 0; i < featureListBytes.length; i++) w.writeUint8(featureListBytes[i]);

  /** LookupList 重写 */
  const lookupListAbs = w.length;
  lookupListAbsHolder.push(lookupListAbs);
  w.writeUint16(lookupCount);
  /** 预留各 lookup 的 Offset16 槽（相对 LookupList 起始） */
  const lookupAbsPositions: number[] = new Array(lookupCount);
  for (let i = 0; i < lookupCount; i++) {
    const slotIdx = i;
    w.reserveOffset16(lookupListAbs, () => lookupAbsPositions[slotIdx]);
  }

  /** 逐个 lookup 序列化 */
  for (let i = 0; i < lookupCount; i++) {
    lookupAbsPositions[i] = w.length;
    const lk = lookups[i];

    if (lk.supported) {
      /** 支持的 lookup：gid 重映射后重新序列化 */
      const lookupFlag = r.u16(lk.origLookupOff + 2);
      const useMarkFilteringSet = (lookupFlag & 0x0010) !== 0;

      /** extension 包裹时输出仍用 effectiveType，直接内嵌 subtable（不再用 extension） */
      w.writeUint16(lk.effectiveType);
      w.writeUint16(lookupFlag);
      w.writeUint16(lk.subtableAbsOffs.length);

      const lookupStart = w.length - 6;
      const subtableAbsPositions: number[] = new Array(lk.subtableAbsOffs.length);
      for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
        const slotIdx = j;
        w.reserveOffset16(lookupStart, () => subtableAbsPositions[slotIdx]);
      }
      if (useMarkFilteringSet) {
        w.writeUint16(r.u16(lk.origLookupOff + 6 + lk.subtableAbsOffs.length * 2));
      }

      for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
        subtableAbsPositions[j] = w.length;
        r.clearError();
        const ok = serializeSubtable(w, r, lk.subtableAbsOffs[j], lk.effectiveType, origToNew);
        /** 越界读取（异常表）也降级为保留原始 GPOS 字节（调用方安全降级） */
        if (!ok || r.errorFlag) return null;
      }
    } else {
      /** 不支持的 lookup（Cursive/MarkBase/Context/ChainContext 等）：
       *  保持 lookup 表头（type/flag/subCount）与 subtable 槽位数，逐 subtable 输出空 subtable。
       *  不原样拷贝原始 subtable 字节——其 coverage/ClassDef/MarkArray 等子结构在原始字体中
       *  可能与其他 lookup 物理交错、散落在任意偏移，按 lookup 边界估算拷贝会破坏字体。
       *  空 subtable 合法且 coverage 为空，浏览器跳过，仅丢失该 lookup 的定位规则。
       *  对无法构造合法空 subtable 的罕见类型（MarkBase/MarkLig/MarkMark），整体降级 return null。 */
      const lookupFlag = r.u16(lk.origLookupOff + 2);
      const useMarkFilteringSet = (lookupFlag & 0x0010) !== 0;
      w.writeUint16(r.u16(lk.origLookupOff));
      w.writeUint16(lookupFlag);
      w.writeUint16(lk.subtableAbsOffs.length);
      const lookupStart = w.length - 6;
      const subtableAbsPositions: number[] = new Array(lk.subtableAbsOffs.length);
      for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
        const slotIdx = j;
        w.reserveOffset16(lookupStart, () => subtableAbsPositions[slotIdx]);
      }
      if (useMarkFilteringSet) {
        w.writeUint16(r.u16(lk.origLookupOff + 6 + lk.subtableAbsOffs.length * 2));
      }
      for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
        subtableAbsPositions[j] = w.length;
        writeEmptyPosSubtable(w, lk.effectiveType);
      }
    }
  }

  w.flush();
  return w.toUint8Array();
}

function serializeSubtable(
  w: Writer,
  r: Reader,
  subAbs: number,
  type: number,
  origToNew: Map<number, number>,
): boolean {
  if (type === LT_SINGLE_POS) return serializeSinglePos(w, r, subAbs, origToNew);
  if (type === LT_PAIR_POS) return serializePairPos(w, r, subAbs, origToNew);
  return false;
}

/** 重映射原 gid；不在子集中返回 -1 */
function remapGid(origGid: number, origToNew: Map<number, number>): number {
  const ng = origToNew.get(origGid);
  return ng === undefined ? -1 : ng;
}

/**
 * 写入一个 ValueRecord（按 valueFormat 决定字段顺序）
 * 字段顺序固定：xPlacement, yPlacement, xAdvance, yAdvance, xPlaDevice, yPlaDevice, xAdvDevice, yAdvDevice。
 * 含 Device/VariationIndex offset 时降级（这些 offset 是相对父表，重序列化后位置失真；
 * CJK 标点压缩的 ValueFormat 通常只用 xAdvance，不含 Device）。
 */
function writeValueRecord(w: Writer, r: Reader, absOff: number, valueFormat: number): boolean {
  if (valueFormat & (VF_X_PLA_DEVICE | VF_Y_PLA_DEVICE | VF_X_ADV_DEVICE | VF_Y_ADV_DEVICE)) {
    return false;
  }
  let off = absOff;
  if (valueFormat & VF_X_PLACEMENT) {
    w.writeInt16(r.i16(off));
    off += 2;
  }
  if (valueFormat & VF_Y_PLACEMENT) {
    w.writeInt16(r.i16(off));
    off += 2;
  }
  if (valueFormat & VF_X_ADVANCE) {
    w.writeInt16(r.i16(off));
    off += 2;
  }
  if (valueFormat & VF_Y_ADVANCE) {
    w.writeInt16(r.i16(off));
    off += 2;
  }
  return true;
}

/** ValueRecord 的 uint16 数量 */
function vrCount(valueFormat: number): number {
  return valueRecordSize(valueFormat);
}

/** 读取 coverage 表的原始 gid 列表（按 coverage index 顺序） */
function readCoverageGids(r: Reader, coverageAbs: number): number[] | null {
  const fmt = r.u16(coverageAbs);
  const out: number[] = [];
  if (fmt === 1) {
    const count = r.u16(coverageAbs + 2);
    for (let i = 0; i < count; i++) out.push(r.u16(coverageAbs + 4 + i * 2));
    return out;
  }
  if (fmt === 2) {
    const rangeCount = r.u16(coverageAbs + 2);
    for (let i = 0; i < rangeCount; i++) {
      const recOff = coverageAbs + 4 + i * 6;
      const start = r.u16(recOff);
      const end = r.u16(recOff + 2);
      for (let g = start; g <= end; g++) out.push(g);
    }
    return out;
  }
  return null;
}

/** 由已排序的新 gid 数组输出 coverage 字节，返回是否为空 */
function emitCoverageFromGids(w: Writer, sorted: number[]): boolean {
  if (sorted.length === 0) {
    /** 空 coverage：format1 + count0 */
    w.writeUint16(1);
    w.writeUint16(0);
    return true;
  }
  /** 构造连续范围段 */
  const ranges: Array<{ start: number; end: number }> = [];
  let curStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push({ start: curStart, end: prev });
      curStart = sorted[i];
      prev = sorted[i];
    }
  }
  ranges.push({ start: curStart, end: prev });

  const listCost = 4 + sorted.length * 2;
  const rangeCost = 4 + ranges.length * 6;
  if (rangeCost < listCost) {
    w.writeUint16(2);
    w.writeUint16(ranges.length);
    let startCoverageIndex = 0;
    for (const rg of ranges) {
      w.writeUint16(rg.start);
      w.writeUint16(rg.end);
      w.writeUint16(startCoverageIndex);
      startCoverageIndex += rg.end - rg.start + 1;
    }
  } else {
    w.writeUint16(1);
    w.writeUint16(sorted.length);
    for (const g of sorted) w.writeUint16(g);
  }
  return true;
}

/**
 * 由 新gid->class 映射输出 ClassDef 字节（选更紧凑的 format）。
 * 不在 map 中的 gid 规范默认归 class 0。
 */
function emitClassDefFromClassMap(w: Writer, classMap: Map<number, number>): boolean {
  const entries = [...classMap.entries()].sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) {
    /** 空 ClassDef：format1, startGlyph=0, glyphCount=0 */
    w.writeUint16(1);
    w.writeUint16(0);
    w.writeUint16(0);
    return true;
  }
  /** 构造连续范围段（同 class 且 gid 连续） */
  const ranges: Array<{ start: number; end: number; cls: number }> = [];
  let curStart = entries[0][0];
  let curCls = entries[0][1];
  let prev = entries[0][0];
  for (let i = 1; i < entries.length; i++) {
    const [gid, cls] = entries[i];
    if (gid === prev + 1 && cls === curCls) {
      prev = gid;
    } else {
      ranges.push({ start: curStart, end: prev, cls: curCls });
      curStart = gid;
      curCls = cls;
      prev = gid;
    }
  }
  ranges.push({ start: curStart, end: prev, cls: curCls });

  const listStart = entries[0][0];
  const listCount = entries[entries.length - 1][0] - listStart + 1;
  const listCost = 6 + listCount * 2;
  const rangeCost = 4 + ranges.length * 6;
  if (rangeCost < listCost) {
    w.writeUint16(2);
    w.writeUint16(ranges.length);
    for (const rg of ranges) {
      w.writeUint16(rg.start);
      w.writeUint16(rg.end);
      w.writeUint16(rg.cls);
    }
  } else {
    w.writeUint16(1);
    w.writeUint16(listStart);
    w.writeUint16(listCount);
    for (let gid = listStart; gid <= listStart + listCount - 1; gid++) {
      w.writeUint16(classMap.get(gid) ?? 0);
    }
  }
  return true;
}

/**
 * 读取 ClassDef 表 → 新gid -> 原class 映射（仅记录子集保留的 gid）
 */
function readClassDefMap(
  r: Reader,
  classDefAbs: number,
  origToNew: Map<number, number>,
): Map<number, number> | null {
  const out = new Map<number, number>();
  const fmt = r.u16(classDefAbs);
  if (fmt === 1) {
    const startGlyph = r.u16(classDefAbs + 2);
    const glyphCount = r.u16(classDefAbs + 4);
    for (let i = 0; i < glyphCount; i++) {
      const ng = remapGid(startGlyph + i, origToNew);
      if (ng < 0) continue;
      out.set(ng, r.u16(classDefAbs + 6 + i * 2));
    }
  } else if (fmt === 2) {
    const rangeCount = r.u16(classDefAbs + 2);
    for (let i = 0; i < rangeCount; i++) {
      const recOff = classDefAbs + 4 + i * 6;
      const start = r.u16(recOff);
      const end = r.u16(recOff + 2);
      const cls = r.u16(recOff + 4);
      for (let g = start; g <= end; g++) {
        const ng = remapGid(g, origToNew);
        if (ng >= 0) out.set(ng, cls);
      }
    }
  } else {
    return null;
  }
  return out;
}

/**
 * SinglePos subtable
 * Format 1: 一个 ValueRecord 应用于 coverage 内所有 glyph
 * Format 2: 每个 coverage glyph 一个 ValueRecord（按 coverage index 顺序）
 */
function serializeSinglePos(
  w: Writer,
  r: Reader,
  subAbs: number,
  origToNew: Map<number, number>,
): boolean {
  const fmt = r.u16(subAbs);
  const coverageOff = r.u16(subAbs + 2);
  const valueFormat = r.u16(subAbs + 4);

  /** 解析原始 coverage → 原gid 列表 */
  const origGids = readCoverageGids(r, subAbs + coverageOff);
  if (!origGids) return false;

  /** 按 glyph 重建（origGid -> newGid），保留在子集中的 */
  const sz = vrCount(valueFormat);
  const kept: Array<{ newGid: number; valueAbs: number }> = [];
  for (let idx = 0; idx < origGids.length; idx++) {
    const ng = remapGid(origGids[idx], origToNew);
    if (ng < 0) continue;
    if (fmt === 1) {
      /** format1 所有 glyph 共用 subAbs + 6 处的 ValueRecord */
      kept.push({ newGid: ng, valueAbs: subAbs + 6 });
    } else if (fmt === 2) {
      /** format2 ValueRecord 数组在 subAbs + 8，按 coverage index 顺序 */
      kept.push({ newGid: ng, valueAbs: subAbs + 8 + idx * sz * 2 });
    } else {
      return false;
    }
  }
  kept.sort((a, b) => a.newGid - b.newGid);

  const subStart = w.length;
  if (fmt === 1) {
    w.writeUint16(1);
  } else {
    w.writeUint16(2);
  }
  const covSlot = w.length;
  w.writeUint16(0);
  w.writeUint16(valueFormat);
  if (fmt === 2) {
    w.writeUint16(kept.length);
  }
  /** ValueRecord */
  for (const e of kept) {
    if (!writeValueRecord(w, r, e.valueAbs, valueFormat)) return false;
  }
  /** coverage */
  const covPos = w.length;
  emitCoverageFromGids(w, kept.map((e) => e.newGid));
  w.writeInt16At(covSlot, covPos - subStart);
  return true;
}

/**
 * PairPos subtable
 */
function serializePairPos(
  w: Writer,
  r: Reader,
  subAbs: number,
  origToNew: Map<number, number>,
): boolean {
  const fmt = r.u16(subAbs);
  const coverageOff = r.u16(subAbs + 2);
  const valueFormat1 = r.u16(subAbs + 4);
  const valueFormat2 = r.u16(subAbs + 6);
  if (fmt === 1) {
    return serializePairPosFormat1(w, r, subAbs, coverageOff, valueFormat1, valueFormat2, origToNew);
  }
  if (fmt === 2) {
    return serializePairPosFormat2(w, r, subAbs, coverageOff, valueFormat1, valueFormat2, origToNew);
  }
  return false;
}

/**
 * PairPosFormat1：glyph 对（PairSet 表）
 * firstGlyph 与 secondGlyph 都必须在子集中才保留该对。
 */
function serializePairPosFormat1(
  w: Writer,
  r: Reader,
  subAbs: number,
  coverageOff: number,
  valueFormat1: number,
  valueFormat2: number,
  origToNew: Map<number, number>,
): boolean {
  const firstGids = readCoverageGids(r, subAbs + coverageOff);
  if (!firstGids) return false;
  const pairSetCount = r.u16(subAbs + 8);
  const vr1 = vrCount(valueFormat1);
  const vr2 = vrCount(valueFormat2);

  /** 重建每个保留 firstGlyph 的 PairSet */
  const rebuilt: Array<{ newFirstGid: number; pairSetBytes: Uint8Array }> = [];
  for (let idx = 0; idx < pairSetCount; idx++) {
    const newFirstGid = remapGid(firstGids[idx], origToNew);
    if (newFirstGid < 0) continue;
    const pairSetOff = subAbs + r.u16(subAbs + 10 + idx * 2);
    const pairValueCount = r.u16(pairSetOff);
    /** 收集 secondGlyph 也在子集中的对 */
    const keptSeconds: Array<{ newSecondGid: number; recAbs: number }> = [];
    for (let p = 0; p < pairValueCount; p++) {
      const recAbs = pairSetOff + 2 + p * (2 + vr1 * 2 + vr2 * 2);
      const newSecondGid = remapGid(r.u16(recAbs), origToNew);
      if (newSecondGid < 0) continue;
      keptSeconds.push({ newSecondGid, recAbs });
    }
    keptSeconds.sort((a, b) => a.newSecondGid - b.newSecondGid);

    const pw = new Writer();
    pw.writeUint16(keptSeconds.length);
    for (const ks of keptSeconds) {
      pw.writeUint16(ks.newSecondGid);
      if (vr1 > 0 && !writeValueRecord(pw, r, ks.recAbs + 2, valueFormat1)) return false;
      if (vr2 > 0 && !writeValueRecord(pw, r, ks.recAbs + 2 + vr1 * 2, valueFormat2)) return false;
    }
    pw.flush();
    rebuilt.push({ newFirstGid, pairSetBytes: pw.toUint8Array() });
  }
  rebuilt.sort((a, b) => a.newFirstGid - b.newFirstGid);

  const subStart = w.length;
  w.writeUint16(1);
  const covSlot = w.length;
  w.writeUint16(0);
  w.writeUint16(valueFormat1);
  w.writeUint16(valueFormat2);
  w.writeUint16(rebuilt.length);

  const pairSetAbsPositions: number[] = new Array(rebuilt.length);
  for (let i = 0; i < rebuilt.length; i++) {
    const slotIdx = i;
    w.reserveOffset16(subStart, () => pairSetAbsPositions[slotIdx]);
  }
  for (let i = 0; i < rebuilt.length; i++) {
    pairSetAbsPositions[i] = w.length;
    const bs = rebuilt[i].pairSetBytes;
    for (let k = 0; k < bs.length; k++) w.writeUint8(bs[k]);
  }

  const covPos = w.length;
  emitCoverageFromGids(w, rebuilt.map((e) => e.newFirstGid));
  w.writeInt16At(covSlot, covPos - subStart);
  return true;
}

/**
 * PairPosFormat2：class 对（ClassDef + Class1/Class2 二维 ValueRecord 数组）
 *
 * 子集化必须对 class 做【紧致重编号】：原始 class1Count×class2Count 可能很大
 * （如 124×107=13268 个 ValueRecord），直接沿用会让 subtable 超过 Offset16 (32767)
 * 寻址范围，coverage/classDef 偏移溢出导致字体损坏。
 * 只保留实际被子集 gid 命中的 class，重新编号为 0..N-1（保留 class 0），
 * ValueRecord 数组按紧致 class 索引从原始数组对应位置取值。
 */
function serializePairPosFormat2(
  w: Writer,
  r: Reader,
  subAbs: number,
  coverageOff: number,
  valueFormat1: number,
  valueFormat2: number,
  origToNew: Map<number, number>,
): boolean {
  const classDef1Off = r.u16(subAbs + 8);
  const classDef2Off = r.u16(subAbs + 10);
  const class2Count = r.u16(subAbs + 14);

  /** 解析原始 classDef → 新gid -> 原class（classDef 未出现的 gid 默认 class 0） */
  const gidToClass1 = readClassDefMap(r, subAbs + classDef1Off, origToNew);
  const gidToClass2 = readClassDefMap(r, subAbs + classDef2Off, origToNew);
  if (!gidToClass1 || !gidToClass2) return false;

  /** 收集实际命中的 class（class 0 永远保留） */
  const usedClass1 = new Set<number>([0]);
  for (const cls of gidToClass1.values()) usedClass1.add(cls);
  const usedClass2 = new Set<number>([0]);
  for (const cls of gidToClass2.values()) usedClass2.add(cls);

  /** 原class -> 紧致新class（升序重编号，class 0 → 0） */
  const class1Remap = new Map<number, number>();
  [...usedClass1].sort((a, b) => a - b).forEach((c, i) => class1Remap.set(c, i));
  const class2Remap = new Map<number, number>();
  [...usedClass2].sort((a, b) => a - b).forEach((c, i) => class2Remap.set(c, i));
  const newClass1Count = class1Remap.size;
  const newClass2Count = class2Remap.size;

  /** 反查：紧致新class -> 原class */
  const newC1ToOld = new Map<number, number>();
  for (const [oldC, newC] of class1Remap) newC1ToOld.set(newC, oldC);
  const newC2ToOld = new Map<number, number>();
  for (const [oldC, newC] of class2Remap) newC2ToOld.set(newC, oldC);

  /** 紧致后的 classDef（新gid -> 紧致class） */
  const compactCD1 = new Map<number, number>();
  for (const [gid, cls] of gidToClass1) compactCD1.set(gid, class1Remap.get(cls)!);
  const compactCD2 = new Map<number, number>();
  for (const [gid, cls] of gidToClass2) compactCD2.set(gid, class2Remap.get(cls)!);

  /** 重映射 coverage */
  const covGids = readCoverageGids(r, subAbs + coverageOff);
  if (!covGids) return false;
  const newCovGids: number[] = [];
  for (const g of covGids) {
    const ng = remapGid(g, origToNew);
    if (ng >= 0) newCovGids.push(ng);
  }
  newCovGids.sort((a, b) => a - b);

  const vr1 = vrCount(valueFormat1);
  const vr2 = vrCount(valueFormat2);
  const class2RecSize = vr1 * 2 + vr2 * 2;

  const subStart = w.length;
  w.writeUint16(2);
  const covSlot = w.length;
  w.writeUint16(0);
  w.writeUint16(valueFormat1);
  w.writeUint16(valueFormat2);
  const cd1Slot = w.length;
  w.writeUint16(0);
  const cd2Slot = w.length;
  w.writeUint16(0);
  w.writeUint16(newClass1Count);
  w.writeUint16(newClass2Count);

  /** class1Records：按紧致 class 遍历，从原始数组 (原class1 * class2Count + 原class2) 取值 */
  for (let nc1 = 0; nc1 < newClass1Count; nc1++) {
    const oc1 = newC1ToOld.get(nc1)!;
    for (let nc2 = 0; nc2 < newClass2Count; nc2++) {
      const oc2 = newC2ToOld.get(nc2)!;
      const recAbs = subAbs + 16 + (oc1 * class2Count + oc2) * class2RecSize;
      if (vr1 > 0 && !writeValueRecord(w, r, recAbs, valueFormat1)) return false;
      if (vr2 > 0 && !writeValueRecord(w, r, recAbs + vr1 * 2, valueFormat2)) return false;
    }
  }

  /** classDef1 */
  const cd1Pos = w.length;
  if (!emitClassDefFromClassMap(w, compactCD1)) return false;
  /** classDef2 */
  const cd2Pos = w.length;
  if (!emitClassDefFromClassMap(w, compactCD2)) return false;
  /** coverage */
  const covPos = w.length;
  emitCoverageFromGids(w, newCovGids);

  w.writeInt16At(cd1Slot, cd1Pos - subStart);
  w.writeInt16At(cd2Slot, cd2Pos - subStart);
  w.writeInt16At(covSlot, covPos - subStart);
  return true;
}
