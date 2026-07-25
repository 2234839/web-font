/**
 * GSUB 表子集化器
 *
 * GSUB（Glyph Substitution Table）控制字形替换：连字（ligature，如 FiraCode 的 != → ≠）、
 * 上下文替换（calt）、字形组合分解（ccmp）等。子集化后 glyphId 被重编号，fonteditor-core 的
 * GSUB 读写器是原始字节透传，不会按子集字形重映射 coverage/ClassDef，导致浏览器用新 glyphId
 * 查 GSUB coverage 查不到，连字/替换规则失效，子集字体与原字体人眼不一致（墨量差异、形状错位）。
 *
 * 本模块按 OpenType 1.9.1 规范解析 GSUB，对主要 lookup 类型的 coverage/ClassDef/替换目标 gid
 * 做 原gid→新gid 重映射后重新序列化：
 *   - LookupType 1 SingleSubst（单字形替换，format1 delta / format2 数组）
 *   - LookupType 2 MultipleSubst（一换多）
 *   - LookupType 3 AlternateSubst（一换多选一）
 *   - LookupType 4 LigatureSubst（多换一，连字核心）
 *   - LookupType 6 ChainedContextSubst（链式上下文，重映射 coverage/ClassDef，保留 lookup index 引用）
 *   - LookupType 7 Extension（解包后递归处理内嵌 lookup）
 *
 * 遇到不支持的 lookup 类型（如 type5 ReverseChain）时该 lookup 原样拷贝字节（gid 不重映射，
 * 浏览器查不到 coverage 会跳过，不会破坏字体；缺失的功能仅影响该 lookup 覆盖的字形）。
 *
 * @reference https://learn.microsoft.com/en-us/typography/opentype/spec/gsub
 */

import { OTWriter as Writer, OTReader as Reader, serializeScriptList, serializeFeatureList, scriptListSpan, featureListSpan } from "./ot-bytes.js";
import { coverageIndexOf, coverageCount } from "./gsub-reachable.js";

/** GSUB lookup 类型常量 */
const LT_SINGLE = 1;
const LT_MULTIPLE = 2;
const LT_ALTERNATE = 3;
const LT_LIGATURE = 4;
const LT_CHAIN = 6;
const LT_EXTENSION = 7;

/** Coverage format 常量 */
const COV_LIST = 1;
const COV_RANGE = 2;

/**
 * 重映射单个 gid。子集外的 gid 返回 null。
 * GSUB 中 coverage/ClassDef/替换目标引用的 gid 若不在子集内，该条目失效，调用方丢弃之。
 */
function remapGid(origToNew: Map<number, number>, gid: number): number | null {
  const m = origToNew.get(gid);
  return m === undefined ? null : m;
}

/** Coverage 表单个 range 展开为 gid 的上限保护：超出视为偏移错位读到垃圾数据。 */
const COVERAGE_MAX_EXPAND = 0x10000;

/**
 * Coverage 解析缓存（off → 解析条目）。
 * FiraCode 等 calt 字体的 ChainContextSubst format3 中，同一个 coverage 被大量 subtable
 * 重复引用（实测 604 次引用 / 83 个独立 coverage，最热 coverage 被引 126 次）。
 * 缓存「原 gid 解析」与「重映射后新 gid」两层结果，消除 ~86% 的重复 u16 读取、
 * map/filter 与数组分配（subsetGSUB 第一大 CPU+GC 热点）。
 * 生命周期与单次 subsetGSUB 调用绑定，origToNew 不变故结果稳定可复用。
 */
interface CoverageCacheEntry {
  /** 原 gid 列表（type1/2/3/4 按 index 配对用） */
  gids: number[];
  /** 重映射后新 gid 列表（format3 coverage 数组直接用），懒计算；null 表示尚未计算 */
  remapped: number[] | null;
  /** 原 coverage 非空但全部 gid 落子集外 → true，调用方据此判该 coverage 失效（区别于原本就空的合法 coverage） */
  outOfSubset: boolean;
}
type CoverageCache = Map<number, CoverageCacheEntry>;

/** readCoverageRemapped 占位用的空数组（gids 字段未由其填充的标记）。
 *  readCoverageGids 见到 entry 但 gids 为此实例时，按 miss 处理重新计算。
 *  用单例引用避免每次 set 分配新空数组。 */
const EMPTY_GIDS: number[] = [];

/**
 * 原gid → 新gid 的数组查找表（热路径专用）。
 * origToNew 是 Map<number,number>，每次 .get() 哈希查询开销大；coverage 解析对每个原 gid 都查一次，
 * 密度极高。构建索引数组（下标=原gid，值=新gid，-1 表示不在子集）后，查询退化为数组索引，
 * 比 Map.get 快数倍（subsetGSUB readCoverageRemapped 的主热点）。
 * 用 Int32Array——TypedArray.fill 是 native memset，比 number[].fill 快约 3×
 * （初夏明朝 subsetGids 仅十余个但 maxOrigGid 达 3.5 万，number[].fill(-1) 耗时 ~200μs，
 * Int32Array.fill 仅 ~67μs，省 subsetGSUB 总耗时 ~6%）。索引访问速度与 number[] 实测一致。
 * 越界访问（gid >= length）返回 undefined，>= 0 判定为不在子集，语义正确。
 */
type GidLookup = Int32Array;

/**
 * 当前 subsetGSUB 调用的子集原始 gid 升序数组，供 readClassDefMap format2 二分优化复用。
 *
 * subsetGSUB 同步单线程执行，每次入口重置此变量；避免将 sortedSubsetGids 参数穿透
 * serializeSubtable → serializeChainedContextSubst → writeChainFormat2 → readClassDefMap 多层。
 *
 * 优化336：惰性构造。原入口无条件 `Array.from(origToNew.keys()).sort()`——全字符集（27677 gid）
 * sort 耗 ~3.2ms，但仅 readClassDefMap format2 路径需要。无 ClassDef format2 的字体（令东无 GSUB、
 * 霞鹜/初夏 GSUB 多 format3）这 3.2ms 是纯浪费。改为首次 format2 访问时按需构造并缓存。
 */
let currentSortedSubsetGids: number[] | null = null;
/** 惰性构造的源 Map（subsetGSUB 入口设），首次 format2 访问时 Array.from(.keys()).sort() */
let currentSortedSubsetSource: Map<number, number> | null = null;

/** 惰性获取升序子集 gid 数组（首次调用构造，后续复用缓存） */
function getSortedSubsetGids(): number[] {
  if (currentSortedSubsetGids === null) {
    currentSortedSubsetGids = currentSortedSubsetSource
      ? Array.from(currentSortedSubsetSource.keys()).sort((a, b) => a - b)
      : [];
  }
  return currentSortedSubsetGids;
}

/** 读取 Coverage 表，返回覆盖的原 gid 列表（保持顺序）。
 *  传入 cache 时按 coverage 绝对偏移缓存解析结果（同一 off 复用同一数组实例）。
 *  热路径：coverage 偏移来自已验证的 subtable 结构（合法范围），直接用 dv.getUint16 绕过
 *  u16 的逐次边界检查 + errorFlag 判定（subsetGSUB 第一大 CPU 热点，调用密度极高）。 */
function readCoverageGids(r: Reader, off: number, cache?: CoverageCache): number[] {
  if (cache) {
    const hit = cache.get(off);
    /** hit.gids === EMPTY_GIDS 表示该 entry 由 readCoverageRemapped 填充（只写了 remapped/newGids，
     *  gids 是占位空数组）。原始 gid 未被缓存，按 miss 处理重新计算并回填 gids 字段，
     *  避免把 newGids 当原始 gid 返回（covCache 共享语义不一致 Bug）。 */
    if (hit !== undefined && hit.gids !== EMPTY_GIDS) return hit.gids;
  }
  const dv = r.dv;
  const len = dv.byteLength;
  /** coverage 偏移合法性兜底：越界则按错误处理（返回空，调用方降级） */
  if (off < 0 || off + 4 > len) {
    if (cache) mergeGidsEntry(cache, off, []);
    return [];
  }
  const format = dv.getUint16(off, false);
  let gids: number[] = [];
  if (format === COV_LIST) {
    const count = dv.getUint16(off + 2, false);
    const base = off + 4;
    if (base + count * 2 > len) {
      if (cache) mergeGidsEntry(cache, off, []);
      return [];
    }
    /** 预分配 + 索引赋值，避免 push 动态扩容（format1 coverage 的高频热循环） */
    gids = new Array(count);
    for (let i = 0; i < count; i++) gids[i] = dv.getUint16(base + i * 2, false);
  } else if (format === COV_RANGE) {
    const rangeCount = dv.getUint16(off + 2, false);
    let p = off + 4;
    for (let i = 0; i < rangeCount; i++) {
      /** range 记录 6 字节，越界说明偏移错位读到垃圾 rangeCount，停止解析（返回已收集部分） */
      if (p + 6 > len) break;
      const start = dv.getUint16(p, false);
      const end = dv.getUint16(p + 2, false);
      /** 偏移错位会读到 end < start 或区间异常大的垃圾 range。
       *  Coverage 的 gid 总数不可能超过字体 glyph 总数（< 0x10000），
       *  累计展开超出上限视为损坏数据，停止展开（返回已收集的部分，调用方按子集过滤，多余 gid 自然被丢弃）。 */
      if (end >= start && end - start < COVERAGE_MAX_EXPAND && gids.length + (end - start + 1) <= COVERAGE_MAX_EXPAND) {
        for (let g = start; g <= end; g++) gids.push(g);
      }
      /** startCoverageIndex（uint16）未使用，跳过 */
      p += 6;
    }
  }
  if (cache) mergeGidsEntry(cache, off, gids);
  return gids;
}

/**
 * 把「原始 gid 列表」合并进 covCache 的 entry，保留 readCoverageRemapped 已写入的
 * remapped/outOfSubset 字段（避免 readCoverageGids 回填时覆盖 fmt3 缓存的重映射结果）。
 * entry 不存在则新建（remapped=null 表示尚未由 readCoverageRemapped 计算过）。
 */
function mergeGidsEntry(cache: CoverageCache, off: number, gids: number[]): void {
  const existing = cache.get(off);
  if (existing !== undefined) {
    existing.gids = gids;
  } else {
    cache.set(off, { gids, remapped: null, outOfSubset: false });
  }
}

/**
 * 读取 coverage 并返回重映射后的新 gid 列表（带缓存）。
 * format3 的 coverage 不需要 index 配对（只需"子集内新 gid 集合"），故边解析边过滤，
 * 直接产出新 gid 数组、不分配中间的原 gid 数组（format3 是 subsetGSUB 最大热点，省一次完整数组分配）。
 * 解析+重映射结果按 off 缓存：同一 coverage 被多个 subtable 引用时只算一次。
 * @returns 重映射后新 gid 数组（保持顺序）；原 coverage 非空但全部 gid 落子集外时返回 null，
 *          调用方据此判该 coverage 失效。
 */
function readCoverageRemapped(
  r: Reader,
  off: number,
  gidLookup: GidLookup,
  cache: CoverageCache,
): number[] | null {
  let entry = cache.get(off);
  if (entry !== undefined) {
    /** readCoverageRemapped 自己填的 entry：gids===EMPTY_GIDS（占位），remapped 已算好可直接返回。
     *  readCoverageGids 填的 entry：gids 是原始 gid 数组、remapped=null、outOfSubset=false（默认）。
     *  命中后者时不能直接返回 entry.remapped（null 会被当 outOfSubset 语义，错判 coverage 失效，
     *  改变 fmt3 预检结果致 FiraCode calt 输出变化）——须从已缓存的原始 gids 现场重映射。
     *  此分支仅在 covOff 跨 readCoverageGids/readCoverageRemapped 共享时命中（罕见），正常路径走自己的 entry。 */
    if (entry.gids !== EMPTY_GIDS) {
      const ogids = entry.gids;
      const m = new Array<number>(ogids.length);
      let w2 = 0;
      for (let i = 0; i < ogids.length; i++) {
        const ng = gidLookup[ogids[i]];
        if (ng >= 0) m[w2++] = ng;
      }
      m.length = w2;
      /** 与首次计算一致：空且原非空→outOfSubset。entry 由 readCoverageGids 填时 outOfSubset 恒 false，
       *  无法区分「原 coverage 空」与「全子集外」——保守按 ogids.length>0 判 origNonEmpty。 */
      const oos = w2 === 0 && ogids.length > 0;
      /** 回填 remapped/outOfSubset 供后续 readCoverageRemapped 命中（保留 gids 不动供 readCoverageGids） */
      entry.remapped = m;
      entry.outOfSubset = oos;
      return oos ? null : m;
    }
    /** readCoverageRemapped 自己的 entry：失效返回 null，否则返回重映射数组 */
    return entry.outOfSubset ? null : (entry.remapped as number[]);
  }
  const dv = r.dv;
  const len = dv.byteLength;
  /** 失效/空结果占位（首次计算后回填 cache） */
  let newGids: number[] = [];
  let origNonEmpty = false;
  let outOfSubset = false;
  if (off < 0 || off + 4 > len) {
    /** 越界，按空 coverage 处理 */
  } else {
    const format = dv.getUint16(off, false);
    if (format === COV_LIST) {
      const count = dv.getUint16(off + 2, false);
      /** 损坏/错位 coverage 兜底：coverage 的 gid 是 glyph index，count 不可能超过字体 glyph 总数
       *  （= gidLookup.length）。FiraCode 实测 77 次 format1 miss 中有 8 次 count 高达 15460（远超
       *  glyph 总数 1652）——这些是 ChainContextSubst format3 中指向错误偏移读到的垃圾 count，
       *  原代码会循环 count 次（全部 gidLookup[g] 越界返回 undefined 被 >=0 跳过），浪费 107852 次
       *  迭代（占 readCoverageRemapped 总工作量的 95%）。
       *  跳过循环但保持原语义：count > 0 仍令 origNonEmpty=true → newGids 空 → outOfSubset=true → 返回 null，
       *  与原代码循环全空的结果完全等价（调用方据此判该 coverage/subtable 失效）。 */
      const numGlyphs = gidLookup.length;
      const base = off + 4;
      if (base + count * 2 > len) {
        /** 数据范围越界：原代码不进入循环，origNonEmpty 保持 false，返回空数组 */
      } else if (count > numGlyphs) {
        /** 损坏 coverage（count 超过 glyph 总数，gidLookup 全部越界）：跳过必然全空的循环，
         *  仅保留 origNonEmpty=count>0 语义 → newGids 空 → outOfSubset=true → 返回 null，与原代码循环全空完全等价 */
        origNonEmpty = count > 0;
      } else {
        origNonEmpty = count > 0;
        /** 预分配最大容量 count，索引写入后截断长度，避免 push 动态扩容（format1 是 coverage 热路径） */
        const buf = new Array(count);
        let w = 0;
        /** 批量读优化：coverage format1 的 gid 列表是连续 count 个大端 u16。
         *  DataView.getUint16 每次有边界检查 + 大端组装开销；gid 数组若 2 字节对齐，
         *  用 Uint16Array view 共享 buffer 读取 + 内联翻转更快（与 hmtx/loca 同思路）。 */
        const gidArrByteOff = dv.byteOffset + base;
        if ((gidArrByteOff & 1) === 0) {
          const src16 = new Uint16Array(dv.buffer, gidArrByteOff, count);
          for (let i = 0; i < count; i++) {
            const raw = src16[i];
            /** 内联大端翻转（与 hmtx/loca 一致）：((raw & 0xff) << 8) | (raw >> 8) */
            const m = gidLookup[((raw & 0xff) << 8) | (raw >> 8)];
            if (m >= 0) buf[w++] = m;
          }
        } else {
          for (let i = 0; i < count; i++) {
            const m = gidLookup[dv.getUint16(base + i * 2, false)];
            if (m >= 0) buf[w++] = m;
          }
        }
        buf.length = w;
        newGids = buf;
      }
    } else if (format === COV_RANGE) {
      const rangeCount = dv.getUint16(off + 2, false);
      /** range end 上限 = glyph 总数 - 1。gidLookup[g] 对 g >= numGlyphs 必然越界（不在子集），
       *  故将每个 range 的 end clamp 到 numGlyphs-1、start >= numGlyphs 的 range 直接跳过，
       *  与原代码逐 gid 遍历全越界跳过的结果完全等价。
       *  FiraCode 实测 11 次 format2 miss 含 439 个 end >= numGlyphs 的越界 range，逐 gid 展开浪费
       *  ~320 万次 gidLookup 索引（占 readCoverageRemapped 总工作量绝大头）。 */
      const numGlyphs = gidLookup.length;
      /**
       * 优化（range 二分而非展开，与 readClassDefMap format2 同思路 [[gsub-classdef-format2-bsearch]]）：
       * 原实现逐 gid 遍历 [start..e] 全部查 gidLookup（FiraCode 实测 coverage format2 首次展开共 2317 gid，
       * 子集仅占极小部分）。改为在升序子集 gid 数组上二分定位 [start,end] 内的 gid，仅 push 命中的 newGid。
       * range 顺序遍历 + range 内子集 gid 升序扫描 → newGids 保持 gid 升序（与原展开顺序一致）。 */
      const subsetGids = getSortedSubsetGids();
      const subsetLen = subsetGids.length;
      let p = off + 4;
      for (let i = 0; i < rangeCount; i++) {
        if (p + 6 > len) break;
        const start = dv.getUint16(p, false);
        const end = dv.getUint16(p + 2, false);
        /** COVERAGE_MAX_EXPAND 上限保护保留（与原代码一致）：超大 range（损坏数据）整体跳过。
         *  二分本身是 O(log) 不会因 range 大而慢，但保留此检查以维持与原实现完全一致的边界语义。 */
        if (end >= start && end - start < COVERAGE_MAX_EXPAND && newGids.length + (end - start + 1) <= COVERAGE_MAX_EXPAND) {
          if (start >= numGlyphs) {
            /** 整个 range 越界：原代码逐 gid 遍历全跳过 push 但会设 origNonEmpty=true，此处保持等价语义
             *  （→ newGids 空、origNonEmpty=true → outOfSubset → 返回 null） */
            origNonEmpty = true;
          } else if (subsetLen > 0) {
            /** clamp end 到合法 gid 范围；与原代码 clamp 后逐 gid 处理 [start..e] 完全等价，
             *  但用子集 gid 二分仅处理落在范围内的子集 gid */
            const e = end < numGlyphs ? end : numGlyphs - 1;
            /** range 含至少一个合法 gid（start<=e）即 origNonEmpty=true，无论是否命中子集——
             *  与原代码逐 gid 遍历 [start..e] 必设 origNonEmpty=true 一致（即使全无子集命中） */
            origNonEmpty = true;
            if (!(e < subsetGids[0] || start > subsetGids[subsetLen - 1])) {
              /** 二分定位第一个 >= start 的子集 gid，顺序扫描到 > e 为止 */
              let lo = 0;
              let hi = subsetLen;
              while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (subsetGids[mid] < start) lo = mid + 1;
                else hi = mid;
              }
              for (let j = lo; j < subsetLen; j++) {
                const g = subsetGids[j];
                if (g > e) break;
                newGids.push(gidLookup[g]);
              }
            }
          } else {
            /** 子集为空（理论不会，subsetGSUB 必有 .notdef）：保持 origNonEmpty 语义 */
            origNonEmpty = true;
          }
        }
        p += 6;
      }
    }
  }
  /** 原 coverage 非空但全部 gid 落子集外 → 失效（与原 coverage 本就空的合法空数组区分） */
  if (newGids.length === 0 && origNonEmpty) outOfSubset = true;
  /** 缓存前升序排序：原 coverage gid 升序，但 原gid→新gid 映射不保序（subsetGids 重编号），
   *  过滤后的新 gid 可能乱序。readCoverageRemapped 的输出只作为「gid 集合」传给 emitCoverage，
   *  调用方均不依赖顺序（fmt3 coverage / writeChainFormat2 coverage），故在缓存入口统一排序，
   *  使缓存数组天然升序无重复——emitCoverageSorted 据此跳过 slice+sort（fmt3 高频热路径）。
   *  排序发生在每个 coverage off 首次计算（covCache 命中率极高，FiraCode 604 引用/83 独立 coverage），
   *  分摊到所有引用几乎免费。 */
  if (!outOfSubset && newGids.length > 1) newGids.sort((a, b) => a - b);
  /** 只写 remapped 字段，不碰 gids 字段。
   *  covCache 被 readCoverageRemapped（fmt3 用，产 newGids）与 readCoverageGids
   *  （fmt1 ChainContext 用，需原始 gid 按 index 与 ruleSet 配对）共享。
   *  若此处把 newGids 写进 gids 字段，后续 fmt1 经 readCoverageGids 命中同一 off 时，
   *  会拿到 newGids 当原始 gid 二次重映射，连字规则错位（FiraCode 字节不一致 Bug 的根因）。
   *  gids 字段留空数组占位，readCoverageGids miss 时自行计算回填（见其实现）。 */
  cache.set(off, { gids: EMPTY_GIDS, remapped: newGids, outOfSubset });
  return outOfSubset ? null : newGids;
}

/**
 * 从一组（子集内的）新 gid 序列写出 Coverage 表，返回其在 Writer 中的起始偏移。
 * 自动选择 format1（列表）或 format2（区间）中更紧凑的。
 */
/**
 * 从一组（子集内的）新 gid 序列写出 Coverage 表，返回其在 Writer 中的起始偏移。
 * 自动选择 format1（列表）或 format2（区间）中更紧凑的。
 *
 * 输入约定：newGids **必须已升序、无重复**。所有调用方均保证：
 *   - readCoverageRemapped 在缓存入口已 sort（原 coverage gid 升序，但 原gid→新gid 映射不保序）
 *   - type1/2/3/4 与 fmt1 的 entries 在调用前已按 from/firstGid 升序排序，map 保持顺序
 * 直接在输入上扫描区间（不 slice 复制、不 sort、不分配 ranges 对象数组），
 * fmt3 单次子集化 ~17 万次 emitCoverage 调用的主要 GC+CPU 开销由此消除。
 * 仅读不修改输入，covCache 共享的数组实例安全复用。 */
function emitCoverage(w: Writer, newGids: number[]): number {
  const off = w.length;
  const n = newGids.length;
  /** 单遍收集连续区间 [start,end]：原实现两遍扫描（先统计 rangeCount 决定 format，再写出），
   *  合并为一遍收集到 ranges 数组，再据 rangeCount vs n 选 format 直接写出。
   *  V8 短命小数组近乎免费，省第二遍重新扫描 + 重新计算 covIndex。 */
  const rangeStarts: number[] = [];
  const rangeEnds: number[] = [];
  for (let i = 0; i < n; ) {
    const start = newGids[i];
    let j = i;
    while (j + 1 < n && newGids[j + 1] === newGids[j] + 1) j++;
    rangeStarts.push(start);
    rangeEnds.push(newGids[j]);
    i = j + 1;
  }
  const rangeCount = rangeStarts.length;
  if (rangeCount > 0 && rangeCount < n) {
    /** format2 区间更紧凑 */
    w.writeUint16(COV_RANGE);
    w.writeUint16(rangeCount);
    let covIndex = 0;
    for (let k = 0; k < rangeCount; k++) {
      w.writeUint16(rangeStarts[k]);
      w.writeUint16(rangeEnds[k]);
      w.writeUint16(covIndex);
      covIndex += rangeEnds[k] - rangeStarts[k] + 1;
    }
  } else {
    /** format1 列表 */
    w.writeUint16(COV_LIST);
    w.writeUint16(n);
    for (let i = 0; i < n; i++) w.writeUint16(newGids[i]);
  }
  return off;
}

/**
 * 写出 SingleSubst（type1）subtable，成功返回 true。
 * format1: coverage + deltaGlyphID；format2: coverage + glyphId 数组。
 * 子集化后统一 delta 规则可能被破坏（部分 gid 被 delta 移出子集），此时升级为 format2 逐项映射。
 */
function serializeSingleSubst(
  w: Writer,
  r: Reader,
  off: number,
  gidLookup: GidLookup,
): boolean {
  const dv = r.dv;
  const format = r.u16(off);
  const covOff = off + r.u16(off + 2);

  /** 收集 (from新gid → to新gid) 有效项，子集外的剔除 */
  const entries: Array<{ from: number; to: number }> = [];

  /** 反转遍历快路径：思源 locl 等 type1 lookup 的 coverage 可达上千~上万 gid（lookup#43 = 8881），
   *  但子集仅命中个位数。原实现 readCoverageGids 全量展开 coverage 再逐个查 gidLookup（8881 次，
   *  几乎全未命中）。改为遍历子集原始 gid（currentSortedSubsetGids，仅 19 项），用 coverageIndexOf
   *  在 coverage 中二分定位下标，命中才取 target——O(subsetSize × log covCount) 替代 O(covCount)。
   *  与 [[gsub-reachable-type1-fmt2-reverse-iter]] 同思路。仅当 coverage 明显多于子集时启用，
   *  否则短 coverage 原遍历更快（二分开销 > 跳过收益）。 */
  const subsetGids = getSortedSubsetGids();
  const covGidCount = coverageCount(r, covOff);
  /** 阈值：coverage gid 数 / 子集 gid 数 > 4 且 coverage 较大时启用反转 */
  const useReverse = covGidCount > subsetGids.length * 4 && covGidCount > 16;

  if (useReverse) {
    if (format === 1) {
      const delta = r.i16(off + 4);
      for (const g of subsetGids) {
        /** from gid 必须在 coverage 中（SingleSubst 仅对 coverage 内 gid 生效） */
        if (coverageIndexOf(r, covOff, g) < 0) continue;
        const fromNew = gidLookup[g];
        const toNew = gidLookup[(g + delta) & 0xffff];
        if (fromNew >= 0 && toNew >= 0) entries.push({ from: fromNew, to: toNew });
      }
    } else if (format === 2) {
      for (const g of subsetGids) {
        /** idx = gid 在 coverage 中的序号，与 substituteGlyphIDs 数组下标一一对应 */
        const idx = coverageIndexOf(r, covOff, g);
        if (idx < 0) continue;
        const fromNew = gidLookup[g];
        const toNew = gidLookup[dv.getUint16(off + 6 + idx * 2, false)];
        if (fromNew >= 0 && toNew >= 0) entries.push({ from: fromNew, to: toNew });
      }
    } else {
      return false;
    }
  } else {
    const covGids = readCoverageGids(r, covOff);
    if (format === 1) {
      const delta = r.i16(off + 4);
      for (const g of covGids) {
        const fromNew = gidLookup[g];
        const toNew = gidLookup[(g + delta) & 0xffff];
        if (fromNew >= 0 && toNew >= 0) entries.push({ from: fromNew, to: toNew });
      }
    } else if (format === 2) {
      const count = r.u16(off + 4);
      for (let i = 0; i < covGids.length && i < count; i++) {
        const fromNew = gidLookup[covGids[i]];
        const toNew = gidLookup[dv.getUint16(off + 6 + i * 2, false)];
        if (fromNew >= 0 && toNew >= 0) entries.push({ from: fromNew, to: toNew });
      }
    } else {
      return false;
    }
  }
  if (entries.length === 0) return false;

  /** 关键：按 from gid 升序排序，使 coverage（emitCoverage 会排序）与 target 数组保持配对一致。
   *  SingleSubst format2 的 source gid 数组与 target 数组按下标一一对应，
   *  而 emitCoverage 输出 Coverage 时强制升序去重——若 entries 不先排序，
   *  coverage 顺序会与 target 顺序错位（source↔target 配对断裂，连字替换到错误字形）。
   *  排序后 coverage 与 target 共用同一升序，配对关系得以保持。 */
  entries.sort((a, b) => a.from - b.from);

  /** 检查是否所有项仍为统一 delta（to - from 恒定），若是用 format1 更紧凑，否则 format2 */
  let uniform = true;
  const firstDelta = (entries[0].to - entries[0].from) & 0xffff;
  for (const e of entries) {
    if (((e.to - e.from) & 0xffff) !== firstDelta) {
      uniform = false;
      break;
    }
  }

  const subStart = w.length;
  const coveragePosHolder: number[] = [0];
  if (uniform) {
    w.writeUint16(1);
    w.reserveOffset16(subStart, () => coveragePosHolder[0]);
    w.writeUint16(firstDelta);
  } else {
    w.writeUint16(2);
    w.reserveOffset16(subStart, () => coveragePosHolder[0]);
    w.writeUint16(entries.length);
    for (const e of entries) w.writeUint16(e.to);
  }
  coveragePosHolder[0] = emitCoverage(w, entries.map((e) => e.from));
  return true;
}

/**
 * 写出一个合法的「空 subtable」用于降级（重映射失败 / 不支持的类型）。
 * 输出合法结构 + 空 coverage，浏览器查不到任何字形会直接跳过，不会破坏字体。
 *
 * 各 lookup 类型的 subtable 首字段是 format，合法 format 集合不同：
 *   - SingleSubst: {1, 2}；其余（Multiple/Alternate/Ligature/Chain 等）首 format 通常只接受 1。
 * 故按 effectiveType 选择 format：SingleSubst 用 format2（count=0），其余用 format1（count=0）。
 * 两者结构同形：format(2) + coverageOffset(2) + count(2)=0 + 空 coverage，coverage 紧随其后。
 *
 * 不原样拷贝原始 subtable 字节——其 coverage/ClassDef 等子结构在原始字体中可能与其他 lookup
 * 物理交错、散落在任意偏移（霞鹜文楷 type4 的 coverage 在 subtable 后 2594 字节处），
 * 按间距/边界估算拷贝会破坏字体。
 */
function writeEmptySubtable(w: Writer, effectiveType: number): void {
  /** SingleSubst 用 format2，其余类型用 format1（避免 LigatureSubst 等报 unknown format:2） */
  const format = effectiveType === LT_SINGLE ? 2 : 1;
  w.writeUint16(format);
  /**
   * 空 subtable 布局固定：format(2) + coverageOffset(2) + count(2) + coverage(format1 + count0 共 4 字节)。
   * coverageOffset 相对 subtable 起始恒为 6（指向紧随 count 之后的 coverage），可直接写常量，
   * 无需 reserveOffset16 的 patches push + 闭包分配（FiraCode 259 次/call 空 subtable）。
   */
  w.writeUint16(6);
  w.writeUint16(0);
  /** 空 coverage：format1 + count0 */
  w.writeUint16(1);
  w.writeUint16(0);
}

/**
 * 写出 MultipleSubst（type2）subtable：coverage + sequence 数组（每项 = gid 数组）。
 * 覆盖字形在子集外的剔除；sequence 内子集外的目标 gid 剔除（序列变短，仍合法）。
 */
function serializeMultipleSubst(
  w: Writer,
  r: Reader,
  off: number,
  gidLookup: GidLookup,
): boolean {
  const dv = r.dv;
  const covOff = off + r.u16(off + 2);
  const seqCount = r.u16(off + 4);

  /** 逐 coverage 字形读取其 sequence，重映射后保留有效项 */
  const entries: Array<{ from: number; seq: number[] }> = [];

  /** 反转遍历快路径（同 serializeLigatureSubst / serializeSingleSubst）：coverage 远大于子集时
   *  遍历子集 gid 二分定位 coverage 下标 idx（即 SequenceTable 偏移数组下标），替代全量展开。 */
  const subsetGids = getSortedSubsetGids();
  const covGidCount = coverageCount(r, covOff);
  const useReverse = covGidCount > subsetGids.length * 4 && covGidCount > 16;

  if (useReverse) {
    for (const g of subsetGids) {
      const idx = coverageIndexOf(r, covOff, g);
      if (idx < 0 || idx >= seqCount) continue;
      const fromNew = gidLookup[g];
      if (!(fromNew >= 0)) continue;
      const seqOff = off + dv.getUint16(off + 6 + idx * 2, false);
      const glyphCount = dv.getUint16(seqOff, false);
      const newSeq: number[] = [];
      for (let k = 0; k < glyphCount; k++) {
        const gg = gidLookup[dv.getUint16(seqOff + 2 + k * 2, false)];
        if (gg >= 0) newSeq.push(gg);
      }
      /** 序列至少 1 个目标 gid 才有意义 */
      if (newSeq.length > 0) entries.push({ from: fromNew, seq: newSeq });
    }
  } else {
    const covGids = readCoverageGids(r, covOff);
    for (let i = 0; i < covGids.length && i < seqCount; i++) {
      const fromNew = gidLookup[covGids[i]];
      /** fromNew === undefined（covGids[i] 越界，损坏 coverage）也跳过，与反转路径行为一致 */
      if (!(fromNew >= 0)) continue;
      const seqOff = off + dv.getUint16(off + 6 + i * 2, false);
      const glyphCount = dv.getUint16(seqOff, false);
      const newSeq: number[] = [];
      for (let k = 0; k < glyphCount; k++) {
        const g = gidLookup[dv.getUint16(seqOff + 2 + k * 2, false)];
        if (g >= 0) newSeq.push(g);
      }
      /** 序列至少 1 个目标 gid 才有意义 */
      if (newSeq.length > 0) entries.push({ from: fromNew, seq: newSeq });
    }
  }
  if (entries.length === 0) return false;
  /** 按 from gid 升序排序，使 coverage（emitCoverage 强制升序）与 sequence 数组保持下标配对 */
  entries.sort((a, b) => a.from - b.from);

  const subStart = w.length;
  const coveragePosHolder: number[] = [0];
  const seqOffHolders: number[][] = entries.map(() => [0]);
  w.writeUint16(1);
  w.reserveOffset16(subStart, () => coveragePosHolder[0]);
  w.writeUint16(entries.length);
  for (const h of seqOffHolders) w.reserveOffset16(subStart, () => h[0]);

  coveragePosHolder[0] = emitCoverage(w, entries.map((e) => e.from));
  for (let i = 0; i < entries.length; i++) {
    seqOffHolders[i][0] = w.length;
    w.writeUint16(entries[i].seq.length);
    for (const g of entries[i].seq) w.writeUint16(g);
  }
  return true;
}

/**
 * 写出 AlternateSubst（type3）subtable：coverage + alternate 数组（每项 = 可选 gid 数组）。
 * 与 MultipleSubst 结构同形，仅语义不同（选一而非全用），重映射逻辑相同。
 */
function serializeAlternateSubst(
  w: Writer,
  r: Reader,
  off: number,
  gidLookup: GidLookup,
): boolean {
  const dv = r.dv;
  const covOff = off + r.u16(off + 2);
  const altCount = r.u16(off + 4);

  const entries: Array<{ from: number; alts: number[] }> = [];

  /** 反转遍历快路径（同 serializeMultipleSubst / serializeLigatureSubst）：coverage 远大于子集时
   *  遍历子集 gid 二分定位 coverage 下标 idx（即 AlternateSet 偏移数组下标），替代全量展开。 */
  const subsetGids = getSortedSubsetGids();
  const covGidCount = coverageCount(r, covOff);
  const useReverse = covGidCount > subsetGids.length * 4 && covGidCount > 16;

  if (useReverse) {
    for (const g of subsetGids) {
      const idx = coverageIndexOf(r, covOff, g);
      if (idx < 0 || idx >= altCount) continue;
      const fromNew = gidLookup[g];
      if (!(fromNew >= 0)) continue;
      const altOff = off + dv.getUint16(off + 6 + idx * 2, false);
      const cnt = dv.getUint16(altOff, false);
      const newAlts: number[] = [];
      for (let k = 0; k < cnt; k++) {
        const gg = gidLookup[dv.getUint16(altOff + 2 + k * 2, false)];
        if (gg >= 0) newAlts.push(gg);
      }
      if (newAlts.length > 0) entries.push({ from: fromNew, alts: newAlts });
    }
  } else {
    const covGids = readCoverageGids(r, covOff);
    for (let i = 0; i < covGids.length && i < altCount; i++) {
      const fromNew = gidLookup[covGids[i]];
      /** fromNew === undefined（covGids[i] 越界，损坏 coverage 的 gid 超 numGlyphs）也跳过，
       *  与反转路径（subsetGids 必在范围内）行为一致。原 `fromNew < 0` 漏过 undefined（NaN 比较 false）。 */
      if (!(fromNew >= 0)) continue;
      const altOff = off + dv.getUint16(off + 6 + i * 2, false);
      const cnt = dv.getUint16(altOff, false);
      const newAlts: number[] = [];
      for (let k = 0; k < cnt; k++) {
        const g = gidLookup[dv.getUint16(altOff + 2 + k * 2, false)];
        if (g >= 0) newAlts.push(g);
      }
      if (newAlts.length > 0) entries.push({ from: fromNew, alts: newAlts });
    }
  }
  if (entries.length === 0) return false;
  /** 按 from gid 升序排序，使 coverage（emitCoverage 强制升序）与 alternate 数组保持下标配对 */
  entries.sort((a, b) => a.from - b.from);

  const subStart = w.length;
  const coveragePosHolder: number[] = [0];
  const altOffHolders: number[][] = entries.map(() => [0]);
  w.writeUint16(1);
  w.reserveOffset16(subStart, () => coveragePosHolder[0]);
  w.writeUint16(entries.length);
  for (const h of altOffHolders) w.reserveOffset16(subStart, () => h[0]);

  coveragePosHolder[0] = emitCoverage(w, entries.map((e) => e.from));
  for (let i = 0; i < entries.length; i++) {
    altOffHolders[i][0] = w.length;
    w.writeUint16(entries[i].alts.length);
    for (const g of entries[i].alts) w.writeUint16(g);
  }
  return true;
}

/**
 * 写出 LigatureSubst（type4）subtable：coverage + ligature set 数组。
 * 每个 ligature set 含多条 ligature（components 序列 + ligature 目标 gid）。
 * 第一分量（coverage 字形）在子集外的剔除；components 子集外或目标子集外的剔除该条 ligature。
 */
function serializeLigatureSubst(
  w: Writer,
  r: Reader,
  off: number,
  gidLookup: GidLookup,
): boolean {
  const dv = r.dv;
  const covOff = off + r.u16(off + 2);
  const setCount = r.u16(off + 4);

  /** 每个 coverage 字形收集有效 ligature 列表 */
  const entries: Array<{ from: number; ligs: Array<{ comp: number[]; lig: number }> }> = [];

  /** 反转遍历快路径：LigatureSubst 的 coverage 可达数百~上千 gid（霞鹜文楷/初夏明朝 type4），
   *  但子集仅命中个位数。原 readCoverageGids 全量展开再逐个查 gidLookup 浪费。
   *  改为遍历子集原始 gid（currentSortedSubsetGids），用 coverageIndexOf 二分定位 coverage 下标 idx，
   *  idx 即 LigatureSet 偏移数组的下标（off + 6 + idx * 2）。与 serializeSingleSubst 反转同思路
   *  （[[gsub-serialize-single-bigcov-reverse]]）。仅当 coverage 明显多于子集时启用。 */
  const subsetGids = getSortedSubsetGids();
  const covGidCount = coverageCount(r, covOff);
  const useReverse = covGidCount > subsetGids.length * 4 && covGidCount > 16;

  if (useReverse) {
    for (const g of subsetGids) {
      const idx = coverageIndexOf(r, covOff, g);
      if (idx < 0 || idx >= setCount) continue;
      /** gidLookup[origGid] = 新gid 或 -1（不在子集）。数组索引比 Map.get 快 ~2×，
       *  serializeLigatureSubst 对每条 ligature 的全部分量密集 remapGid，是 CJK ligature 子集热点。 */
      const fromNew = gidLookup[g];
      if (!(fromNew >= 0)) continue;
      const setOff = off + dv.getUint16(off + 6 + idx * 2, false);
      const ligCount = dv.getUint16(setOff, false);
      const newLigs: Array<{ comp: number[]; lig: number }> = [];
      for (let j = 0; j < ligCount; j++) {
        const ligOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        const compCount = dv.getUint16(ligOff, false);
        const ligNew = gidLookup[dv.getUint16(ligOff + 2, false)];
        if (ligNew < 0) continue;
        /** components 从第 2 字形开始（第 1 字形即 coverage 字形），compCount 含第 1 字形 */
        const compNew: number[] = [fromNew];
        let ok = true;
        for (let k = 0; k < compCount - 1; k++) {
          const c = gidLookup[dv.getUint16(ligOff + 4 + k * 2, false)];
          if (c < 0) {
            ok = false;
            break;
          }
          compNew.push(c);
        }
        if (ok) newLigs.push({ comp: compNew, lig: ligNew });
      }
      if (newLigs.length > 0) entries.push({ from: fromNew, ligs: newLigs });
    }
  } else {
    const covGids = readCoverageGids(r, covOff);
    for (let i = 0; i < covGids.length && i < setCount; i++) {
      /** gidLookup[origGid] = 新gid 或 -1（不在子集）。数组索引比 Map.get 快 ~2×，
       *  serializeLigatureSubst 对每条 ligature 的全部分量密集 remapGid，是 CJK ligature 子集热点。 */
      const fromNew = gidLookup[covGids[i]];
      /** fromNew === undefined（covGids[i] 越界，损坏 coverage）也跳过，与反转路径行为一致 */
      if (!(fromNew >= 0)) continue;
      const setOff = off + dv.getUint16(off + 6 + i * 2, false);
      const ligCount = dv.getUint16(setOff, false);
      const newLigs: Array<{ comp: number[]; lig: number }> = [];
      for (let j = 0; j < ligCount; j++) {
        const ligOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        const compCount = dv.getUint16(ligOff, false);
        const ligNew = gidLookup[dv.getUint16(ligOff + 2, false)];
        if (ligNew < 0) continue;
        /** components 从第 2 字形开始（第 1 字形即 coverage 字形），compCount 含第 1 字形 */
        const compNew: number[] = [fromNew];
        let ok = true;
        for (let k = 0; k < compCount - 1; k++) {
          const c = gidLookup[dv.getUint16(ligOff + 4 + k * 2, false)];
          if (c < 0) {
            ok = false;
            break;
          }
          compNew.push(c);
        }
        if (ok) newLigs.push({ comp: compNew, lig: ligNew });
      }
      if (newLigs.length > 0) entries.push({ from: fromNew, ligs: newLigs });
    }
  }
  if (entries.length === 0) return false;
  /** 按 from gid 升序排序，使 coverage（emitCoverage 强制升序）与 ligature set 数组保持下标配对 */
  entries.sort((a, b) => a.from - b.from);

  const subStart = w.length;
  const coveragePosHolder: number[] = [0];
  const setOffHolders: number[][] = entries.map(() => [0]);
  w.writeUint16(1);
  w.reserveOffset16(subStart, () => coveragePosHolder[0]);
  w.writeUint16(entries.length);
  for (const h of setOffHolders) w.reserveOffset16(subStart, () => h[0]);

  coveragePosHolder[0] = emitCoverage(w, entries.map((e) => e.from));
  for (let i = 0; i < entries.length; i++) {
    setOffHolders[i][0] = w.length;
    const ligs = entries[i].ligs;
    w.writeUint16(ligs.length);
    const ligOffHolders: number[][] = ligs.map(() => [0]);
    for (const h of ligOffHolders) w.reserveOffset16(setOffHolders[i][0], () => h[0]);
    for (let j = 0; j < ligs.length; j++) {
      ligOffHolders[j][0] = w.length;
      w.writeUint16(ligs[j].comp.length);
      w.writeUint16(ligs[j].lig);
      /** 第 2 个分量起 */
      for (let k = 1; k < ligs[j].comp.length; k++) w.writeUint16(ligs[j].comp[k]);
    }
  }
  return true;
}

/**
 * 读取 ClassDef 表为 (新gid → classIndex) map，class index 原样保留（不紧致重编号）。
 *
 * format2 优化（range 二分而非展开）：原实现遍历每个 range 的 [start..end] 全部 gid 查 gidLookup
 * （FiraCode 实测 33 次 readClassDefMap 展开共 9686 gid 仅命中 19，命中率 0.2%，子集仅 89 gid）。
 * 改为对每个 range 在升序子集 gid 数组上二分定位 [start,end] 内的 gid，仅对命中的 set class——
 * 从「展开 range 全部 gid」转为「只处理落在 range 内的子集 gid」。OpenType 规范要求 ClassDef format2
 * ranges 按 start 升序且不重叠（已验证 FiraCode 全部合规），但此处不依赖该性质，仅依赖 currentSortedSubsetGids 升序。
 */
function readClassDefMap(r: Reader, off: number, gidLookup: GidLookup): Map<number, number> {
  const result = new Map<number, number>();
  if (off === 0) return result;
  const dv = r.dv;
  const format = r.u16(off);
  if (format === 1) {
    const startGid = r.u16(off + 2);
    const count = r.u16(off + 4);
    for (let i = 0; i < count; i++) {
      const origGid = startGid + i;
      /** 优化333：gidLookup（Int32Array 索引，~1ns）替代 origToNew.get（Map.get ~9ns）。
       *  语义等价：gidLookup[g] >= 0 ⟺ origToNew.has(g) 且值相同。 */
      const newGid = gidLookup[origGid];
      if (newGid >= 0) result.set(newGid, dv.getUint16(off + 6 + i * 2, false));
    }
  } else if (format === 2) {
    const rangeCount = r.u16(off + 2);
    const subsetGids = getSortedSubsetGids();
    const subsetLen = subsetGids.length;
    if (subsetLen === 0) return result;
    /** ClassDef format2 class range 数组起始（每个 range 6 字节：startGid/endGid/startClassIndex） */
    const rangesBase = off + 4;
    const minSubset = subsetGids[0];
    const maxSubset = subsetGids[subsetLen - 1];
    for (let i = 0; i < rangeCount; i++) {
      const p = rangesBase + i * 6;
      const start = dv.getUint16(p, false);
      const end = dv.getUint16(p + 2, false);
      /** range 内无 gid 可能时跳过（end < 最小子集 gid 或 start > 最大子集 gid） */
      if (end < minSubset || start > maxSubset) continue;
      const cls = dv.getUint16(p + 4, false);
      /** 二分定位第一个 >= start 的子集 gid，顺序遍历到 > end 为止（子集数组升序） */
      let lo = 0;
      let hi = subsetLen;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (subsetGids[mid] < start) lo = mid + 1;
        else hi = mid;
      }
      for (let j = lo; j < subsetLen; j++) {
        const g = subsetGids[j];
        if (g > end) break;
        /** gidLookup[g] 必 >= 0（g 来自子集数组），但仍查以保持与 format1 路径一致 */
        result.set(gidLookup[g], cls);
      }
    }
  }
  return result;
}

/** 从 (新gid → 新class) map 写出 ClassDef（format2 区间），返回起始偏移 */
function writeClassDefFromMap(w: Writer, newGidToClass: Map<number, number>): number {
  const off = w.length;
  if (newGidToClass.size === 0) {
    w.writeUint16(2);
    w.writeUint16(0);
    return off;
  }
  const entries = Array.from(newGidToClass.entries()).sort((a, b) => a[0] - b[0]);
  const ranges: Array<{ start: number; end: number; cls: number }> = [];
  for (let i = 0; i < entries.length; ) {
    const cls = entries[i][1];
    let j = i;
    while (j + 1 < entries.length && entries[j + 1][0] === entries[j][0] + 1 && entries[j + 1][1] === cls) j++;
    ranges.push({ start: entries[i][0], end: entries[j][0], cls });
    i = j + 1;
  }
  w.writeUint16(2);
  w.writeUint16(ranges.length);
  for (const rg of ranges) {
    w.writeUint16(rg.start);
    w.writeUint16(rg.end);
    w.writeUint16(rg.cls);
  }
  return off;
}

/**
 * 写出 ChainedContextSubst（type6）subtable，3 种 format 均支持。
 * 重映射 backtrack/input/lookahead 的 coverage（format1/3）或 ClassDef（format2）gid，
 * 保留 SubstLookupRecord（lookup index 引用不变，被引用 lookup 自行重映射）。
 *
 * format1: coverage(gid) 匹配；format2: ClassDef 匹配；format3: 显式 coverage 数组匹配。
 * 规则中若任一匹配 gid 组含子集外 gid，该规则整体失效（剔除）。
 */
function serializeChainedContextSubst(
  w: Writer,
  r: Reader,
  off: number,
  origToNew: Map<number, number>,
  covCache: CoverageCache,
  gidLookup: GidLookup,
): boolean {
  const format = r.u16(off);
  /** 缓存 dv 供 format1/format2 ruleSet/rule 偏移的连续 u16 读取直接调用 getUint16 */
  const dv = r.dv;
  if (format === 1) {
    /** coverage(gid) + 子规则数组，每规则含 backtrack/input/lookahead gid 序列 + SubstLookupRecord */
    const covOff = off + r.u16(off + 2);
    const covGids = readCoverageGids(r, covOff, covCache);
    const ruleSetCount = r.u16(off + 4);
    if (ruleSetCount > 0x7fff) return false;
    /** 按 coverage 字形收集有效规则 */
    const entries: Array<{
      firstGid: number;
      rules: Array<{ back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }>;
    }> = [];
    for (let i = 0; i < covGids.length && i < ruleSetCount; i++) {
      const firstNew = remapGid(origToNew, covGids[i]);
      if (firstNew === null) continue;
      const setOff = off + dv.getUint16(off + 6 + i * 2, false);
      const ruleCount = dv.getUint16(setOff, false);
      if (ruleCount > 0x7fff) return false;
      const validRules: Array<{ back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }> = [];
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        const parsed = parseChainRuleFormat1or2(r, ruleOff, origToNew, true);
        if (parsed) validRules.push(parsed);
      }
      if (validRules.length > 0) entries.push({ firstGid: firstNew, rules: validRules });
    }
    if (entries.length === 0) return false;
    /** 按 firstGid 升序排序，使 coverage（emitCoverage 强制升序）与 SubRuleSet 数组保持下标配对 */
    entries.sort((a, b) => a.firstGid - b.firstGid);
    writeChainFormat1(w, entries);
    return true;
  }

  if (format === 2) {
    /** format2（ClassDef 匹配）：Coverage + 三个 ClassDef + 按 input 第一分量 class 索引的 rule sets。
     *  关键：class index 不重编号（class 0 是「未分类」语义，紧致化会破坏），仅重映射 ClassDef 内的 gid，
     *  rule 内的 class index 原样保留；rule 中匹配的字形若全部在子集内则保留该规则，否则剔除。
     *
     *  OpenType ChainContextSubstFormat2 字段顺序（每个 Offset16 相对 subtable 起始）：
     *    off+0  format(=2)
     *    off+2  coverageOffset
     *    off+4  backtrackClassDefOffset
     *    off+6  inputClassDefOffset
     *    off+8  lookaheadClassDefOffset
     *    off+10 chainSubClassSetCount
     *    off+12 chainSubClassSetOffset[count]
     *  旧实现漏读 coverageOffset、把后续字段整体前移 2 字节，导致 classSetCount 读成
     *  lookaheadClassDefOffset（如 FiraCode L194 的 66），遍历大量垃圾 slot 触发降级，
     *  连字核心规则（如 <= 的 equal→less_equal.liga）丢失，渲染走错误 shaping 路径。 */
    const coverageOff = off + r.u16(off + 2);
    const backtrackCDOff = off + r.u16(off + 4);
    const inputCDOff = off + r.u16(off + 6);
    const lookaheadCDOff = off + r.u16(off + 8);
    const classSetCount = r.u16(off + 10);
    /** classSetCount 异常大（>256）通常意味着字体数据含扩展 padding 或异常结构
     *  （如 FiraCode 某些 format2 有 4138 个 classSet slot），严格解析会读到大量重叠垃圾数据。
     *  此时原样拷贝该 subtable（gid 不重映射，浏览器渲染该 lookup 跳过，不破坏字体）。 */
    if (classSetCount > 256) return false;

    /** Coverage 的重映射（仅保留子集内 gid）在 writeChainFormat2 中处理 */

    /** 收集每个 input class 的有效规则（class index 不变） */
    const classToRules = new Map<number, Array<{ back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }>>();
    for (let i = 0; i < classSetCount; i++) {
      const setOffRel = dv.getUint16(off + 12 + i * 2, false);
      if (setOffRel === 0) continue;
      const setOff = off + setOffRel;
      const ruleCount = dv.getUint16(setOff, false);
      if (ruleCount > 0x7fff) return false;
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + dv.getUint16(setOff + 2 + j * 2, false);
        /** format2 的元素是 class index（非 gid），原样保留，传 isGidFormat=false。
         *  class index 始终有效（ClassDef 重映射 gid 后 class 编号不变），规则恒保留。 */
        const parsed = parseChainRuleFormat1or2(r, ruleOff, origToNew, false);
        if (!parsed) continue;
        const list = classToRules.get(i) ?? [];
        list.push(parsed);
        classToRules.set(i, list);
      }
    }
    if (classToRules.size === 0) return false;
    writeChainFormat2(w, r, coverageOff, backtrackCDOff, inputCDOff, lookaheadCDOff, classToRules, covCache, gidLookup);
    return true;
  }

  if (format === 3) {
    /** 显式 coverage 数组 + SubstLookupRecord */
    const parsed = parseChainFormat3(r, off, covCache, gidLookup);
    if (!parsed) return false;
    writeChainFormat3(w, parsed);
    return true;
  }

  return false;
}

/**
 * 解析 format1/format2 的单条 ChainSubRule，返回重映射后的规则或 null（含子集外 gid）。
 * @param isGidFormat true=format1（元素为 gid，需 原gid→新gid 重映射，子集外 gid 则规则失效）；
 *                    false=format2（元素为 class index，原样保留，不重映射）。
 */
function parseChainRuleFormat1or2(
  r: Reader,
  ruleOff: number,
  origToNew: Map<number, number>,
  isGidFormat: boolean,
): { back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> } | null {
  const dv = r.dv;
  const backCount = r.u16(ruleOff);
  /** count 异常大（偏移错位读到垃圾值）则放弃该规则，返回 null。实际规则序列长度很小（<256） */
  if (backCount > 255) return null;
  let p = ruleOff + 2;
  /**
   * format1（gid 序列）：边读边重映射，遇子集外 gid 立即返回 null——避免先收集 backRaw/inputRaw/lookRaw
   * 三个临时数组再二次遍历 remap（子集外规则的 raw 数组分配纯浪费，FiraCode 多数 fmt1 规则因 input gid
   * 不在子集而失效）。format2（class index）：始终有效，原样读取不重映射。
   */
  const readSeq = (count: number): number[] | null => {
    if (count === 0) return [];
    if (isGidFormat) {
      const out: number[] = [];
      for (let k = 0; k < count; k++) {
        const m = remapGid(origToNew, dv.getUint16(p + k * 2, false));
        if (m === null) return null;
        out.push(m);
      }
      return out;
    }
    const out2: number[] = [];
    for (let k = 0; k < count; k++) out2.push(dv.getUint16(p + k * 2, false));
    return out2;
  };
  const back = readSeq(backCount);
  if (back === null) return null;
  p += backCount * 2;
  const inputCount = r.u16(p);
  /** inputCount 为 0 是异常（ChainSubRule 至少含第一分量，inputCount>=1），返回 null 跳过该规则 */
  if (inputCount === 0 || inputCount > 255) return null;
  p += 2;
  /** input 序列不含第一分量（第一分量由 coverage/class 决定） */
  const input = readSeq(inputCount - 1);
  if (input === null) return null;
  p += (inputCount - 1) * 2;
  const lookCount = r.u16(p);
  if (lookCount > 255) return null;
  p += 2;
  const look = readSeq(lookCount);
  if (look === null) return null;
  p += lookCount * 2;
  const seqCount = r.u16(p);
  if (seqCount > 255) return null;
  p += 2;
  const records: Array<{ seq: number; lookup: number }> = [];
  for (let k = 0; k < seqCount; k++) {
    records.push({ seq: dv.getUint16(p + k * 4, false), lookup: dv.getUint16(p + k * 4 + 2, false) });
  }
  return { back, input, look, records };
}

/** 写出 ChainedContext format1（coverage + rule sets） */
function writeChainFormat1(
  w: Writer,
  entries: Array<{ firstGid: number; rules: Array<{ back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }> }>,
): void {
  const subStart = w.length;
  const coverageHolder: number[] = [0];
  const setOffHolders: number[][] = entries.map(() => [0]);
  w.writeUint16(1);
  w.reserveOffset16(subStart, () => coverageHolder[0]);
  w.writeUint16(entries.length);
  for (const h of setOffHolders) w.reserveOffset16(subStart, () => h[0]);

  coverageHolder[0] = emitCoverage(w, entries.map((e) => e.firstGid));
  for (let i = 0; i < entries.length; i++) {
    setOffHolders[i][0] = w.length;
    const rules = entries[i].rules;
    w.writeUint16(rules.length);
    const ruleOffHolders: number[][] = rules.map(() => [0]);
    for (const h of ruleOffHolders) w.reserveOffset16(setOffHolders[i][0], () => h[0]);
    for (let j = 0; j < rules.length; j++) {
      ruleOffHolders[j][0] = w.length;
      writeChainRuleBody(w, rules[j]);
    }
  }
}

/** 写出单条 ChainSubRule 主体（不含偏移量槽） */
function writeChainRuleBody(w: Writer, rule: { back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }): void {
  w.writeUint16(rule.back.length);
  for (const g of rule.back) w.writeUint16(g);
  /** inputCount 含第一分量 */
  w.writeUint16(rule.input.length + 1);
  for (const g of rule.input) w.writeUint16(g);
  w.writeUint16(rule.look.length);
  for (const g of rule.look) w.writeUint16(g);
  w.writeUint16(rule.records.length);
  for (const rc of rule.records) {
    w.writeUint16(rc.seq);
    w.writeUint16(rc.lookup);
  }
}

/**
 * 写出 ChainedContext format2（三个 ClassDef + 按 class 的 rule sets）。
 * class index 不重编号（保留原始 class 0 的「未分类」语义），仅重映射 ClassDef 内的 gid。
 * rule 内的 class index 直接原样写入（parseChainRuleFormat1or2 已验证有效性）。
 */
function writeChainFormat2(
  w: Writer,
  r: Reader,
  coverageOff: number,
  backtrackCDOff: number,
  inputCDOff: number,
  lookaheadCDOff: number,
  classToRules: Map<number, Array<{ back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }>>,
  covCache: CoverageCache,
  gidLookup: GidLookup,
): void {
  const subStart = w.length;
  const coverageHolder: number[] = [0];
  const backHolder: number[] = [0];
  const inputHolder: number[] = [0];
  const lookHolder: number[] = [0];
  w.writeUint16(2);
  w.reserveOffset16(subStart, () => coverageHolder[0]);
  w.reserveOffset16(subStart, () => backHolder[0]);
  w.reserveOffset16(subStart, () => inputHolder[0]);
  w.reserveOffset16(subStart, () => lookHolder[0]);

  /** classSetCount = 出现在 classToRules 中的最大 class index + 1（保持原始 class index） */
  let maxClass = -1;
  for (const cls of classToRules.keys()) if (cls > maxClass) maxClass = cls;
  const classSetCount = maxClass + 1;
  w.writeUint16(classSetCount);
  /** 每个 class 一个偏移量槽：有规则用 reserveOffset16，无规则立即写 0 */
  const setOffHolders: Array<number[] | null> = [];
  for (let i = 0; i < classSetCount; i++) {
    if (classToRules.has(i)) {
      const h: number[] = [0];
      setOffHolders.push(h);
      w.reserveOffset16(subStart, () => h[0]);
    } else {
      setOffHolders.push(null);
      w.writeUint16(0);
    }
  }

  /** Coverage 重映射：仅保留子集内 gid（input 第一分量必须在子集内才会被 shaping 命中）。
   *  readCoverageRemapped 返回 null 表示原 coverage 非空但全子集外，此时 emitCoverage 写空 coverage
   *  （与原 map/filter 后为空数组等价，浏览器匹配不命中，不影响其他规则）。 */
  const newCovGids = readCoverageRemapped(r, coverageOff, gidLookup, covCache) ?? [];
  coverageHolder[0] = emitCoverage(w, newCovGids);

  /** 重映射三个 ClassDef 的 gid（class index 不变） */
  const backMap = readClassDefMap(r, backtrackCDOff, gidLookup);
  const inputMap = readClassDefMap(r, inputCDOff, gidLookup);
  const lookMap = readClassDefMap(r, lookaheadCDOff, gidLookup);
  backHolder[0] = writeClassDefFromMap(w, backMap);
  inputHolder[0] = writeClassDefFromMap(w, inputMap);
  lookHolder[0] = writeClassDefFromMap(w, lookMap);

  for (let i = 0; i < classSetCount; i++) {
    const rules = classToRules.get(i);
    if (!rules) continue;
    setOffHolders[i]![0] = w.length;
    w.writeUint16(rules.length);
    const ruleOffHolders: number[][] = rules.map(() => [0]);
    for (const h of ruleOffHolders) w.reserveOffset16(setOffHolders[i]![0], () => h[0]);
    for (let j = 0; j < rules.length; j++) {
      ruleOffHolders[j][0] = w.length;
      writeChainRuleBody(w, rules[j]);
    }
  }
}

/** 解析 format3：显式 coverage 数组 + records，返回重映射后的结构或 null */
function parseChainFormat3(
  r: Reader,
  off: number,
  covCache: CoverageCache,
  gidLookup: GidLookup,
): { backCovs: number[][]; inputCovs: number[][]; lookCovs: number[][]; records: Array<{ seq: number; lookup: number }> } | null {
  const dv = r.dv;
  let p = off + 2;
  const readCovArr = (): number[][] | null => {
    const count = r.u16(p);
    p += 2;
    /** 按 count 预分配容量，消除 push 触发的 GrowFast（fmt3 高频，每 subtable 三组 coverage） */
    const arr: number[][] = new Array<number[]>(count);
    for (let k = 0; k < count; k++) {
      const covOff = off + dv.getUint16(p + k * 2, false);
      const newGids = readCoverageRemapped(r, covOff, gidLookup, covCache);
      /** coverage 全部 gid 落在子集外（原非空）→ 规则失效 */
      if (newGids === null) return null;
      arr[k] = newGids;
    }
    p += count * 2;
    return arr;
  };
  const backCovs = readCovArr();
  const inputCovs = readCovArr();
  const lookCovs = readCovArr();
  if (backCovs === null || inputCovs === null || lookCovs === null) return null;

  const seqCount = r.u16(p);
  p += 2;
  /** 按 seqCount 预分配，消除 records 对象数组 grow */
  const records: Array<{ seq: number; lookup: number }> = new Array<{ seq: number; lookup: number }>(seqCount);
  for (let k = 0; k < seqCount; k++) {
    records[k] = { seq: dv.getUint16(p + k * 4, false), lookup: dv.getUint16(p + k * 4 + 2, false) };
  }
  return { backCovs, inputCovs, lookCovs, records };
}

/** 写出 format3：重映射后的 coverage 数组 + records */
function writeChainFormat3(
  w: Writer,
  parsed: { backCovs: number[][]; inputCovs: number[][]; lookCovs: number[][]; records: Array<{ seq: number; lookup: number }> },
): void {
  const subStart = w.length;
  /** 每个 coverage 偏移槽的字节位置（writeUint16(0) 占位，emitCoverage 后 writeInt16At 回填）。
   *  替代旧 allHolders: number[][] + reserveOffset16 闭包模式：消除每槽的 [0] 单元素数组分配 +
   *  reserveOffset16 的 patches 闭包 push + flush 回填遍历（优化329 同思路，对 chain coverage slot 复用）。
   *  coverage 槽数 = backCovs + inputCovs + lookCovs，一次性预分配容量避免 grow。 */
  const totalCovSlots = parsed.backCovs.length + parsed.inputCovs.length + parsed.lookCovs.length;
  const covSlotPositions: number[] = new Array<number>(totalCovSlots);
  /** 占位写入 coverage 偏移槽并记录其字节位置 */
  let slotIdx = 0;
  const reserveCovSlot = () => {
    covSlotPositions[slotIdx++] = w.length;
    w.writeUint16(0);
  };
  w.writeUint16(3);
  w.writeUint16(parsed.backCovs.length);
  for (let k = 0; k < parsed.backCovs.length; k++) reserveCovSlot();
  w.writeUint16(parsed.inputCovs.length);
  for (let k = 0; k < parsed.inputCovs.length; k++) reserveCovSlot();
  w.writeUint16(parsed.lookCovs.length);
  for (let k = 0; k < parsed.lookCovs.length; k++) reserveCovSlot();
  w.writeUint16(parsed.records.length);
  for (const rc of parsed.records) {
    w.writeUint16(rc.seq);
    w.writeUint16(rc.lookup);
  }

  /** 写出各组 coverage 并回填偏移槽（相对 subStart） */
  let posIdx = 0;
  for (const cov of parsed.backCovs) {
    w.writeInt16At(covSlotPositions[posIdx++], emitCoverage(w, cov) - subStart);
  }
  for (const cov of parsed.inputCovs) {
    w.writeInt16At(covSlotPositions[posIdx++], emitCoverage(w, cov) - subStart);
  }
  for (const cov of parsed.lookCovs) {
    w.writeInt16At(covSlotPositions[posIdx++], emitCoverage(w, cov) - subStart);
  }
}

/**
 * 廉价预检：subtable 是否可跳过深度序列化（输出空 subtable）。
 *
 * FiraCode 等连字字体含大量 lookup（实测 403 个），但子集只命中少数字形，
 * 多数 lookup 其规则涉及的 coverage gid 全部不在子集内 —— 深度序列化后必然得到空 entries、
 * 回退 writeEmptySubtable。预检在深度解析前用 gidLookup 内联判定（不碰 covCache、不分配数组），
 * 命中即跳过。
 *
 * 预检规则（覆盖主 coverage 决定触发的类型）：
 *   - SingleSubst/Multiple/Alternate/Ligature：主 coverage（subOff+2）全子集外 → entries 为空
 *   - ChainContextSubst format1：主 coverage（input 第一分量）全子集外 → 所有 ruleSet 失效
 *   - ChainContextSubst format3：backtrack/input/lookahead 任一 coverage 组「原非空且全子集外」→ 规则失效
 *
 * 不预检 ChainContextSubst format2：规则由 InputClassDef 的 class 驱动，主 coverage 全空不代表无效
 * （FiraCode calt 的 format2 连字规则，主 coverage 字形不在子集，但深度解析经 class 仍保留规则，
 *  误判全空会导致连字丢失、SSIM 暴跌 0.9923→0.9368）。
 *
 * @returns true = 可跳过深度序列化（输出空 subtable）；false = 需深度解析
 */
function isSubtableSkipableByCoverage(
  r: Reader,
  off: number,
  type: number,
  gidLookup: GidLookup,
): boolean {
  const dv = r.dv;
  const len = dv.byteLength;

  /** ChainContext format3：遍历 back/input/look 三个 coverage 组，任一组原非空且全子集外则失效 */
  if (type === LT_CHAIN) {
    if (off + 2 > len) return false;
    const chainFmt = dv.getUint16(off, false);
    if (chainFmt === 2) return false; /** format2 class 驱动，不预检 */
    if (chainFmt === 3) {
      /**
       * 优化317+318：format3 预检判定。
       * format3 规则触发需 backtrack/input/lookahead 三组 coverage 的 gid 全部在子集内。
       * 故只要【任一 coverage】原非空且全子集外，规则就不可能触发，可跳过深度解析。
       *
       * 优化318：预检改用 readCoverageRemapped（与 parseChainFormat3 同一判定函数 + 共享 covCache），
       * 保证预检「跳过」⟺ 深度解析「失败」，输出完全一致（都是空 subtable）。
       * 旧 coverageAllOutOfSubset 内联判定的 COV_RANGE 累积超限逻辑与 readCoverageRemapped 不一致，
       * 导致 FiraCode 13 个 format3 预检未跳过却深度解析失败（0.328ms/call 浪费）。
       * readCoverageRemapped 触碰 covCache 无副作用：其 entry 的 gids 字段留 EMPTY_GIDS 占位，
       * readCoverageGids 命中时按 miss 重算（已有逻辑）。
       */
      let p = off + 2;
      for (let grp = 0; grp < 3; grp++) {
        if (p + 2 > len) return false;
        const cnt = dv.getUint16(p, false);
        p += 2;
        for (let k = 0; k < cnt; k++) {
          if (p + 2 > len) return false;
          const covOff = off + dv.getUint16(p + k * 2, false);
          /** 用 coverageAllOutOfSubset 内联快判「全子集外」（不分配数组、不读写 covCache）。
           *  思源 fmt3 预检 281 个 coverage 全子集外且 avg 仅 1.3 gid——readCoverageRemapped 对每个
           *  都 new Array+sort+Map.set 是纯固定开销，且这些 skipable coverage 的 cache entry 永不被命中
           *  （skipable subtable 不深度解析）。预检只判「是否全子集外」→ skipable，无需填 cache；
           *  非 skipable 的 subtable 深度解析时 readCoverageRemapped 自行首次填 cache（命中率不变）。
           *  一致性（[[gsub-subset-fmt3-prefetch-consistency]]）：coverageAllOutOfSubset 的判定语义已与
           *  readCoverageRemapped 对齐（COV_RANGE clamp 到 numGlyphs、越界 range 计 origNonEmpty），
           *  故预检 skipable ⟺ 深度解析 coverage 失效，输出逐字节一致。 */
          if (coverageAllOutOfSubset(dv, covOff, len, gidLookup)) return true;
        }
        p += cnt * 2;
      }
      return false;
    }
  }

  /** 主 coverage 在 subOff+2（Offset16）的类型：Single/Multiple/Alternate/Ligature/Chain-format1 */
  if (off + 4 > len) return false;
  const covOff = off + dv.getUint16(off + 2, false);
  return coverageAllOutOfSubset(dv, covOff, len, gidLookup) === true;
}

/**
 * 用 gidLookup 判定单个 coverage 是否「原非空且全部 gid 落子集外」。
 * 内联遍历 coverage 字节（format1 列表 / format2 区间），不分配数组、不读写 covCache。
 * 预检在每个 subtable 入口被调用（FiraCode 403 lookup × 多 subtable，密度极高），
 * 短路判定（首命中子集内 gid 即返回）比 readCoverageRemapped + 数组过滤快得多，
 * 且无需触碰缓存、不产生 GC 压力。
 *
 * @returns true=原非空且全子集外（可据此跳过）；false=含子集内 gid 或原 coverage 本就空或越界；
 *          「原空」与「越界」都返回 false（保守不跳过，交深度解析）
 */
function coverageAllOutOfSubset(
  dv: DataView,
  covOff: number,
  len: number,
  gidLookup: GidLookup,
): boolean {
  if (covOff + 4 > len) return false;
  const format = dv.getUint16(covOff, false);
  if (format === COV_LIST) {
    const count = dv.getUint16(covOff + 2, false);
    if (count === 0) return false; /** 原 coverage 本就空，不算 outOfSubset */
    const base = covOff + 4;
    if (base + count * 2 > len) return false;
    for (let i = 0; i < count; i++) {
      if (gidLookup[dv.getUint16(base + i * 2, false)] >= 0) return false;
    }
    return true;
  }
  if (format === COV_RANGE) {
    const rangeCount = dv.getUint16(covOff + 2, false);
    /** 排序子集 gid 数组（currentSortedSubsetGids，模块级，subsetGSUB 入口已设）。
     *  range 相交判定改二分（O(log n) per range）替代逐 gid 展开（O(range length)）。
     *  初夏 fmt3 range 展开总 20388 gid、300 range、12 子集 gid，逐 gid 0.012ms vs 二分 0.001ms（10×）。
     *  等价性：range [start,end] 含 gidLookup[g]>=0 的 g ⟺ 排序子集 gid 数组存在 gid ∈ [start,end]
     *  （gidLookup[g]>=0 ⟺ g 是子集 gid ⟺ g 在排序子集数组）。end clamp/越界语义不变：
     *  sortedGids 全部 < numGlyphs，二分天然只在子集 gid 范围查，end>=numGlyphs 时子集 gid 仍可能 <= end。 */
    const sortedGids = getSortedSubsetGids();
    const subsetN = sortedGids.length;
    let p = covOff + 4;
    let origNonEmpty = false;
    for (let i = 0; i < rangeCount; i++) {
      if (p + 6 > len) break;
      const start = dv.getUint16(p, false);
      const end = dv.getUint16(p + 2, false);
      if (end >= start && end - start < COVERAGE_MAX_EXPAND) {
        /** range 非空（无论是否含子集 gid），标记 origNonEmpty */
        origNonEmpty = true;
        /** 二分判定 range 是否含任一子集 gid。subsetN=0（空子集，理论上不进 GSUB）或 range 全在
         *  sortedGids 范围外时 lo 落到边界，sortedGids[lo] > end → 无交集，与逐 gid 全 <0 一致。 */
        if (subsetN > 0 && start <= sortedGids[subsetN - 1] && end >= sortedGids[0]) {
          let lo = 0, hi = subsetN;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sortedGids[mid] < start) lo = mid + 1;
            else hi = mid;
          }
          /** lo = 第一个 >= start 的子集 gid 下标；若该 gid <= end 则 range 含子集 gid → 非 outOfSubset */
          if (lo < subsetN && sortedGids[lo] <= end) return false;
        }
      }
      p += 6;
    }
    return origNonEmpty;
  }
  return false;
}

/** 单个 subtable 序列化分发。返回 false 表示该 subtable 无法重映射（调用方决定降级） */
function serializeSubtable(
  w: Writer,
  r: Reader,
  off: number,
  type: number,
  origToNew: Map<number, number>,
  covCache: CoverageCache,
  gidLookup: GidLookup,
  /** 预扫描已判定的 skipable 结果。传入时跳过内部 isSubtableSkipableByCoverage 重复预检
   *  （subsetGSUB 主循环预扫描已对每个子表判过，结果只依赖 coverage 字节+gidLookup 不变，可复用）。 */
  preCheckedSkipable: boolean | undefined,
): boolean {
  r.clearError();
  /** 预检：主 coverage（或 fmt3 的三组 coverage）全子集外则直接判失败（输出空 subtable），
   *  跳过昂贵的深度解析。FiraCode 403 lookup 中 ~330 个可预检跳过（type1-4 + fmt1 + fmt3 失效），
   *  format2 不预检（class 驱动，主 coverage 非充分条件）。
   *  预扫描已判时直接用其结果（消除重复预检），否则现场判。 */
  if (preCheckedSkipable !== undefined ? preCheckedSkipable : isSubtableSkipableByCoverage(r, off, type, gidLookup)) return false;
  let ok: boolean;
  switch (type) {
    case LT_SINGLE:
      ok = serializeSingleSubst(w, r, off, gidLookup);
      break;
    case LT_MULTIPLE:
      ok = serializeMultipleSubst(w, r, off, gidLookup);
      break;
    case LT_ALTERNATE:
      ok = serializeAlternateSubst(w, r, off, gidLookup);
      break;
    case LT_LIGATURE:
      ok = serializeLigatureSubst(w, r, off, gidLookup);
      break;
    case LT_CHAIN:
      ok = serializeChainedContextSubst(w, r, off, origToNew, covCache, gidLookup);
      break;
    default:
      return false;
  }
  /** 读取越界（偏移计算异常）则降级，避免输出损坏数据 */
  if (r.errorFlag) return false;
  return ok;
}

/**
 * GSUB 子集化入口
 *
 * @param gsubBytes 原始 GSUB 表字节
 * @param origToNew 原gid → 新gid 映射；不在 map 中的原 gid 表示已被子集化剔除
 * @returns 重映射后的 GSUB 字节
 */
export function subsetGSUB(
  gsubBytes: Uint8Array,
  origToNew: Map<number, number>,
): Uint8Array {
  const dv = new DataView(gsubBytes.buffer, gsubBytes.byteOffset, gsubBytes.byteLength);
  const r = new Reader(dv);

  /** Coverage 解析缓存：ChainContextSubst format3 中 coverage 被大量 subtable 重复引用，
   *  按 off 缓存解析结果，消除重复 u16 读取与数组分配（FiraCode 实测 604 引用/83 独立 coverage）。 */
  const covCache: CoverageCache = new Map();

  /** 原gid → 新gid 数组查找表（coverage 边解析边过滤的热路径用，数组索引比 Map.get 快数倍）。
   *  下标=原gid，值=新gid，-1 表示不在子集。容量覆盖出现的最大原 gid。 */
  let maxOrigGid = 0;
  for (const g of origToNew.keys()) if (g > maxOrigGid) maxOrigGid = g;
  const gidLookup: GidLookup = new Int32Array(maxOrigGid + 1).fill(-1);
  for (const [g, n] of origToNew) gidLookup[g] = n;

  /** 升序子集原始 gid 数组（惰性）：供 readClassDefMap format2 / coverage range 二分优化。
   *  优化336：不在入口无条件 sort（全字符集 27677 gid 耗 ~3.2ms），改为设 source + 清缓存，
   *  首次 getSortedSubsetGids() 调用时（即真正遇到 format2/range 路径）才构造。 */
  currentSortedSubsetSource = origToNew;
  currentSortedSubsetGids = null;

  /** ---- GSUB Header ---- */
  /** header offset（0/2/4/6/8）永不越界，dv 直接 getUint16 省方法调用+边界检查；
   *  派生 offset（lookupListOff 等）改 dv 会使损坏表从 errorFlag 降级变 RangeError crash，
   *  合法字体零影响（见 [[gpos-dv-getuint16]] 权衡）。dv 在函数顶部已由 gsubBytes 构造。 */
  const major = dv.getUint16(0, false);
  const minor = dv.getUint16(2, false);
  if (major !== 1 || minor > 1) {
    /** 不支持的版本，原样返回 */
    return gsubBytes;
  }
  const scriptListOff = dv.getUint16(4, false);
  const featureListOff = dv.getUint16(6, false);
  const lookupListOff = dv.getUint16(8, false);

  /** ---- 解析 LookupList ---- */
  const lookupCount = dv.getUint16(lookupListOff, false);
  const lookupRelOffs: number[] = [];
  for (let i = 0; i < lookupCount; i++) {
    lookupRelOffs.push(dv.getUint16(lookupListOff + 2 + i * 2, false));
  }

  /** 第一遍：解析每个 lookup 的 effectiveType 与 subtable 偏移，判断是否可重映射 */
  interface LookupInfo {
    supported: boolean;
    effectiveType: number;
    subtableAbsOffs: number[];
    origLookupOff: number;
    /** 该 lookup 的所有子表 coverage 是否都「原非空且全子集外」（→ 序列化必为空 subtable）。
     *  为 true 时跳过逐子表 serializeSubtable，直接批量写空 subtable（保留 subCount，不删 lookup）。
     *  含 format2 class 驱动子表的 lookup，isSubtableSkipableByCoverage 返回 false，故 allEmpty 必为 false，
     *  走原逐子表路径（保守，与 FiraCode 连字安全要求一致 [[gsub-lookup-deletion-failed-fira]]）。 */
    allEmpty: boolean;
    /** 每个子表的 isSubtableSkipableByCoverage 预扫描结果（与 subtableAbsOffs 同序）。
     *  预扫描（下方）填，serialize 阶段复用——避免 serializeSubtable 内部对同一子表再调一次
     *  isSubtableSkipableByCoverage（思源 56 lookup × 多子表，预扫描与 serialize 各判一次=重复）。
     *  结果只依赖 coverage 字节 + gidLookup（subsetGSUB 内均不变），与 covCache 状态无关
     *  （covCache 顺序依赖 bug 已修复，readCoverageRemapped 命中任意 entry 结果正确）。 */
    subtableSkipable: boolean[];
  }
  const lookups: LookupInfo[] = [];
  for (let i = 0; i < lookupCount; i++) {
    const lOff = lookupListOff + lookupRelOffs[i];
    const lookupType = dv.getUint16(lOff, false);
    const subTableCount = dv.getUint16(lOff + 4, false);
    const subtableAbsOffs: number[] = [];
    let effectiveType = lookupType;
    for (let j = 0; j < subTableCount; j++) {
      const subOff = lOff + dv.getUint16(lOff + 6 + j * 2, false);
      if (lookupType === LT_EXTENSION) {
        /** ExtensionSubst format1：ExtensionFormat(=1) + ExtensionLookupType + ExtensionOffset(u32) */
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
    /** 支持重映射的类型：1 Single / 2 Multiple / 3 Alternate / 4 Ligature / 6 ChainedContext。
     *  type5 ReverseChain 罕见且结构特殊，标记为不支持（走空 subtable 降级）。 */
    const supported =
      effectiveType === LT_SINGLE ||
      effectiveType === LT_MULTIPLE ||
      effectiveType === LT_ALTERNATE ||
      effectiveType === LT_LIGATURE ||
      effectiveType === LT_CHAIN;
    lookups.push({ supported, effectiveType, subtableAbsOffs, origLookupOff: lOff, allEmpty: false, subtableSkipable: [] });
  }

  /**
   * 优化331：lookup 级全空预扫描。
   * 大字体小子集场景（初夏 51 lookup × lookup[5] 268 子表），逐子表 serializeSubtable 即使预检
   * 判空仍要付出「函数调用 + isSubtableSkipableByCoverage 读 coverage + rollback」的 per-subtable 开销。
   * 若整个 lookup 的所有子表都 skipable（全子集外），序列化结果必然是 N 个空 subtable——
   * 直接在 lookup 级批量写空，跳过 N 次 serializeSubtable 调用。
   *
   * 安全性：allEmpty 当且仅当「所有子表 isSubtableSkipableByCoverage === true」。而 serializeSubtable
   * 内部对 skipable 子表直接 return false（→ 调用方写空 subtable）。故 allEmpty 路径的输出与
   * 逐子表路径**逐字节相同**（都是 N 个 writeEmptySubtable）。format2 子表不预检（返回 false），
   * 含 format2 的 lookup allEmpty 必为 false，走原路径。 */
  for (let i = 0; i < lookupCount; i++) {
    const lk = lookups[i];
    if (!lk.supported) continue;
    /** 完整扫描每个子表记录 skipable（供 serialize 复用，避免 serializeSubtable 内部重复预检）。
     *  原实现 allEmpty=false 时 break 早退省后续判定，但 serialize 阶段对每个子表再调一次
     *  isSubtableSkipableByCoverage（type1/2/3/4 主 coverage + fmt3 三组 coverage）。缓存完整结果后
     *  serialize 直接查数组，消除第二次预检。allEmpty = 全部 skipable（数组全 true）。 */
    const subs = lk.subtableAbsOffs;
    const skipable = new Array<boolean>(subs.length);
    let allEmpty = subs.length > 0;
    for (let j = 0; j < subs.length; j++) {
      const sk = isSubtableSkipableByCoverage(r, subs[j], lk.effectiveType, gidLookup);
      skipable[j] = sk;
      if (!sk) allEmpty = false;
    }
    lk.subtableSkipable = skipable;
    lk.allEmpty = allEmpty;
  }

  /** ---- 重新序列化 ----
   *  ScriptList / FeatureList 与 glyphId 无关（仅引用 lookup index），但其子表
   *  （ScriptTable/LangSys/FeatureTable）偏移相对各自 List 起始，且在原始字体中可能与
   *  其他块【物理交错】（如霞鹜文楷 GSUB：ScriptList 跨越 FeatureList 起始位置），
   *  不能按连续字节块原样拷贝。这里遍历所有子表紧凑重排并回填相对偏移（serializeScriptList /
   *  serializeFeatureList），保证输出为合法连续块。
   *  LookupList 逐 lookup 处理：
   *    - 支持的：gid 重映射后重新序列化
   *    - 不支持的（type5 等）：原样拷贝原始字节（gid 不重映射，浏览器查 coverage 查不到会跳过）
   */
  /** ScriptList / FeatureList 整块拷贝快路径（同 subsetGPOS）：
   *  两表不含 glyphId，若子表紧凑排列不与相邻 list 物理交错，字节块本身即合法表，
   *  直接 subarray 拷贝跳过逐字段序列化，并保留 fontTools 去重。
   *
   *  交错判定用「span 不越过下一 list 的 header offset」：SL 上界为 featureListOff，
   *  FL 上界为 lookupListOff。霞鹜文楷 GSUB 布局为 LookupList(10) < ScriptList(38)
   *  < FeatureList(76)，ScriptTable 跨越 FeatureList 起始、且 LookupList 数据散落在
   *  FeatureList 之后——此时 lookupListOff(10) < featureListOff(76)，FL 的 span 必然
   *  > lookupListOff 而降级；SL span(350) 也越过 fl(76) 而降级。故物理交错字体自动走
   *  serialize，安全。不使用「三个 offset 中下一个更大值」作上界：LookupList 的 subtable
   *  可散落在任意偏移，header offset 不能代表其字节范围。 */
  const slSpan = scriptListSpan(r, scriptListOff);
  const slContiguous = slSpan >= 0 && scriptListOff + slSpan <= featureListOff;
  const scriptListBytes = slContiguous
    ? gsubBytes.subarray(scriptListOff, scriptListOff + slSpan)
    : serializeScriptList(r, scriptListOff);
  const flSpan = featureListSpan(r, featureListOff);
  const flContiguous = flSpan >= 0 && featureListOff + flSpan <= lookupListOff;
  const featureListBytes = flContiguous
    ? gsubBytes.subarray(featureListOff, featureListOff + flSpan)
    : serializeFeatureList(r, featureListOff);
  r.clearError();
  /** ScriptList/FeatureList 解析失败（异常表）则整体保留原始 GSUB 字节（安全降级） */
  if (!scriptListBytes || !featureListBytes) return gsubBytes;

  /** 主 Writer 按原 GSUB 表大小预分配容量，避免大 GSUB（令东千字文 GSUB 数十 KB）多次 grow 全拷贝 */
  const w = new Writer(gsubBytes.byteLength);

  /** Header */
  w.writeUint16(1);
  w.writeUint16(minor);
  const scriptListAbsHolder: number[] = [0];
  const featureListAbsHolder: number[] = [0];
  const lookupListAbsHolder: number[] = [0];
  w.reserveOffset16(0, () => scriptListAbsHolder[0]);
  w.reserveOffset16(0, () => featureListAbsHolder[0]);
  w.reserveOffset16(0, () => lookupListAbsHolder[0]);

  /** ScriptList 重序列化字节 */
  scriptListAbsHolder[0] = w.length;
  w.writeBytes(scriptListBytes);

  /** FeatureList 重序列化字节 */
  featureListAbsHolder[0] = w.length;
  w.writeBytes(featureListBytes);

  /** LookupList 重写 */
  lookupListAbsHolder[0] = w.length;
  const lookupListAbs = lookupListAbsHolder[0];
  w.writeUint16(lookupCount);
  /**
   * 优化333: lookup 偏移槽用 writeUint16(0) 占位 + 记录 slot 起点，序列化后统一 writeInt16At 回填，
   * 替代 reserveOffset16 的 per-lookup 闭包分配 + patch push（与优化329 subtable 槽同思路）。
   * 思源 GSUB 56 lookup，消除 56 次闭包 + patch 对象分配。
   */
  const lookupSlotsStart = w.length;
  for (let i = 0; i < lookupCount; i++) {
    w.writeUint16(0);
  }
  const lookupAbsPositions: number[] = new Array(lookupCount);

  /** 逐 lookup 序列化 */
  for (let i = 0; i < lookupCount; i++) {
    lookupAbsPositions[i] = w.length;
    const lk = lookups[i];

    if (lk.supported) {
      const lookupFlag = r.u16(lk.origLookupOff + 2);
      const useMarkFilteringSet = (lookupFlag & 0x0010) !== 0;

      /** 输出用 effectiveType（extension 解包后内嵌，不再用 extension 包裹） */
      w.writeUint16(lk.effectiveType);
      w.writeUint16(lookupFlag);

      if (lk.allEmpty) {
        /** 优化337（与 subsetGPOS 优化330 一致）：全空 lookup 折叠 subCount=1 的单个空 subtable。
         *  feature 仅按 lookup index 引用，subCount 改变不影响 feature；浏览器遍历 subtable 查 coverage，
         *  单个空 subtable 与 N 个全空 subtable 渲染语义等价（都查不到字形跳过）。FiraCode 403 lookup
         *  中 235 个全空（58%），折叠省去 (N-1)×10 字节/lookup（偏移槽 2 + 空 subtable 8）的逐空序列化。
         *  与 [[gsub-lookup-deletion-failed-fira]] 区别：不删 lookup（index 不变、feature 不受影响），
         *  仅把全空 lookup 内的 N 个空 subtable 折叠为 1 个。 */
        w.writeUint16(1);
        const lookupStart = w.length - 6;
        const subtableSlotsStart = w.length;
        w.writeUint16(0);
        if (useMarkFilteringSet) {
          /** markFilteringSet 读原 N 位置（原 lookup 头布局），写到新 1 槽之后（输出布局） */
          w.writeUint16(r.u16(lk.origLookupOff + 6 + lk.subtableAbsOffs.length * 2));
        }
        const subtablePos = w.length;
        writeEmptySubtable(w, lk.effectiveType);
        w.writeInt16At(subtableSlotsStart, subtablePos - lookupStart);
      } else {
        w.writeUint16(lk.subtableAbsOffs.length);
        const lookupStart = w.length - 6;
        /**
         * 优化329（与 subsetGPOS 一致）：subtable 偏移槽用 writeUint16(0) 占位 + 记录 slot 起点，
         * 序列化后统一 writeInt16At 回填，替代 reserveOffset16 的 per-slot 闭包分配 + patch push。
         * 思源 GSUB 56 lookup × 323 subtable，闭包消除省去 323 次对象分配。
         */
        const subtableSlotsStart = w.length;
        for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
          w.writeUint16(0);
        }
        if (useMarkFilteringSet) {
          w.writeUint16(r.u16(lk.origLookupOff + 6 + lk.subtableAbsOffs.length * 2));
        }
        for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
          /** 单个 subtable 重映射失败（coverage gid 全不在子集 / 解析异常）时，
           *  回退已写入字节，改为输出合法的空 subtable（空 coverage，浏览器跳过，不破坏字体）。
           *  不再用 copyBytesBlock 按估算范围拷贝——原始 subtable 数据可能与其他 lookup 物理交错，
           *  按 lookup 边界估算会拷贝到错误字节（霞鹜文楷实测 subtable 在表头区之后）。 */
          const before = w.length;
          const ok = serializeSubtable(w, r, lk.subtableAbsOffs[j], lk.effectiveType, origToNew, covCache, gidLookup, lk.subtableSkipable[j]);
          if (!ok) {
            w.rollback(before);
            writeEmptySubtable(w, lk.effectiveType);
          }
          /** 回填偏移槽：subtable 起点为 before（成功=serializeSubtable 起点，失败=rollback 后空 subtable 起点，两者同值） */
          w.writeInt16At(subtableSlotsStart + j * 2, before - lookupStart);
        }
      }
    } else {
      /** 不支持的 lookup（type5 ReverseChain，及尚未验证的类型）：
       *  保持 lookup 表头（type/flag/subCount）与 subtable 槽位数，逐 subtable 输出空 subtable。
       *  不原样拷贝原始 subtable 字节——其 coverage/ClassDef 等子结构在原始字体中可能与其他
       *  lookup 物理交错、散落在任意偏移，按间距/边界估算拷贝会破坏字体（实测霞鹜文楷 type4
       *  的 coverage 在 subtable 后 2594 字节处）。空 subtable 合法且 coverage 为空，浏览器跳过，
       *  仅丢失该 lookup 覆盖字形的替换规则，不影响其他 lookup 与整体结构。 */
      const lookupFlag = r.u16(lk.origLookupOff + 2);
      const useMarkFilteringSet = (lookupFlag & 0x0010) !== 0;
      w.writeUint16(r.u16(lk.origLookupOff));
      w.writeUint16(lookupFlag);
      w.writeUint16(lk.subtableAbsOffs.length);
      const lookupStart = w.length - 6;
      /**
       * 优化334（与 supported 分支优化329 一致）：unsupported lookup 的 subtable 偏移槽也用
       * writeUint16(0) 占位 + 记录 slot 起点 + 序列化后 writeInt16At 回填，替代 reserveOffset16 闭包。
       */
      const subtableSlotsStart = w.length;
      for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
        w.writeUint16(0);
      }
      if (useMarkFilteringSet) {
        w.writeUint16(r.u16(lk.origLookupOff + 6 + lk.subtableAbsOffs.length * 2));
      }
      for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
        w.writeInt16At(subtableSlotsStart + j * 2, w.length - lookupStart);
        writeEmptySubtable(w, lk.effectiveType);
      }
    }
    /** 优化333: 回填 lookup 偏移槽（相对 LookupList 起始） */
    w.writeInt16At(lookupSlotsStart + i * 2, lookupAbsPositions[i] - lookupListAbs);
  }

  w.flush();
  return w.toUint8Array();
}
