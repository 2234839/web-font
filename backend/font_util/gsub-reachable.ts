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
  const format = r.u16(off);
  const gids: number[] = [];
  if (format === 1) {
    const count = r.u16(off + 2);
    for (let i = 0; i < count; i++) gids.push(r.u16(off + 4 + i * 2));
  } else if (format === 2) {
    const rangeCount = r.u16(off + 2);
    let p = off + 4;
    for (let i = 0; i < rangeCount; i++) {
      const start = r.u16(p);
      const end = r.u16(p + 2);
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
  const format = r.u16(off);
  if (format === 1) {
    const count = r.u16(off + 2);
    for (let i = 0; i < count; i++) {
      const g = r.u16(off + 4 + i * 2);
      if (!inSubset(g)) return g;
    }
    return -1;
  } else if (format === 2) {
    const rangeCount = r.u16(off + 2);
    let p = off + 4;
    for (let i = 0; i < rangeCount; i++) {
      const start = r.u16(p);
      const end = r.u16(p + 2);
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
    const lOff = lookupListOff + r.u16(lookupListOff + 2 + i * 2);
    const lookupType = r.u16(lOff);
    const subTableCount = r.u16(lOff + 4);
    const subtableAbsOffs: number[] = [];
    let effectiveType = lookupType;
    for (let j = 0; j < subTableCount; j++) {
      const subOff = lOff + r.u16(lOff + 6 + j * 2);
      if (lookupType === LT_EXTENSION) {
        if (r.u16(subOff) !== 1) {
          effectiveType = -1;
          continue;
        }
        effectiveType = r.u16(subOff + 2);
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
  /** 当前「在子集内」= reachable（已含 seed） */
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
  if (type === LT_SINGLE) {
    /** SingleSubst: format1 coverage+delta / format2 coverage+gidArray */
    const format = r.u16(off);
    const covOff = off + r.u16(off + 2);
    const covGids = readCoverageGids(r, covOff, covCache);
    if (format === 1) {
      const delta = r.i16(off + 4);
      for (const g of covGids) {
        if (inSubset(g)) targets.push((g + delta) & 0xffff);
      }
    } else if (format === 2) {
      /** 反转遍历方向：coverage（avg 103 gid，命中率 <4%）远大于 reachable（初夏标点 53）。
       *  遍历 covGids 查 reachable 是 9180 次 Set.has/round；改为遍历 reachable 二分查 covGids 得 index。
       *  covGids 按 gid 升序（fmt1 list / fmt2 range 展开），可二分。 */
      const count = r.u16(off + 4);
      const lim = covGids.length < count ? covGids.length : count;
      const gidArrBase = off + 6;
      for (const g of reachable) {
        /** 二分 covGids[0..lim) 找 g 的 index */
        let lo = 0, hi = lim;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const mg = covGids[mid];
          if (mg < g) lo = mid + 1;
          else if (mg > g) hi = mid;
          else { targets.push(r.u16(gidArrBase + mid * 2)); break; }
        }
      }
    }
  } else if (type === LT_MULTIPLE) {
    const covOff = off + r.u16(off + 2);
    const seqCount = r.u16(off + 4);
    const covGids = readCoverageGids(r, covOff, covCache);
    for (let i = 0; i < covGids.length && i < seqCount; i++) {
      if (!inSubset(covGids[i])) continue;
      const seqOff = off + r.u16(off + 6 + i * 2);
      const glyphCount = r.u16(seqOff);
      for (let k = 0; k < glyphCount; k++) targets.push(r.u16(seqOff + 2 + k * 2));
    }
  } else if (type === LT_ALTERNATE) {
    const covOff = off + r.u16(off + 2);
    const altCount = r.u16(off + 4);
    const covGids = readCoverageGids(r, covOff, covCache);
    for (let i = 0; i < covGids.length && i < altCount; i++) {
      if (!inSubset(covGids[i])) continue;
      const altOff = off + r.u16(off + 6 + i * 2);
      const cnt = r.u16(altOff);
      for (let k = 0; k < cnt; k++) targets.push(r.u16(altOff + 2 + k * 2));
    }
  } else if (type === LT_LIGATURE) {
    /** LigatureSubst: 全部 component 在子集 → target gid */
    const covOff = off + r.u16(off + 2);
    const setCount = r.u16(off + 4);
    const covGids = readCoverageGids(r, covOff, covCache);
    for (let i = 0; i < covGids.length && i < setCount; i++) {
      const firstInSubset = inSubset(covGids[i]);
      const setOff = off + r.u16(off + 6 + i * 2);
      const ligCount = r.u16(setOff);
      for (let j = 0; j < ligCount; j++) {
        const ligOff = setOff + r.u16(setOff + 2 + j * 2);
        const compCount = r.u16(ligOff);
        const target = r.u16(ligOff + 2);
        /** 第一分量需在子集（若 first 不在子集，整条 ligature 不会触发） */
        if (!firstInSubset) continue;
        let allIn = true;
        for (let k = 0; k < compCount - 1; k++) {
          if (!inSubset(r.u16(ligOff + 4 + k * 2))) {
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
  if (format === 1) {
    /** format1: coverage(gid) + SubRuleSet 数组，按 coverage gid 索引 */
    const covOff = off + r.u16(off + 2);
    const covGids = readCoverageGids(r, covOff, covCache);
    const setCount = r.u16(off + 4);
    for (let i = 0; i < covGids.length && i < setCount; i++) {
      /** 第一分量（coverage gid）须在子集，否则该 SubRuleSet 不触发 */
      if (!inSubset(covGids[i])) continue;
      contextGids.add(covGids[i]);
      const setOffRel = r.u16(off + 6 + i * 2);
      if (setOffRel === 0) continue;
      const setOff = off + setOffRel;
      const ruleCount = r.u16(setOff);
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + r.u16(setOff + 2 + j * 2);
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
      const setOffRel = r.u16(off + 12 + i * 2);
      if (setOffRel === 0) continue;
      const setOff = off + setOffRel;
      const ruleCount = r.u16(setOff);
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + r.u16(setOff + 2 + j * 2);
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
     *  （初夏纯标点 280 个 format3 首轮全 false）。失败时只需找到第一个不在 reachable 的 gid 记入
     *  failGid 供跨轮跳过——此时 contextGids 的收集无意义：break 前已检查的 gid 都在 reachable
     *  （inSubset=reachable.has），调用方对其 reachable.add 是 no-op。故失败路径用
     *  coverageFirstExcludedGid 边读边查（format2 range 不预展开），命中即返回，完全省掉
     *  readCoverageGids 的完整展开 + 数组分配。仅 triggerable=true 时（coverage 全在子集、量小）
     *  才 readCoverageGids 收集 contextGids。 */
    let p = off + 2;
    let triggerable = true;
    /** 第一遍：逐 coverage 找首个不在子集的 gid，全在子集则 triggerable 保持 true */
    for (let seg = 0; seg < 3 && triggerable; seg++) {
      const cnt = r.u16(p);
      p += 2;
      for (let k = 0; k < cnt; k++) {
        const covOff = off + r.u16(p + k * 2);
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
          const covGids = readCoverageGids(r, off + r.u16(p2 + k * 2), covCache);
          for (const g of covGids) contextGids.add(g);
        }
        p2 += cnt * 2;
      }
      const substCount = r.u16(p2);
      for (let k = 0; k < substCount; k++) refs.add(r.u16(p2 + 2 + k * 4 + 2));
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
      if (!inSubset(r.u16(q + k * 2))) return;
    }
    q += backtrackCount * 2 + 2;
    for (let k = 0; k < inputLen; k++) {
      if (!inSubset(r.u16(q + k * 2))) return;
    }
    q += inputLen * 2 + 2;
    for (let k = 0; k < lookaheadCount; k++) {
      if (!inSubset(r.u16(q + k * 2))) return;
    }
    /** 第二遍：全部在子集，收集 context gid */
    q = ruleOff + 2;
    for (let k = 0; k < backtrackCount; k++) contextGids.add(r.u16(q + k * 2));
    q += backtrackCount * 2 + 2;
    for (let k = 0; k < inputLen; k++) contextGids.add(r.u16(q + k * 2));
    q += inputLen * 2 + 2;
    for (let k = 0; k < lookaheadCount; k++) contextGids.add(r.u16(q + k * 2));
  }
  for (let k = 0; k < substCount; k++) {
    /** SubstLookupRecord: sequenceIndex(2) + lookupListIndex(2) */
    refs.add(r.u16(p + k * 4 + 2));
  }
}
