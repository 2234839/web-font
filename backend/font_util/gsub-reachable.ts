/**
 * 计算子集 glyph 通过 GSUB 替换链可达的全部 target glyph id
 *
 * GSUB（连字/上下文替换）的替换目标常为无 unicode 的纯字形 glyph（如 FiraCode 的
 * `greater_equal.liga`，unicode=None）。子集化基于 codepoint 无法保留这些 glyph，
 * 导致替换规则 target 失效、连字不渲染。本模块在子集化前解析原始 GSUB，找出从子集起始
 * gid 出发、经替换链可达的全部 target gid，供调用方注入子集（extraSubsetGids）。
 *
 * 处理的 lookup 类型：
 *   - type1 SingleSubst:    coverage gid（在子集）→ target gid
 *   - type2 MultipleSubst:  coverage gid（在子集）→ 多个 target gid
 *   - type3 AlternateSubst: coverage gid（在子集）→ 多个候选 target gid（全部保留）
 *   - type4 LigatureSubst:  全部 component 在子集 → target gid（多对一，target 为新字形）
 *   - type6 ChainedContext: 匹配上下文后调用其他 lookup（递归处理被引用 lookup）
 *   - type7 Extension:      解包后递归
 *
 * @reference https://learn.microsoft.com/en-us/typography/opentype/spec/gsub
 */

import { OTReader } from "./ot-bytes.js";

/** GSUB lookup 类型常量 */
const LT_SINGLE = 1;
const LT_MULTIPLE = 2;
const LT_ALTERNATE = 3;
const LT_LIGATURE = 4;
const LT_CHAIN = 6;
const LT_EXTENSION = 7;

/**
 * Coverage 解析缓存（off → 原 gid 数组）。
 * 不动点迭代每轮对全部 lookup 的 coverage 重复解析，但 coverage 字节不变故结果稳定。
 * 实测 FiraCode 迭代多轮，缓存消除绝大部分重复 u16 读取与数组分配（reachable 阶段主热点）。
 */
type CoverageCache = Map<number, number[]>;

/** 读取 Coverage 表的 gid 列表。传入 cache 时按绝对偏移缓存解析结果。 */
function readCoverageGids(r: OTReader, off: number, cache: CoverageCache): number[] {
  const hit = cache.get(off);
  if (hit !== undefined) return hit;
  const dv = r.dv;
  const format = dv.getUint16(off, false);
  const gids: number[] = [];
  if (format === 1) {
    const count = dv.getUint16(off + 2, false);
    /** format1 gid 列表是连续 count 个大端 u16。若 2 字节对齐，用 Uint16Array view 共享 buffer
     *  读取 + 内联翻转（与 readCoverageRemapped/hmtx/loca 同思路），比逐次 dv.getUint16 的边界检查 + 大端组装更快 */
    const base = off + 4;
    const byteOff = dv.byteOffset + base;
    if (count > 8 && (byteOff & 1) === 0) {
      const src16 = new Uint16Array(dv.buffer, byteOff, count);
      for (let i = 0; i < count; i++) {
        const raw = src16[i];
        gids.push(((raw & 0xff) << 8) | (raw >> 8));
      }
    } else {
      for (let i = 0; i < count; i++) gids.push(dv.getUint16(base + i * 2, false));
    }
  } else if (format === 2) {
    const rangeCount = dv.getUint16(off + 2, false);
    let p = off + 4;
    for (let i = 0; i < rangeCount; i++) {
      const start = dv.getUint16(p, false);
      const end = dv.getUint16(p + 2, false);
      for (let g = start; g <= end; g++) gids.push(g);
      p += 6;
    }
  }
  cache.set(off, gids);
  return gids;
}

/**
 * 找 coverage 中第一个不在子集（inSubset 返回 false）的 gid，无需展开完整数组。
 *
 * format1 list：逐项 u16 读取 + inSubset，命中即返回。
 * format2 range：逐 range 内 gid 生成（start..end）+ inSubset，命中即返回，避免 readCoverageGids
 * 的完整展开与数组分配。初夏纯标点 280 个 format3 首轮全失败，第一个 coverage 的首个 gid
 * 往往就排除，本函数短路返回省掉全量展开。
 *
 * 全部 gid 都在子集时返回 -1（coverage「全包含」）。
 *
 * 优化310: cache 命中时遍历已缓存数组（与其他 lookup type 共享解析结果）；
 *   cache miss 时**直接边解析边查、不调 readCoverageGids 也不填 cache**。
 *   原实现 `readCoverageGids(off, cache)` 会完整展开 coverage 到数组再遍历——对 format2 range
 *   （初夏明朝 coverage 常覆盖上千 gid）即使首个 gid 就 excluded 也要展开全量，是「展开全量命中极少」浪费
 *   （同类见 [[gsub-classdef-format2-bsearch]]）。fmt3 失败路径的 coverage 永不被 collectSubtableTargets
 *   读（失败不产 target），故不填 cache 无碍；仅 triggerable=true 的 coverage 才在后续 readCoverageGids
 *   收集 contextGids 时缓存。
 *
 * @param off coverage 绝对偏移
 * @param inSubset 判定 gid 是否在子集
 * @returns 第一个不在子集的 gid；全在子集返回 -1
 */
function coverageFirstExcludedGid(
  r: OTReader,
  off: number,
  cache: CoverageCache,
  inSubset: (gid: number) => boolean,
): number {
  /** cache 命中：遍历已缓存数组（复用其他 lookup 的解析结果） */
  const cached = cache.get(off);
  if (cached !== undefined) {
    for (const g of cached) if (!inSubset(g)) return g;
    return -1;
  }
  /** cache miss：边解析边查，不分配数组、不填 cache */
  const dv = r.dv;
  const format = dv.getUint16(off, false);
  if (format === 1) {
    const count = dv.getUint16(off + 2, false);
    const base = off + 4;
    for (let i = 0; i < count; i++) {
      const g = dv.getUint16(base + i * 2, false);
      if (!inSubset(g)) return g;
    }
    return -1;
  } else if (format === 2) {
    const rangeCount = dv.getUint16(off + 2, false);
    let p = off + 4;
    for (let i = 0; i < rangeCount; i++) {
      const start = dv.getUint16(p, false);
      const end = dv.getUint16(p + 2, false);
      for (let g = start; g <= end; g++) {
        if (!inSubset(g)) return g;
      }
      p += 6;
    }
    return -1;
  }
  return -1;
}

/**
 * 在 coverage 中二分查找 gid 的序号（0-based，按 gid 升序），不展开完整 gid 数组。
 *
 * SingleSubst format2 / AlternateSubst 的「反转遍历」路径（reachable 小、coverage 大）下，
 * 原实现 readCoverageGids 先把 coverage 全部 gid 展开到数组（思源 locl lookup coverage 达 8881/12000/11632 gid），
 * 再遍历 reachable 对数组二分。展开大数组是 reach 阶段 #1 热点（思源 0.060ms / 0.165ms）。
 * 本函数直接对 coverage 原始字节二分：
 *   - format1（gid 列表，升序）：标准二分，log2(count) 次 getUint16
 *   - format2（range 列表）：二分定位含 gid 的 range，序号 = 该 range 之前所有 range 的 gid 累计 + (gid - start)
 *
 * @param off coverage 绝对偏移
 * @param gid 待查 gid
 * @returns gid 在 coverage 中的序号；不在返回 -1
 */
function coverageIndexOf(r: OTReader, off: number, gid: number): number {
  const dv = r.dv;
  const format = dv.getUint16(off, false);
  if (format === 1) {
    const count = dv.getUint16(off + 2, false);
    const base = off + 4;
    let lo = 0, hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const mg = dv.getUint16(base + mid * 2, false);
      if (mg < gid) lo = mid + 1;
      else if (mg > gid) hi = mid;
      else return mid;
    }
    return -1;
  } else if (format === 2) {
    const rangeCount = dv.getUint16(off + 2, false);
    const base = off + 4;
    /** 二分找第一个 end >= gid 的 range（range 按 start 升序，故 end 也升序） */
    let lo = 0, hi = rangeCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const end = dv.getUint16(base + mid * 6 + 2, false);
      if (end < gid) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= rangeCount) return -1;
    const rangeOff = base + lo * 6;
    const start = dv.getUint16(rangeOff, false);
    const end = dv.getUint16(rangeOff + 2, false);
    if (gid < start || gid > end) return -1;
    /** 序号 = 之前所有 range 的 gid 累计 + (gid - start)。range 数通常很少（思源大 coverage 均为 format1），
     *  线性累计开销可忽略；range 多时退化为 O(rangeCount)，仍优于展开 O(totalGids)。 */
    let prefix = 0;
    for (let i = 0; i < lo; i++) {
      const s = dv.getUint16(base + i * 6, false);
      const e = dv.getUint16(base + i * 6 + 2, false);
      prefix += e - s + 1;
    }
    return prefix + (gid - start);
  }
  return -1;
}

/**
 * 返回 coverage 的 gid 总数，不展开到数组。
 *
 * 反转遍历路径判断「coverage 是否明显多于 reachable」只需 gid 数，无需展开（思源 locl coverage
 * 达上万 gid，展开即 #1 热点）。format1 直接读 count；format2 累加各 range 的 (end-start+1)。
 */
function coverageCount(r: OTReader, off: number): number {
  const dv = r.dv;
  const format = dv.getUint16(off, false);
  if (format === 1) {
    return dv.getUint16(off + 2, false);
  } else if (format === 2) {
    const rangeCount = dv.getUint16(off + 2, false);
    const base = off + 4;
    let total = 0;
    for (let i = 0; i < rangeCount; i++) {
      const s = dv.getUint16(base + i * 6, false);
      const e = dv.getUint16(base + i * 6 + 2, false);
      total += e - s + 1;
    }
    return total;
  }
  return 0;
}

/**
 * 收集从 seedGids 出发、经 GSUB 替换链可达的全部 target gid（不含 seed 本身）。
 *
 * @param gsubBytes 原始 GSUB 表字节
 * @param seedGids  子集起始 gid 集合（子集 codepoint 对应的 gid）
 * @returns 需额外保留的 target gid 集合
 */
export function collectReachableGsubTargets(
  gsubBytes: Uint8Array,
  seedGids: Set<number>,
): Set<number> {
  const dv = new DataView(gsubBytes.buffer, gsubBytes.byteOffset, gsubBytes.byteLength);
  const r = new OTReader(dv);
  const covCache: CoverageCache = new Map();

  const major = r.u16(0);
  const minor = r.u16(2);
  if (major !== 1 || minor > 1) return new Set();
  const lookupListOff = r.u16(8);

  const lookupCount = r.u16(lookupListOff);

  /** 解析每个 lookup 的 (effectiveType, subtableAbsOffs)。
   *  合并 lookupRelOffs 读取到主循环（避免先收集到中间数组再按下标回读）。 */
  interface LookupParsed {
    effectiveType: number;
    subtableAbsOffs: number[];
  }
  const lookups: LookupParsed[] = [];
  for (let i = 0; i < lookupCount; i++) {
    const lOff = lookupListOff + dv.getUint16(lookupListOff + 2 + i * 2, false);
    const lookupType = dv.getUint16(lOff, false);
    const subTableCount = dv.getUint16(lOff + 4, false);
    const subtableAbsOffs: number[] = [];
    let effectiveType = lookupType;
    for (let j = 0; j < subTableCount; j++) {
      const subOff = lOff + dv.getUint16(lOff + 6 + j * 2, false);
      if (lookupType === LT_EXTENSION) {
        if (dv.getUint16(subOff, false) !== 1) {
          effectiveType = -1;
          continue;
        }
        effectiveType = dv.getUint16(subOff + 2, false);
        subtableAbsOffs.push(subOff + r.u32(subOff + 4));
      } else {
        subtableAbsOffs.push(subOff);
      }
    }
    lookups.push({ effectiveType, subtableAbsOffs });
  }

  /** 固定点迭代：不断扩展 reachable 集合。
   *  type6 ChainedContext 规则：若其全部 input/backtrack/lookahead gid 都在子集内，
   *  则规则可触发——此时被引用 lookup 的 target 需保留（通过 chainRefs 在迭代中处理 type1/2/3/4 target）。
   *  type1/2/3/4 规则：coverage gid 在子集 → target 保留。
   *  这模拟了 pyftsubset 的「实际触发路径」分析，避免保留无关 calt 规则的海量 context glyph。
   *
   *  优化（单 Set inSubset）：reachable 初始即含 seedGids，inSubset 只查 reachable 一个 Set
   *  （原为 seedGids.has || reachable.has 两次 Set 查询，热路径每 subtable 多次调用）。
   *  返回的 reachable 可能含 seed gid——调用方注入 extraSubsetGids 后 Font.create 会去重，无害。 */
  const reachable = new Set<number>(seedGids);
  let changed = true;
  const inSubset = (gid: number) => reachable.has(gid);

  /** 复用临时 Set，避免每个 type6 subtable 两次 new Set 的 GC 压力（初夏明朝 51 lookup 多轮迭代） */
  const refsReuse: Set<number> = new Set<number>();
  const ctxGidsReuse: Set<number> = new Set<number>();
  /**
   * 优化316：固定点迭代跨轮稳定性记忆。
   * collectChainRefs 对 format2（保守全收集）与 format3 triggerable=true 返回 true，表示该 subtable
   * 的 refs/contextGids 已收全、不随 reachable 扩展而变化。记录其偏移到 settledChain，后续轮直接跳过，
   * 避免重复扫描（初夏纯标点 280 个 format3，第 2 轮全部可跳过）。triggerable=false 的不记忆，因
   * reachable 扩展可能使缺失的 coverage gid 进入、令其转为触发。
   */
  const settledChain: Set<number> = new Set<number>();
  /**
   * 优化（format3 失败 gid 跨轮跳过）：format3 triggerable=false 的 subtable，记录使其失败的第一个
   *  coverage gid。下一轮若该 gid 仍未进 reachable，本 subtable 必定仍 false，直接跳过重扫。
   *  初夏纯标点 280 个 format3 全 false，原 3 轮 × 280 = 840 次 collectChainRefs，改后第 2 轮起全部跳过。
   *  失败 gid 进 reachable 时重扫（可能仍 false 则更新失败 gid；可能变 true 则走 settledChain 记忆）。
   */
  const failGidMap: Map<number, number> = new Map<number, number>();
  /** 复用对象，避免每次调用 collectChainRefs 分配 */
  const failGidBox: { v: number } = { v: -1 };

  while (changed) {
    changed = false;
    for (let i = 0; i < lookupCount; i++) {
      const lk = lookups[i];
      for (const subAbs of lk.subtableAbsOffs) {
        if (lk.effectiveType === LT_CHAIN) {
          if (settledChain.has(subAbs)) continue;
          /** 已知失败 gid 仍未进 reachable → 必定仍 triggerable=false，跳过重扫 */
          const knownFail = failGidMap.get(subAbs);
          if (knownFail !== undefined && !reachable.has(knownFail)) continue;
          /** type6：收集可触发规则引用的 lookup index 与所需 context gid */
          refsReuse.clear();
          ctxGidsReuse.clear();
          failGidBox.v = -1;
          const stable = collectChainRefs(r, subAbs, refsReuse, ctxGidsReuse, inSubset, covCache, failGidBox);
          for (const g of ctxGidsReuse) {
            if (!reachable.has(g)) { reachable.add(g); changed = true; }
          }
          for (const li of refsReuse) {
            const refLk = lookups[li];
            if (!refLk) continue;
            for (const refSub of refLk.subtableAbsOffs) {
              const refTargets = collectSubtableTargets(r, refSub, refLk.effectiveType, inSubset, covCache, reachable);
              for (const g of refTargets) {
                if (!reachable.has(g)) { reachable.add(g); changed = true; }
              }
            }
          }
          if (stable) {
            settledChain.add(subAbs);
            failGidMap.delete(subAbs);
          } else if (failGidBox.v >= 0) {
            /** triggerable=false：记录失败 gid，下轮据此跳过 */
            failGidMap.set(subAbs, failGidBox.v);
          }
        } else {
          const newTargets = collectSubtableTargets(r, subAbs, lk.effectiveType, inSubset, covCache, reachable);
          for (const g of newTargets) {
            if (!reachable.has(g)) {
              reachable.add(g);
              changed = true;
            }
          }
        }
      }
    }
    if (r.errorFlag) break;
  }

  return reachable;
}

/** 从单个 subtable 收集 target gid（type1/2/3/4），type6 不直接产生 target（通过 chainRefs 间接） */
function collectSubtableTargets(
  r: OTReader,
  off: number,
  type: number,
  inSubset: (gid: number) => boolean,
  covCache: CoverageCache,
  reachable: Set<number>,
): number[] {
  const targets: number[] = [];
  /** 缓存 dv 供内层循环连续 u16 读取直接调用 getUint16，省去 r.u16 的方法调用 + 边界检查开销
   *  （collectReachableGsubTargets 是 FiraCode 等 GSUB 重字体的 #1 热点，循环内 u16 调用密集）。
   *  offset 均为 GSUB 表内有效偏移，getUint16 与 u16 行为一致；format/count 等结构判定仍用 r.u16 保持 errorFlag 安全网 */
  const dv = r.dv;
  if (type === LT_SINGLE) {
    /** SingleSubst: format1 coverage+delta / format2 coverage+gidArray */
    const format = r.u16(off);
    const covOff = off + r.u16(off + 2);
    if (format === 1) {
      const delta = r.i16(off + 4);
      /** 条件反转：仅当 covGids 明显多于 reachable 时反转遍历方向（遍历小集合二分查大集合）。
       *  covGids 短（FiraCode type1 avg 5.5）时原 Set.has 路径更快（二分开销 > 遍历）。 */
      if (coverageCount(r, covOff) > reachable.size) {
        /** 反转路径（大 coverage）：coverageIndexOf 直接对 coverage 字节二分，不展开 gid 数组。
         *  format1 delta 替换：target = (gid + delta) & 0xffff，无需 index 查表。 */
        for (const g of reachable) {
          if (coverageIndexOf(r, covOff, g) >= 0) targets.push((g + delta) & 0xffff);
        }
      } else {
        const covGids = readCoverageGids(r, covOff, covCache);
        for (const g of covGids) {
          if (inSubset(g)) targets.push((g + delta) & 0xffff);
        }
      }
    } else if (format === 2) {
      /** 条件反转遍历方向：coverage 命中率低（初夏 fmt2 covLen 9180/round，reachable 53，命中率<4%）。
       *  仅当 covGids 明显多于 reachable 时遍历 reachable 二分查 covGids 得 index；否则原 Set.has 路径。 */
      const count = r.u16(off + 4);
      const gidArrBase = off + 6;
      if (coverageCount(r, covOff) > reachable.size) {
        /** 反转路径（大 coverage）：coverageIndexOf 直接对 coverage 字节二分得 index，不展开 gid 数组
         *  （思源 locl lookup coverage 达 8881/12000/11632 gid，展开是 reach 阶段 #1 热点）。
         *  命中 index 去 gidArrBase+index*2 读 target。 */
        for (const g of reachable) {
          const idx = coverageIndexOf(r, covOff, g);
          if (idx >= 0 && idx < count) targets.push(dv.getUint16(gidArrBase + idx * 2, false));
        }
      } else {
        const covGids = readCoverageGids(r, covOff, covCache);
        const lim = covGids.length < count ? covGids.length : count;
        for (let i = 0; i < lim; i++) {
          if (inSubset(covGids[i])) targets.push(dv.getUint16(gidArrBase + i * 2, false));
        }
      }
    }
  } else if (type === LT_MULTIPLE) {
    const covOff = off + r.u16(off + 2);
    const seqCount = r.u16(off + 4);
    const covGids = readCoverageGids(r, covOff, covCache);
    for (let i = 0; i < covGids.length && i < seqCount; i++) {
      if (!inSubset(covGids[i])) continue;
      const seqOff = off + dv.getUint16(off + 6 + i * 2, false);
      const glyphCount = dv.getUint16(seqOff, false);
      for (let k = 0; k < glyphCount; k++) targets.push(dv.getUint16(seqOff + 2 + k * 2, false));
    }
  } else if (type === LT_ALTERNATE) {
    /** 条件反转：初夏 type3 covLen 987/3 calls（avg 329），命中率 2.3%；covGids 短时走原路径。 */
    const covOff = off + r.u16(off + 2);
    const altCount = r.u16(off + 4);
    const covGids = readCoverageGids(r, covOff, covCache);
    const lim = covGids.length < altCount ? covGids.length : altCount;
    if (covGids.length > reachable.size) {
      for (const g of reachable) {
        let lo = 0, hi = lim;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const mg = covGids[mid];
          if (mg < g) lo = mid + 1;
          else if (mg > g) hi = mid;
          else {
            const altOff = off + dv.getUint16(off + 6 + mid * 2, false);
            const cnt = dv.getUint16(altOff, false);
            for (let k = 0; k < cnt; k++) targets.push(dv.getUint16(altOff + 2 + k * 2, false));
            break;
          }
        }
      }
    } else {
      for (let i = 0; i < lim; i++) {
        if (!inSubset(covGids[i])) continue;
        const altOff = off + dv.getUint16(off + 6 + i * 2, false);
        const cnt = dv.getUint16(altOff, false);
        for (let k = 0; k < cnt; k++) targets.push(dv.getUint16(altOff + 2 + k * 2, false));
      }
    }
  } else if (type === LT_LIGATURE) {
    /** LigatureSubst: 全部 component 在子集 → target gid */
    const covOff = off + r.u16(off + 2);
    const setCount = r.u16(off + 4);
    const covGids = readCoverageGids(r, covOff, covCache);
    for (let i = 0; i < covGids.length && i < setCount; i++) {
      /** 第一分量（coverage gid）不在子集时整条 ligature 不触发，跳过整个 LigatureSet，
       *  不展开其内部 ligature（省 ligCount/ligOff/compCount/target 等无谓 u16 读取）。
       *  初夏明朝 type4 first gid 常全不在子集（首轮覆盖 glyph 多为非子集字形），此短路省掉每条
       *  ligature 的多次 u16 读 + inSubset 判定。 */
      if (!inSubset(covGids[i])) continue;
      const setOff = off + dv.getUint16(off + 6 + i * 2, false);
      const ligCount = dv.getUint16(setOff, false);
      for (let j = 0; j < ligCount; j++) {
        const ligOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        const compCount = dv.getUint16(ligOff, false);
        const target = dv.getUint16(ligOff + 2, false);
        let allIn = true;
        for (let k = 0; k < compCount - 1; k++) {
          if (!inSubset(dv.getUint16(ligOff + 4 + k * 2, false))) {
            allIn = false;
            break;
          }
        }
        if (allIn) targets.push(target);
      }
    }
  }
  /** type5 ReverseChain / type6 ChainedContext 不直接产生 target（type6 通过 chainRefs 间接，
   *  被引用 lookup 的 target 在其自身 subtable 收集；ReverseChain 罕见且 target 提取复杂，暂忽略） */
  return targets;
}

/**
 * 收集 type6 ChainedContext subtable 中「可触发规则」引用的 lookup index 与所需 context gid。
 *
 * 一条 ChainSubstRule 可触发，当且仅当其全部 backtrack/input/lookahead gid 都在当前子集内。
 * format1：元素是直接 gid，用 inSubset 逐项判断；context gid 收集到 contextGids（保留它们使规则可触发）。
 * format2：元素是 class index（非 gid），class 匹配的 gid 由 ClassDef 决定；class index 始终有效，
 *          但规则是否「可能触发」取决于该 class 是否含子集内 gid（保守起见视为可触发，收集 ClassDef gid）。
 * format3：元素是 coverage，gid 全在子集则可触发。
 *
 * 只对可触发规则收集其 SubstLookupRecord 引用的 lookup index（refs），供调用方进一步追踪 target。
 * 这模拟 pyftsubset 的触发路径分析，避免保留无关规则的海量 context glyph。
 */
function collectChainRefs(
  r: OTReader,
  off: number,
  refs: Set<number>,
  contextGids: Set<number>,
  inSubset: (gid: number) => boolean,
  covCache: CoverageCache,
  /** out: triggerable=false 时记录第一个不在 reachable 的 coverage gid（跨轮跳过判定用） */
  failGid: { v: number },
): boolean {
  const format = r.u16(off);
  /** 缓存 dv 供循环内连续 u16 读取直接调用 getUint16（format3 是 FiraCode 最多 subtable 类型，循环密集） */
  const dv = r.dv;
  if (format === 1) {
    /** format1: coverage(gid) + SubRuleSet 数组，按 coverage gid 索引 */
    const covOff = off + r.u16(off + 2);
    const covGids = readCoverageGids(r, covOff, covCache);
    const setCount = r.u16(off + 4);
    for (let i = 0; i < covGids.length && i < setCount; i++) {
      /** 第一分量（coverage gid）须在子集，否则该 SubRuleSet 不触发 */
      if (!inSubset(covGids[i])) continue;
      contextGids.add(covGids[i]);
      const setOffRel = dv.getUint16(off + 6 + i * 2, false);
      if (setOffRel === 0) continue;
      const setOff = off + setOffRel;
      const ruleCount = dv.getUint16(setOff, false);
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        collectChainRuleRefs(r, ruleOff, refs, contextGids, inSubset, true);
      }
    }
    /** format1 按 coverage gid 分派 SubRuleSet，部分触发部分未触发，未触发部分可能随 reachable
     *  扩展而新增触发，故保守返回 false（不跨轮跳过）。FiraCode 90 个 format1，影响有限。 */
    return false;
  } else if (format === 2) {
    /** format2: 三个 ClassDef + 按 input 第一分量 class 索引的 SubClassSet。
     *  class index 不重映射，规则的 backtrack/input/lookahead 是 class index（非 gid），
     *  无法直接用 inSubset 判断（class 可含任意 gid）。保守收集被引用 lookup 与 ClassDef gid。 */
    const classSetCount = r.u16(off + 10);
    for (let i = 0; i < classSetCount; i++) {
      const setOffRel = dv.getUint16(off + 12 + i * 2, false);
      if (setOffRel === 0) continue;
      const setOff = off + setOffRel;
      const ruleCount = dv.getUint16(setOff, false);
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        collectChainRuleRefs(r, ruleOff, refs, contextGids, inSubset, false);
      }
    }
    /** format2 保守收集全部 ClassDef gid（不判 inSubset），首轮即收全，结果不随 reachable 扩展变化。 */
    return true;
  } else if (format === 3) {
    /** format3: 显式 coverage 数组 + SubstLookupRecords。
     *  三个 coverage 数组（backtrack/input/lookahead）的 gid 须全在子集才触发。
     *
     *  优化（失败短路，跳过 coverage 展开与 contextGids 收集）：format3 triggerable=false 是常态
     *  （思源黑体 281 个 format3 首轮全 false，初夏纯标点 280 个亦然）。失败时只需找到第一个不在
     *  reachable 的 gid 记入 failGid 供跨轮跳过——此时 contextGids 的收集无意义：break 前已检查的
     *  gid 都在 reachable（inSubset=reachable.has），调用方对其 reachable.add 是 no-op。仅
     *  triggerable=true 时（coverage 全在子集、量小）才 readCoverageGids 收集 contextGids。
     *
     *  优化（首 gid 内联快查）：format1/2 coverage 的第一个 gid 在 coverage 头部固定位置
     *  （format1: off+4；format2: off+4 即首个 range 的 start）。绝大多数 fail 的 fmt3，其某段
     *  coverage 的首个 gid 就不在 reachable（思源 281/281 命中）。内联读这 2 字节 + 1 次 inSubset
     *  即可短路，省掉 coverageFirstExcludedGid 的函数调用 + covCache.get Map 查询。仅首 gid 在
     *  reachable 时才调 coverageFirstExcludedGid 完整检查该 coverage（可能其余 gid 仍不在）。 */
    let p = off + 2;
    let triggerable = true;
    /** 第一遍：逐 coverage 找首个不在子集的 gid，全在子集则 triggerable 保持 true */
    for (let seg = 0; seg < 3 && triggerable; seg++) {
      const cnt = r.u16(p);
      p += 2;
      for (let k = 0; k < cnt; k++) {
        const covOff = off + dv.getUint16(p + k * 2, false);
        /** 内联首 gid 快查：coverage format 在 covOff，首个 gid 在 covOff+4（format1 list[0] 或 format2 range[0].start）。
         *  count>0 时才有首个 gid；format 非 1/2（损坏表）交由 coverageFirstExcludedGid 兜底返回 -1。
         *  首 gid 不在 reachable → 该 coverage 必含 excluded，直接短路记 failGid。 */
        const covFormat = dv.getUint16(covOff, false);
        const covCount = dv.getUint16(covOff + 2, false);
        if ((covFormat === 1 || covFormat === 2) && covCount > 0) {
          const firstGid = dv.getUint16(covOff + 4, false);
          if (!inSubset(firstGid)) {
            triggerable = false;
            failGid.v = firstGid;
            break;
          }
        }
        /** 首 gid 在 reachable：完整检查该 coverage 的全部 gid（首 gid 之外的可能 excluded） */
        const excluded = coverageFirstExcludedGid(r, covOff, covCache, inSubset);
        if (excluded >= 0) {
          triggerable = false;
          /** 记录使其失败的 gid，供调用方跨轮跳过：该 gid 未进 reachable 前，本 subtable 必定仍 false。 */
          failGid.v = excluded;
          break;
        }
      }
      p += cnt * 2;
    }
    if (triggerable) {
      /** 第二遍（仅 triggerable=true）：收集三段 coverage 的全部 gid 到 contextGids。
       *  此刻 coverage 全部 gid 都在 reachable（已被 coverageFirstExcludedGid 确认），展开安全且量小。 */
      let p2 = off + 2;
      for (let seg = 0; seg < 3; seg++) {
        const cnt = r.u16(p2);
        p2 += 2;
        for (let k = 0; k < cnt; k++) {
          const covGids = readCoverageGids(r, off + dv.getUint16(p2 + k * 2, false), covCache);
          for (const g of covGids) contextGids.add(g);
        }
        p2 += cnt * 2;
      }
      const substCount = r.u16(p2);
      for (let k = 0; k < substCount; k++) refs.add(dv.getUint16(p2 + 2 + k * 4 + 2, false));
      /** triggerable=true：三段 coverage gid 全在 reachable（reachable 单调，后续仍全在），
       *  refs/contextGids 已确定，不随 reachable 扩展变化 → 稳定，可跨轮跳过。 */
      return true;
    }
    /** triggerable=false：某 coverage gid 不在 reachable，后续 reachable 扩展可能使其进入 → 不稳定。 */
    return false;
  }
  return false;
}

/**
 * 从一条 ChainSubstRule 收集引用的 lookup index 与 context gid。
 * @param isGidFormat true=format1（元素为 gid，需 inSubset 判断且收集 gid）；
 *                    false=format2（元素为 class index，原样保留，不判断不收集）。
 * 规则全部 context gid 在子集时才收集 refs（format1）；format2 class index 始终收集。
 *
 * 优化（消除中间数组）：原实现先读全部 backtrack/input/lookahead 到 3 个临时数组再判断，
 * format1 每 rule 分配 3 个 number[]（FiraCode 424 次/call × 3 = 1272 次数组分配）。
 * 改为两遍扫描：第一遍仅用 inSubset 校验全部 gid（不分配数组，遇子集外 gid 即 return）；
 * 通过校验后再第二遍收集 context gid 并读 subst records。format1 规则触发是少数，第二遍开销可忽略。
 */
function collectChainRuleRefs(
  r: OTReader,
  ruleOff: number,
  refs: Set<number>,
  contextGids: Set<number>,
  inSubset: (gid: number) => boolean,
  isGidFormat: boolean,
): void {
  /** format1/2 rule: backtrackCount + backtrack[] + inputCount + input[] + lookaheadCount + lookahead[] + substCount + substRecords[] */
  /** 缓存 dv：chain format1 规则密集调用（FiraCode 180 fmt1 规则 × 6+ 次 u16），直接 getUint16 省方法调用+边界检查 */
  const dv = r.dv;
  let p = ruleOff;
  const backtrackCount = r.u16(p); p += 2;
  const backtrackEnd = p + backtrackCount * 2;
  const inputCount = r.u16(backtrackEnd); p = backtrackEnd + 2;
  /** input 数组长度 = inputCount - 1（第一分量在 coverage，rule 内只存后续分量） */
  const inputLen = inputCount > 0 ? inputCount - 1 : 0;
  const inputEnd = p + inputLen * 2;
  const lookaheadCount = r.u16(inputEnd); p = inputEnd + 2;
  const lookaheadEnd = p + lookaheadCount * 2;
  const substCount = r.u16(lookaheadEnd); p = lookaheadEnd + 2;

  /** format1：全部 context gid 在子集才触发（先校验再收集，避免中间数组）；format2：class index 始终「可触发」（保守） */
  if (isGidFormat) {
    /** 第一遍：校验 backtrack + input + lookahead 全部 gid 在子集（遇子集外即放弃规则） */
    let q = ruleOff + 2;
    for (let k = 0; k < backtrackCount; k++) {
      if (!inSubset(dv.getUint16(q + k * 2, false))) return;
    }
    q += backtrackCount * 2 + 2;
    for (let k = 0; k < inputLen; k++) {
      if (!inSubset(dv.getUint16(q + k * 2, false))) return;
    }
    q += inputLen * 2 + 2;
    for (let k = 0; k < lookaheadCount; k++) {
      if (!inSubset(dv.getUint16(q + k * 2, false))) return;
    }
    /** 第二遍：全部在子集，收集 context gid */
    q = ruleOff + 2;
    for (let k = 0; k < backtrackCount; k++) contextGids.add(dv.getUint16(q + k * 2, false));
    q += backtrackCount * 2 + 2;
    for (let k = 0; k < inputLen; k++) contextGids.add(dv.getUint16(q + k * 2, false));
    q += inputLen * 2 + 2;
    for (let k = 0; k < lookaheadCount; k++) contextGids.add(dv.getUint16(q + k * 2, false));
  }
  for (let k = 0; k < substCount; k++) {
    /** SubstLookupRecord: sequenceIndex(2) + lookupListIndex(2) */
    refs.add(dv.getUint16(p + k * 4 + 2, false));
  }
}
