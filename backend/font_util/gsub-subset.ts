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
    /** 已缓存：失效返回 null，否则返回重映射数组（remapped 已在首次计算时填好） */
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
      let p = off + 4;
      for (let i = 0; i < rangeCount; i++) {
        if (p + 6 > len) break;
        const start = dv.getUint16(p, false);
        const end = dv.getUint16(p + 2, false);
        if (end >= start && end - start < COVERAGE_MAX_EXPAND && newGids.length + (end - start + 1) <= COVERAGE_MAX_EXPAND) {
          if (start >= numGlyphs) {
            /** 整个 range 越界：原代码逐 gid 遍历全跳过 push 但会设 origNonEmpty=true，此处保持等价语义
             *  （→ newGids 空、origNonEmpty=true → outOfSubset → 返回 null） */
            origNonEmpty = true;
          } else {
            /** clamp end 到合法 gid 范围；start..numGlyphs-1 段与原代码逐 gid 处理完全相同，
             *  numGlyphs..end 段原代码全越界跳过，clamp 后省去该段空循环 */
            const e = end < numGlyphs ? end : numGlyphs - 1;
            for (let g = start; g <= e; g++) {
              origNonEmpty = true;
              const m = gidLookup[g];
              if (m >= 0) newGids.push(m);
            }
          }
        }
        p += 6;
      }
    }
  }
  /** 原 coverage 非空但全部 gid 落子集外 → 失效（与原 coverage 本就空的合法空数组区分） */
  if (newGids.length === 0 && origNonEmpty) outOfSubset = true;
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
function emitCoverage(w: Writer, newGids: number[]): number {
  /** 升序（Coverage 要求升序）。
   *  无需去重：所有调用方传入的 newGids 逻辑上保证无重复——
   *  readCoverageRemapped 按原 coverage（规范要求 gid 唯一）升序过滤，每个原 gid 映射唯一新 gid；
   *  entries.map(e=>e.from) 的 from 是 entry 主键（唯一）。
   *  实测 FiraCode 单次子集化 327 次 emitCoverage 调用 0 次发现重复，去重（new Set）纯为 GC 开销。
   *  slice 复制后原地排序，避免修改调用方的数组。 */
  const sorted = newGids.slice().sort((a, b) => a - b);
  const off = w.length;
  let ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    ranges.push({ start: sorted[i], end: sorted[j] });
    i = j + 1;
  }
  if (ranges.length > 0 && ranges.length < sorted.length) {
    /** format2 区间更紧凑 */
    w.writeUint16(COV_RANGE);
    w.writeUint16(ranges.length);
    let covIndex = 0;
    for (const rg of ranges) {
      w.writeUint16(rg.start);
      w.writeUint16(rg.end);
      w.writeUint16(covIndex);
      covIndex += rg.end - rg.start + 1;
    }
  } else {
    /** format1 列表 */
    w.writeUint16(COV_LIST);
    w.writeUint16(sorted.length);
    for (const g of sorted) w.writeUint16(g);
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
  const format = r.u16(off);
  const covOff = off + r.u16(off + 2);
  const covGids = readCoverageGids(r, covOff);

  /** 收集 (from新gid → to新gid) 有效项，子集外的剔除 */
  const entries: Array<{ from: number; to: number }> = [];
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
      const toNew = gidLookup[r.u16(off + 6 + i * 2)];
      if (fromNew >= 0 && toNew >= 0) entries.push({ from: fromNew, to: toNew });
    }
  } else {
    return false;
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
  const covOff = off + r.u16(off + 2);
  const seqCount = r.u16(off + 4);
  const covGids = readCoverageGids(r, covOff);

  /** 逐 coverage 字形读取其 sequence，重映射后保留有效项 */
  const entries: Array<{ from: number; seq: number[] }> = [];
  for (let i = 0; i < covGids.length && i < seqCount; i++) {
    const fromNew = gidLookup[covGids[i]];
    if (fromNew < 0) continue;
    const seqOff = off + r.u16(off + 6 + i * 2);
    const glyphCount = r.u16(seqOff);
    const newSeq: number[] = [];
    for (let k = 0; k < glyphCount; k++) {
      const g = gidLookup[r.u16(seqOff + 2 + k * 2)];
      if (g >= 0) newSeq.push(g);
    }
    /** 序列至少 1 个目标 gid 才有意义 */
    if (newSeq.length > 0) entries.push({ from: fromNew, seq: newSeq });
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
  const covOff = off + r.u16(off + 2);
  const altCount = r.u16(off + 4);
  const covGids = readCoverageGids(r, covOff);

  const entries: Array<{ from: number; alts: number[] }> = [];
  for (let i = 0; i < covGids.length && i < altCount; i++) {
    const fromNew = gidLookup[covGids[i]];
    if (fromNew < 0) continue;
    const altOff = off + r.u16(off + 6 + i * 2);
    const cnt = r.u16(altOff);
    const newAlts: number[] = [];
    for (let k = 0; k < cnt; k++) {
      const g = gidLookup[r.u16(altOff + 2 + k * 2)];
      if (g >= 0) newAlts.push(g);
    }
    if (newAlts.length > 0) entries.push({ from: fromNew, alts: newAlts });
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
  const covOff = off + r.u16(off + 2);
  const setCount = r.u16(off + 4);
  const covGids = readCoverageGids(r, covOff);

  /** 每个 coverage 字形收集有效 ligature 列表 */
  const entries: Array<{ from: number; ligs: Array<{ comp: number[]; lig: number }> }> = [];
  for (let i = 0; i < covGids.length && i < setCount; i++) {
    /** gidLookup[origGid] = 新gid 或 -1（不在子集）。数组索引比 Map.get 快 ~2×，
     *  serializeLigatureSubst 对每条 ligature 的全部分量密集 remapGid，是 CJK ligature 子集热点。 */
    const fromNew = gidLookup[covGids[i]];
    if (fromNew < 0) continue;
    const setOff = off + r.u16(off + 6 + i * 2);
    const ligCount = r.u16(setOff);
    const newLigs: Array<{ comp: number[]; lig: number }> = [];
    for (let j = 0; j < ligCount; j++) {
      const ligOff = setOff + r.u16(setOff + 2 + j * 2);
      const compCount = r.u16(ligOff);
      const ligNew = gidLookup[r.u16(ligOff + 2)];
      if (ligNew < 0) continue;
      /** components 从第 2 字形开始（第 1 字形即 coverage 字形），compCount 含第 1 字形 */
      const compNew: number[] = [fromNew];
      let ok = true;
      for (let k = 0; k < compCount - 1; k++) {
        const c = gidLookup[r.u16(ligOff + 4 + k * 2)];
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
 * 读取 ClassDef 表为 (origGid → classIndex) map，仅含子集内 gid。
 * format1: 逐 gid 赋 class；format2: 区间赋 class。
 */
/** 读取 ClassDef 表为 (新gid → classIndex) map，class index 原样保留（不紧致重编号） */
function readClassDefMap(r: Reader, off: number, gidLookup: GidLookup): Map<number, number> {
  const result = new Map<number, number>();
  if (off === 0) return result;
  const format = r.u16(off);
  if (format === 1) {
    const startGid = r.u16(off + 2);
    const count = r.u16(off + 4);
    for (let i = 0; i < count; i++) {
      const origGid = startGid + i;
      /** 优化333：gidLookup（Int32Array 索引，~1ns）替代 origToNew.get（Map.get ~9ns）。
       *  FiraCode fmt2 ClassDef 展开后 9699 个 gid 逐个 Map.get 是 fmt2 路径主热点（86μs/11 子表）。
       *  语义等价：gidLookup[g] >= 0 ⟺ origToNew.has(g) 且值相同。 */
      const newGid = gidLookup[origGid];
      if (newGid >= 0) result.set(newGid, r.u16(off + 6 + i * 2));
    }
  } else if (format === 2) {
    const rangeCount = r.u16(off + 2);
    let p = off + 4;
    for (let i = 0; i < rangeCount; i++) {
      const start = r.u16(p);
      const end = r.u16(p + 2);
      const cls = r.u16(p + 4);
      for (let g = start; g <= end; g++) {
        /** 同上，gidLookup 数组索引替代 Map.get */
        const newGid = gidLookup[g];
        if (newGid >= 0) result.set(newGid, cls);
      }
      p += 6;
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
      const setOff = off + r.u16(off + 6 + i * 2);
      const ruleCount = r.u16(setOff);
      if (ruleCount > 0x7fff) return false;
      const validRules: Array<{ back: number[]; input: number[]; look: number[]; records: Array<{ seq: number; lookup: number }> }> = [];
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + r.u16(setOff + 2 + j * 2);
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
      const setOffRel = r.u16(off + 12 + i * 2);
      if (setOffRel === 0) continue;
      const setOff = off + setOffRel;
      const ruleCount = r.u16(setOff);
      if (ruleCount > 0x7fff) return false;
      for (let j = 0; j < ruleCount; j++) {
        const ruleOff = setOff + r.u16(setOff + 2 + j * 2);
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
  const backCount = r.u16(ruleOff);
  /** count 异常大（偏移错位读到垃圾值）则放弃该规则，返回 null。实际规则序列长度很小（<256） */
  if (backCount > 255) return null;
  let p = ruleOff + 2;
  const backRaw: number[] = [];
  for (let k = 0; k < backCount; k++) backRaw.push(r.u16(p + k * 2));
  p += backCount * 2;
  const inputCount = r.u16(p);
  /** inputCount 为 0 是异常（ChainSubRule 至少含第一分量，inputCount>=1），返回 null 跳过该规则 */
  if (inputCount === 0 || inputCount > 255) return null;
  p += 2;
  /** input 序列不含第一分量（第一分量由 coverage/class 决定） */
  const inputRaw: number[] = [];
  for (let k = 0; k < inputCount - 1; k++) inputRaw.push(r.u16(p + k * 2));
  p += (inputCount - 1) * 2;
  const lookCount = r.u16(p);
  if (lookCount > 255) return null;
  p += 2;
  const lookRaw: number[] = [];
  for (let k = 0; k < lookCount; k++) lookRaw.push(r.u16(p + k * 2));
  p += lookCount * 2;
  const seqCount = r.u16(p);
  if (seqCount > 255) return null;
  p += 2;
  const records: Array<{ seq: number; lookup: number }> = [];
  for (let k = 0; k < seqCount; k++) {
    records.push({ seq: r.u16(p + k * 4), lookup: r.u16(p + k * 4 + 2) });
  }

  /** format1：gid 重映射，子集外 gid 则规则失效；format2：class index 原样保留 */
  const remapSeq = (arr: number[]): number[] | null => {
    if (!isGidFormat) return arr.slice();
    const out: number[] = [];
    for (const v of arr) {
      const m = remapGid(origToNew, v);
      if (m === null) return null;
      out.push(m);
    }
    return out;
  };

  const back = remapSeq(backRaw);
  const input = remapSeq(inputRaw);
  const look = remapSeq(lookRaw);
  if (back === null || input === null || look === null) return null;
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
  let p = off + 2;
  const readCovArr = (): number[][] | null => {
    const count = r.u16(p);
    p += 2;
    const arr: number[][] = [];
    for (let k = 0; k < count; k++) {
      const covOff = off + r.u16(p + k * 2);
      const newGids = readCoverageRemapped(r, covOff, gidLookup, covCache);
      /** coverage 全部 gid 落在子集外（原非空）→ 规则失效 */
      if (newGids === null) return null;
      arr.push(newGids);
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
  const records: Array<{ seq: number; lookup: number }> = [];
  for (let k = 0; k < seqCount; k++) {
    records.push({ seq: r.u16(p + k * 4), lookup: r.u16(p + k * 4 + 2) });
  }
  return { backCovs, inputCovs, lookCovs, records };
}

/** 写出 format3：重映射后的 coverage 数组 + records */
function writeChainFormat3(
  w: Writer,
  parsed: { backCovs: number[][]; inputCovs: number[][]; lookCovs: number[][]; records: Array<{ seq: number; lookup: number }> },
): void {
  const subStart = w.length;
  const allHolders: number[][] = [];
  /** 预留一个 Offset16 槽，flush 时回填 allHolders[slotIdx] 的值。
   *  必须用 IIFE 捕获当前 slotIdx——闭包直接引用 allHolders.length-1 会在 flush 时（循环已结束）
   *  统一取到最后一个槽，导致所有 coverage 偏移指向同一个 coverage（FiraCode === 连字断裂的根因）。 */
  const reserveCovSlot = () => {
    const slotIdx = allHolders.length;
    allHolders.push([0]);
    w.reserveOffset16(subStart, () => allHolders[slotIdx][0]);
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

  let holderIdx = 0;
  for (const cov of parsed.backCovs) {
    allHolders[holderIdx++][0] = emitCoverage(w, cov);
  }
  for (const cov of parsed.inputCovs) {
    allHolders[holderIdx++][0] = emitCoverage(w, cov);
  }
  for (const cov of parsed.lookCovs) {
    allHolders[holderIdx++][0] = emitCoverage(w, cov);
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
  covCache: CoverageCache,
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
          if (readCoverageRemapped(r, covOff, gidLookup, covCache) === null) return true;
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
    let p = covOff + 4;
    let origNonEmpty = false;
    for (let i = 0; i < rangeCount; i++) {
      if (p + 6 > len) break;
      const start = dv.getUint16(p, false);
      const end = dv.getUint16(p + 2, false);
      if (end >= start && end - start < COVERAGE_MAX_EXPAND) {
        for (let g = start; g <= end; g++) {
          origNonEmpty = true;
          if (gidLookup[g] >= 0) return false;
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
): boolean {
  r.clearError();
  /** 预检：主 coverage（或 fmt3 的三组 coverage）全子集外则直接判失败（输出空 subtable），
   *  跳过昂贵的深度解析。FiraCode 403 lookup 中 ~330 个可预检跳过（type1-4 + fmt1 + fmt3 失效），
   *  format2 不预检（class 驱动，主 coverage 非充分条件）。 */
  if (isSubtableSkipableByCoverage(r, off, type, gidLookup, covCache)) return false;
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

  /** ---- GSUB Header ---- */
  const major = r.u16(0);
  const minor = r.u16(2);
  if (major !== 1 || minor > 1) {
    /** 不支持的版本，原样返回 */
    return gsubBytes;
  }
  const scriptListOff = r.u16(4);
  const featureListOff = r.u16(6);
  const lookupListOff = r.u16(8);

  /** ---- 解析 LookupList ---- */
  const lookupCount = r.u16(lookupListOff);
  const lookupRelOffs: number[] = [];
  for (let i = 0; i < lookupCount; i++) {
    lookupRelOffs.push(r.u16(lookupListOff + 2 + i * 2));
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
  }
  const lookups: LookupInfo[] = [];
  for (let i = 0; i < lookupCount; i++) {
    const lOff = lookupListOff + lookupRelOffs[i];
    const lookupType = r.u16(lOff);
    const subTableCount = r.u16(lOff + 4);
    const subtableAbsOffs: number[] = [];
    let effectiveType = lookupType;
    for (let j = 0; j < subTableCount; j++) {
      const subOff = lOff + r.u16(lOff + 6 + j * 2);
      if (lookupType === LT_EXTENSION) {
        /** ExtensionSubst format1：ExtensionFormat(=1) + ExtensionLookupType + ExtensionOffset(u32) */
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
    /** 支持重映射的类型：1 Single / 2 Multiple / 3 Alternate / 4 Ligature / 6 ChainedContext。
     *  type5 ReverseChain 罕见且结构特殊，标记为不支持（走空 subtable 降级）。 */
    const supported =
      effectiveType === LT_SINGLE ||
      effectiveType === LT_MULTIPLE ||
      effectiveType === LT_ALTERNATE ||
      effectiveType === LT_LIGATURE ||
      effectiveType === LT_CHAIN;
    lookups.push({ supported, effectiveType, subtableAbsOffs, origLookupOff: lOff, allEmpty: false });
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
    let allEmpty = lk.subtableAbsOffs.length > 0;
    for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
      if (!isSubtableSkipableByCoverage(r, lk.subtableAbsOffs[j], lk.effectiveType, gidLookup, covCache)) {
        allEmpty = false;
        break;
      }
    }
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

  const w = new Writer();

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
  w.writeUint16(lookupCount);
  const lookupAbsPositions: number[] = new Array(lookupCount);
  for (let i = 0; i < lookupCount; i++) {
    const slotIdx = i;
    w.reserveOffset16(lookupListAbsHolder[0], () => lookupAbsPositions[slotIdx]);
  }

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
      if (lk.allEmpty) {
        /** 优化331：全空 lookup 批量写空 subtable，跳过逐子表 serializeSubtable。
         *  输出与逐子表路径逐字节相同（每个子表都是 writeEmptySubtable），仅省去 N 次
         *  函数调用 + 预检 + rollback 的开销。subCount 不变，lookup 仍存在。 */
        for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
          subtableAbsPositions[j] = w.length;
          writeEmptySubtable(w, lk.effectiveType);
        }
      } else {
        for (let j = 0; j < lk.subtableAbsOffs.length; j++) {
          subtableAbsPositions[j] = w.length;
          /** 单个 subtable 重映射失败（coverage gid 全不在子集 / 解析异常）时，
           *  回退已写入字节，改为输出合法的空 subtable（空 coverage，浏览器跳过，不破坏字体）。
           *  不再用 copyBytesBlock 按估算范围拷贝——原始 subtable 数据可能与其他 lookup 物理交错，
           *  按 lookup 边界估算会拷贝到错误字节（霞鹜文楷实测 subtable 在表头区之后）。 */
          const before = w.length;
          const ok = serializeSubtable(w, r, lk.subtableAbsOffs[j], lk.effectiveType, origToNew, covCache, gidLookup);
          if (!ok) {
            w.rollback(before);
            writeEmptySubtable(w, lk.effectiveType);
          }
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
        writeEmptySubtable(w, lk.effectiveType);
      }
    }
  }

  w.flush();
  return w.toUint8Array();
}
