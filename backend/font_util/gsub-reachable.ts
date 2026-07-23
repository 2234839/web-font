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
const LT_REVERSE_CHAIN = 5;
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
  const lookupRelOffs: number[] = [];
  for (let i = 0; i < lookupCount; i++) {
    lookupRelOffs.push(r.u16(lookupListOff + 2 + i * 2));
  }

  /** 解析每个 lookup 的 (effectiveType, subtableAbsOffs) */
  interface LookupParsed {
    effectiveType: number;
    subtableAbsOffs: number[];
  }
  const lookups: LookupParsed[] = [];
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

  while (changed) {
    changed = false;
    for (let i = 0; i < lookupCount; i++) {
      const lk = lookups[i];
      for (const subAbs of lk.subtableAbsOffs) {
        if (lk.effectiveType === LT_CHAIN) {
          /** type6：收集可触发规则引用的 lookup index 与所需 context gid */
          refsReuse.clear();
          ctxGidsReuse.clear();
          collectChainRefs(r, subAbs, refsReuse, ctxGidsReuse, inSubset, covCache);
          for (const g of ctxGidsReuse) {
            if (!reachable.has(g)) { reachable.add(g); changed = true; }
          }
          for (const li of refsReuse) {
            const refLk = lookups[li];
            if (!refLk) continue;
            for (const refSub of refLk.subtableAbsOffs) {
              const refTargets = collectSubtableTargets(r, refSub, refLk.effectiveType, inSubset, covCache);
              for (const g of refTargets) {
                if (!reachable.has(g)) { reachable.add(g); changed = true; }
              }
            }
          }
        } else {
          const newTargets = collectSubtableTargets(r, subAbs, lk.effectiveType, inSubset, covCache);
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
      const count = r.u16(off + 4);
      for (let i = 0; i < covGids.length && i < count; i++) {
        if (inSubset(covGids[i])) targets.push(r.u16(off + 6 + i * 2));
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
): void {
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
  } else if (format === 3) {
    /** format3: 显式 coverage 数组 + SubstLookupRecords。
     *  三个 coverage 数组（backtrack/input/lookahead）的 gid 须全在子集才触发。
     *  优化：triggerable 一旦为 false 即短路（无需继续遍历后续 coverage，原代码无短路会读完全部）；
     *  去掉原 readCovGids 闭包 + allGids 中间数组（collectChainRefs 在固定点迭代中高频调用，
     *  初夏纯标点 840 次/call），triggerable 时 gid 直接 add 进 contextGids，省 allGids 中转。 */
    let p = off + 2;
    let triggerable = true;
    const readCovGidsChecked = (cnt: number): void => {
      for (let k = 0; k < cnt; k++) {
        const covGids = readCoverageGids(r, off + r.u16(p + k * 2), covCache);
        for (const g of covGids) {
          if (!inSubset(g)) {
            triggerable = false;
            return;
          }
          contextGids.add(g);
        }
      }
      p += cnt * 2;
    };
    const backtrackCount = r.u16(p); p += 2;
    readCovGidsChecked(backtrackCount);
    if (triggerable) {
      const inputCount = r.u16(p); p += 2;
      readCovGidsChecked(inputCount);
    }
    if (triggerable) {
      const lookaheadCount = r.u16(p); p += 2;
      readCovGidsChecked(lookaheadCount);
    }
    if (triggerable) {
      const substCount = r.u16(p);
      for (let k = 0; k < substCount; k++) refs.add(r.u16(p + 2 + k * 4 + 2));
    }
  }
}

/**
 * 从一条 ChainSubstRule 收集引用的 lookup index 与 context gid。
 * @param isGidFormat true=format1（元素为 gid，需 inSubset 判断且收集 gid）；
 *                    false=format2（元素为 class index，原样保留，不判断不收集）。
 * 规则全部 context gid 在子集时才收集 refs（format1）；format2 class index 始终收集。
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
  const backRaw: number[] = [];
  for (let k = 0; k < backtrackCount; k++) backRaw.push(r.u16(p + k * 2));
  p += backtrackCount * 2;
  const inputCount = r.u16(p); p += 2;
  const inputRaw: number[] = [];
  for (let k = 0; k < inputCount - 1; k++) inputRaw.push(r.u16(p + k * 2));
  p += (inputCount - 1) * 2;
  const lookaheadCount = r.u16(p); p += 2;
  const lookRaw: number[] = [];
  for (let k = 0; k < lookaheadCount; k++) lookRaw.push(r.u16(p + k * 2));
  p += lookaheadCount * 2;
  const substCount = r.u16(p); p += 2;

  /** format1：全部 context gid 在子集才触发；format2：class index 始终「可触发」（保守） */
  if (isGidFormat) {
    for (const arr of [backRaw, inputRaw, lookRaw]) {
      for (const g of arr) {
        if (!inSubset(g)) return; /** 含子集外 gid，规则不触发 */
      }
      for (const g of arr) contextGids.add(g);
    }
  }
  for (let k = 0; k < substCount; k++) {
    /** SubstLookupRecord: sequenceIndex(2) + lookupListIndex(2) */
    refs.add(r.u16(p + k * 4 + 2));
  }
}
