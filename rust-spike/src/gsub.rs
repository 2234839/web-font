//! GSUB 可达收集 + 表子集化（对译 zig-spike/src/gsub.zig）
//!
//! 移植语义说明：
//! - 逐行对译 Zig 版（含其全部性能优化语义：covCache 跨路径共享、二分、反转遍历），不做等价简化——
//!   反转遍历路径（coverage 远大于 reachable 时遍历 reachable 二分 coverage）在可达侧决定 target
//!   发现顺序即插入序，必须保留；子集化侧的反转路径仅影响性能（entries 排序后字节不变），同样保留
//!   以便肉眼逐段对查。
//! - subsetGSUB 保留全部影响输出字节的语义：emitCoverage format 判据（rangeCount*6 < n*2）、
//!   entries 按 from 升序排序、readCoverageRemapped 结果升序 + 全子集外判 null、
//!   allEmpty lookup 折叠 subCount=1、skipable 子表跳过、失败降级空 subtable、
//!   ScriptList/FeatureList 连续块快路径（span 不越过下一 list 边界）。
//! - collect_reachable 返回「插入序」而非升序：TS 的 Set 迭代序 = subsetGids 追加顺序 =
//!   新 gid 编号，与 TS 引擎 glyph 顺序对拍的前提（fonteditor subsetGids 不排序）。
//! - Zig GsubError = error{OutOfMemory}：Rust 分配失败默认直接 abort，运行时不会产生 Err；
//!   Err 仅为接口契约保留（解析失败走 sentinel：null/false/-1，与 Zig 一致）。
//! - Reader 的越界标志用 Cell 内部可变性：Zig 的 *Reader 可变指针在 Rust 侧改为共享引用，
//!   使 SubCtx 能与调用方并发只读持有同一 Reader（error_flag 读写语义不变）。
//! - Zig AutoHashMap 迭代序不可预测但「结果不可观察」：所有 map 消费点都先按 gid 升序排序
//!   （writeClassDefFromMap / emitClassDefFromClassMap）或为单射查值（PairPos fmt2 紧致重编号，
//!   Rust 侧直接用升序 used 数组按下标取原 class，与 Zig 迭代反查 value==nc 的结果一致），
//!   输出字节确定。

use std::cell::Cell;
use std::collections::HashMap;

/// Coverage format1/2 展开的单 range 上限保护：超出视为偏移错位读到垃圾数据（与 TS COVERAGE_MAX_EXPAND 一致）
const COVERAGE_MAX_EXPAND: usize = 0x10000;

/// GSUB/GPOS 处理错误（对译 Zig GsubError = error{OutOfMemory}）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GsubError {
    /// 内存分配失败（Rust 分配失败默认 abort，运行时不会产生；仅为接口契约保留）
    #[allow(dead_code)] // Zig error set {OutOfMemory} 的契约成员；Rust 分配失败直接 abort 不经此路径
    OutOfMemory,
}

/// 大端序读取器（越界置 error_flag 返回 0，与 TS OTReader 一致）
struct Reader<'a> {
    data: &'a [u8],
    /// 越界标志（Cell：rd16/rd32 以 &self 置位，SubCtx 共享持有）
    error_flag: Cell<bool>,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Reader<'a> {
        Reader { data, error_flag: Cell::new(false) }
    }

    /// 带边界检查的 u16 读取（对应 TS r.u16，越界置 error_flag）
    fn rd16(&self, off: usize) -> u16 {
        if off + 2 > self.data.len() {
            self.error_flag.set(true);
            return 0;
        }
        u16::from_be_bytes([self.data[off], self.data[off + 1]])
    }

    /// 带边界检查的 i16 读取（对应 TS r.i16）
    fn rd16s(&self, off: usize) -> i16 {
        if off + 2 > self.data.len() {
            self.error_flag.set(true);
            return 0;
        }
        i16::from_be_bytes([self.data[off], self.data[off + 1]])
    }

    /// 带边界检查的 u32 读取（对应 TS r.u32）
    fn rd32(&self, off: usize) -> u32 {
        if off + 4 > self.data.len() {
            self.error_flag.set(true);
            return 0;
        }
        u32::from_be_bytes([self.data[off], self.data[off + 1], self.data[off + 2], self.data[off + 3]])
    }

    /// 无 error_flag 的 u16 读取（对应 TS 侧 dv.getUint16 直读；TS 越界会 throw，
    /// 这里按 0 处理，仅损坏表触达，合法字体两者一致）
    fn raw16(&self, off: usize) -> u16 {
        if off + 2 > self.data.len() {
            return 0;
        }
        u16::from_be_bytes([self.data[off], self.data[off + 1]])
    }

    fn clear_error(&self) {
        self.error_flag.set(false);
    }
}

/// 大端序字节写入器（偏移槽手工占位 + w16at 回填，替代 TS reserveOffset16 闭包模式，输出字节相同）
struct Writer {
    list: Vec<u8>,
}

impl Writer {
    fn new() -> Writer {
        Writer { list: Vec::new() }
    }

    /// 按上界预分配容量（对齐 Zig OTWriter 预分配经验：消除写 U16 的反复扩容 memcpy）
    fn with_capacity(cap: usize) -> Writer {
        Writer { list: Vec::with_capacity(cap) }
    }

    fn len(&self) -> usize {
        self.list.len()
    }

    fn w16(&mut self, v: u16) {
        self.list.extend_from_slice(&v.to_be_bytes());
    }

    /// 在已写入范围内回填 u16（对应 TS writeInt16At，仅覆盖不扩展）
    fn w16at(&mut self, pos: usize, v: u16) {
        self.list[pos..pos + 2].copy_from_slice(&v.to_be_bytes());
    }

    fn wbytes(&mut self, s: &[u8]) {
        self.list.extend_from_slice(s);
    }

    /// 回退到指定位置（对应 TS rollback；本实现无 patches，直接截断即可）
    fn rollback(&mut self, pos: usize) {
        self.list.truncate(pos);
    }
}

/// 插入序 gid 集合（对应 TS Set<number> 的 迭代序=插入序 语义）。
/// 位图替代 HashSet：u16 键走 SipHash 纯开销；按需增长避免定长数组的全量 memset
///（Zig 版 Set→Uint8 负优化的根因），clear 只清触碰过的前缀
#[derive(Default)]
struct OrderedGidSet {
    items: Vec<u16>,
    /// gid→bit 位图（gid/64 单调增长， doubling 由 Vec::resize 承担）
    bits: Vec<u64>,
    /// 本次 clear 需要重置的前缀长度（= 曾达到的最大 bits.len()）
    words_used: usize,
}

impl OrderedGidSet {
    /// 不存在则追加（返回是否新增）
    fn add(&mut self, gid: u16) -> bool {
        let w = (gid >> 6) as usize;
        if w >= self.bits.len() {
            self.bits.resize(w + 1, 0);
            self.words_used = self.words_used.max(self.bits.len());
        }
        let bit = 1u64 << (gid & 63);
        if self.bits[w] & bit != 0 {
            return false;
        }
        self.bits[w] |= bit;
        self.items.push(gid);
        true
    }

    fn contains(&self, gid: u16) -> bool {
        let w = (gid >> 6) as usize;
        w < self.bits.len() && self.bits[w] & (1u64 << (gid & 63)) != 0
    }

    fn count(&self) -> usize {
        self.items.len()
    }

    fn clear(&mut self) {
        self.items.clear();
        for word in &mut self.bits[..self.words_used] {
            *word = 0;
        }
        self.words_used = 0;
    }
}

/// covCache 单条目（对应 TS CoverageCache entry）
/// gids 非空（Some）= 曾被 cov_gids_cached（fmt1 路径）以「原始 gid 序」填充；
/// gids 为 None = read_coverage_remapped 首算条目（只存升序 remapped）。
/// 两态共存（先 remapped 后 gids 回填）时 gids 优先参与后续判定（与 TS 一致）。
#[derive(Default)]
struct CovEntry {
    /// 原始 gid 列表（原始顺序）；None = 未被 gids 侧填充（等价 TS EMPTY_GIDS 占位）
    gids: Option<Vec<u16>>,
    /// 重映射后新 gid（首次计算为升序；gids 命中回填为原序——TS 命中分支不排序）
    remapped: Option<Vec<u16>>,
    /// 「原非空但全子集外」失效标记（remapped=None 语义）
    out_of_subset: bool,
}

/// 原 gid → 新 gid 查找上下文（对应 TS GidLookup Int32Array + 模块级 currentSortedSubsetGids）
struct SubCtx<'a> {
    r: &'a Reader<'a>,
    /// 下标=原 gid，值=新 gid，-1=不在子集；容量=最大子集原 gid+1（与 TS buildGidLookup 一致，
    /// 越界 gid 按 -1 处理）
    gid_lookup: Vec<i32>,
    /// 子集原始 gid 升序数组（coverage format2 / ClassDef format2 二分用）
    sorted_subset: Vec<u16>,
    /// covCache：key=coverage 表绝对偏移。字节级对拍要求复刻 TS 的跨路径共享语义：
    /// chain fmt1 经 cov_gids_cached 填原始 gids 后，同 off 的 fmt3/ClassDef 重映射命中走
    /// 「原序重映射、不排序」分支（TS readCoverageRemapped hit 分支）。
    cov_cache: HashMap<usize, CovEntry>,
}

impl<'a> SubCtx<'a> {
    /// 重映射单个原 gid：不在子集（或越界）返回 None
    fn remap(&self, gid: u32) -> Option<u16> {
        let g = gid as usize;
        if g >= self.gid_lookup.len() {
            return None;
        }
        let m = self.gid_lookup[g];
        if m < 0 {
            return None;
        }
        Some(m as u16)
    }
}

// ===== Coverage 解析（gsub-subset.ts / gsub-reachable.ts 共用语义）=====

/// 读取 Coverage 表的原始 gid 列表（对应 TS readCoverageGids，无缓存）。
/// format2 带 COVERAGE_MAX_EXPAND 保护（损坏 range 停止展开，返回已收集部分）。
fn read_coverage_gids(r: &Reader, off: usize) -> Vec<u16> {
    let mut gids: Vec<u16> = Vec::new();
    if off + 4 > r.data.len() {
        return gids;
    }
    let format = r.raw16(off);
    if format == 1 {
        let count = r.raw16(off + 2) as usize;
        let base = off + 4;
        if base + count * 2 > r.data.len() {
            return gids;
        }
        for i in 0..count {
            gids.push(r.raw16(base + i * 2));
        }
    } else if format == 2 {
        let range_count = r.raw16(off + 2) as usize;
        let mut p = off + 4;
        for _ in 0..range_count {
            if p + 6 > r.data.len() {
                break;
            }
            let start = r.raw16(p);
            let end = r.raw16(p + 2);
            if end >= start
                && ((end - start) as usize) < COVERAGE_MAX_EXPAND
                && gids.len() + ((end - start + 1) as usize) <= COVERAGE_MAX_EXPAND
            {
                let mut g = start;
                loop {
                    gids.push(g);
                    if g == end {
                        break;
                    }
                    g += 1;
                }
            }
            p += 6;
        }
    }
    gids
}

/// coverage 中第一个不在集合内的 gid；全在集合内（或 format 未知）返回 None
fn coverage_first_excluded_gid(r: &Reader, off: usize, in_set: &OrderedGidSet) -> Option<u16> {
    if off + 4 > r.data.len() {
        return None;
    }
    let format = r.raw16(off);
    if format == 1 {
        let count = r.raw16(off + 2) as usize;
        let base = off + 4;
        for i in 0..count {
            let g = r.raw16(base + i * 2);
            if !in_set.contains(g) {
                return Some(g);
            }
        }
        None
    } else if format == 2 {
        let range_count = r.raw16(off + 2) as usize;
        let mut p = off + 4;
        for _ in 0..range_count {
            let start = r.raw16(p);
            let end = r.raw16(p + 2);
            let mut g = start;
            loop {
                if !in_set.contains(g) {
                    return Some(g);
                }
                if g == end {
                    break;
                }
                // wrapping_add：损坏 coverage（start>end）时对齐 Zig ReleaseFast 环绕语义不 panic
                g = g.wrapping_add(1);
            }
            p += 6;
        }
        None
    } else {
        None
    }
}

/// coverage 中二分查找 gid 的序号（0-based）；不在返回 -1（对应 TS coverageIndexOf）
fn coverage_index_of(r: &Reader, off: usize, gid: u16) -> i64 {
    if off + 4 > r.data.len() {
        return -1;
    }
    let format = r.raw16(off);
    if format == 1 {
        let count = r.raw16(off + 2) as usize;
        let base = off + 4;
        let mut lo: usize = 0;
        let mut hi: usize = count;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            let mg = r.raw16(base + mid * 2);
            if mg < gid {
                lo = mid + 1;
            } else if mg > gid {
                hi = mid;
            } else {
                return mid as i64;
            }
        }
        -1
    } else if format == 2 {
        let range_count = r.raw16(off + 2) as usize;
        let base = off + 4;
        // 二分找第一个 end >= gid 的 range（range 按 start 升序，end 亦升序）
        let mut lo: usize = 0;
        let mut hi: usize = range_count;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            let end = r.raw16(base + mid * 6 + 2);
            if end < gid {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo >= range_count {
            return -1;
        }
        let range_off = base + lo * 6;
        let start = r.raw16(range_off);
        let end = r.raw16(range_off + 2);
        if gid < start || gid > end {
            return -1;
        }
        let mut prefix: u32 = 0;
        for i in 0..lo {
            let s = r.raw16(base + i * 6);
            let e = r.raw16(base + i * 6 + 2);
            prefix += u32::from(e) - u32::from(s) + 1;
        }
        (prefix + (gid - start) as u32) as i64
    } else {
        -1
    }
}

/// coverage 的 gid 总数，不展开数组（对应 TS coverageCount）
fn coverage_count(r: &Reader, off: usize) -> usize {
    if off + 4 > r.data.len() {
        return 0;
    }
    let format = r.raw16(off);
    if format == 1 {
        return r.raw16(off + 2) as usize;
    }
    if format == 2 {
        let range_count = r.raw16(off + 2) as usize;
        let base = off + 4;
        let mut total: usize = 0;
        for i in 0..range_count {
            let s = r.raw16(base + i * 6);
            let e = r.raw16(base + i * 6 + 2);
            if e >= s {
                total += e as usize - s as usize + 1;
            }
        }
        return total;
    }
    0
}

/// 判定 coverage 是否「原非空且全部 gid 落子集外」（对应 TS coverageAllOutOfSubset）
fn coverage_all_out_of_subset(ctx: &SubCtx, cov_off: usize) -> bool {
    let r = ctx.r;
    if cov_off + 4 > r.data.len() {
        return false;
    }
    let format = r.raw16(cov_off);
    if format == 1 {
        let count = r.raw16(cov_off + 2) as usize;
        if count == 0 {
            return false; // 原 coverage 本就空
        }
        let base = cov_off + 4;
        if base + count * 2 > r.data.len() {
            return false;
        }
        for i in 0..count {
            if ctx.remap(u32::from(r.raw16(base + i * 2))).is_some() {
                return false;
            }
        }
        return true;
    }
    if format == 2 {
        let range_count = r.raw16(cov_off + 2) as usize;
        let sorted = &ctx.sorted_subset;
        let sn = sorted.len();
        let mut p = cov_off + 4;
        let mut orig_non_empty = false;
        for _ in 0..range_count {
            if p + 6 > r.data.len() {
                break;
            }
            let start = r.raw16(p);
            let end = r.raw16(p + 2);
            if end >= start && ((end - start) as usize) < COVERAGE_MAX_EXPAND {
                orig_non_empty = true;
                // 二分判定 range 是否含任一子集 gid
                if sn > 0 && start <= sorted[sn - 1] && end >= sorted[0] {
                    let mut lo: usize = 0;
                    let mut hi: usize = sn;
                    while lo < hi {
                        let mid = (lo + hi) >> 1;
                        if sorted[mid] < start {
                            lo = mid + 1;
                        } else {
                            hi = mid;
                        }
                    }
                    if lo < sn && sorted[lo] <= end {
                        return false;
                    }
                }
            }
            p += 6;
        }
        return orig_non_empty;
    }
    false
}

/// 读取 coverage 原始 gid 并写入缓存（对应 TS readCoverageGids 带 covCache 的调用方，
/// subset 侧仅 chain fmt1 使用）。命中 gids 条目直接返回；否则现场解析后合并进缓存
/// （保留可能已存在的 remapped/out_of_subset 字段，TS mergeGidsEntry 语义）。
/// Rust 侧返回拷贝（Zig 返回存于缓存的切片，调用方不得释放——拷贝不改变语义）。
fn cov_gids_cached(ctx: &mut SubCtx, off: usize) -> Vec<u16> {
    if let Some(entry) = ctx.cov_cache.get(&off) {
        if let Some(g) = &entry.gids {
            return g.clone();
        }
    }
    let gids = read_coverage_gids(ctx.r, off);
    if let Some(entry) = ctx.cov_cache.get_mut(&off) {
        // 已有 remapped 条目：保留 remapped/out_of_subset，仅回填 gids
        entry.gids = Some(gids.clone());
    } else {
        ctx.cov_cache.insert(off, CovEntry { gids: Some(gids.clone()), ..Default::default() });
    }
    gids
}

/// 读取 coverage 并返回重映射后的新 gid 列表；原非空但全子集外返回 None
/// （对应 TS readCoverageRemapped 带缓存版：首算升序排序并缓存；
/// 命中「gids 先填」条目时按原序现场重映射、不排序——字节级对拍依赖该差异）
fn read_coverage_remapped(ctx: &mut SubCtx, off: usize) -> Option<Vec<u16>> {
    if let Some(entry) = ctx.cov_cache.get(&off) {
        if let Some(ogids) = entry.gids.clone() {
            // TS 命中分支：从已缓存的原始 gids 现场重映射，保持原序、不排序
            let mut m: Vec<u16> = Vec::with_capacity(ogids.len());
            for &g in &ogids {
                if let Some(ng) = ctx.remap(u32::from(g)) {
                    m.push(ng);
                }
            }
            let oos = m.is_empty() && !ogids.is_empty();
            let e = ctx.cov_cache.get_mut(&off).expect("entry just checked");
            e.remapped = Some(m.clone());
            e.out_of_subset = oos;
            return if oos { None } else { Some(m) };
        }
        return if entry.out_of_subset { None } else { entry.remapped.clone() };
    }
    let r = ctx.r;
    let mut new_gids: Vec<u16> = Vec::new();
    let mut orig_non_empty = false;
    if off + 4 > r.data.len() {
        // 越界，按空 coverage 处理（TS 语义：newGids 空、origNonEmpty=false → 返回空数组）
    } else {
        let format = r.raw16(off);
        if format == 1 {
            let count = r.raw16(off + 2) as usize;
            let base = off + 4;
            if base + count * 2 > r.data.len() {
                // 数据越界：不进循环，origNonEmpty 保持 false
            } else if count > ctx.gid_lookup.len() {
                // 损坏 coverage（count 超过 glyph 总数）：跳过必然全空的循环，
                // 仅保留 origNonEmpty=count>0 语义 → 全空 → outOfSubset → None
                orig_non_empty = count > 0;
            } else {
                orig_non_empty = count > 0;
                for i in 0..count {
                    if let Some(ng) = ctx.remap(u32::from(r.raw16(base + i * 2))) {
                        new_gids.push(ng);
                    }
                }
            }
        } else if format == 2 {
            let range_count = r.raw16(off + 2) as usize;
            let num_glyphs = ctx.gid_lookup.len();
            let sorted = &ctx.sorted_subset;
            let sn = sorted.len();
            let mut p = off + 4;
            for _ in 0..range_count {
                if p + 6 > r.data.len() {
                    break;
                }
                let start = r.raw16(p);
                let end = r.raw16(p + 2);
                if end >= start
                    && ((end - start) as usize) < COVERAGE_MAX_EXPAND
                    && new_gids.len() + ((end - start + 1) as usize) <= COVERAGE_MAX_EXPAND
                {
                    if (start as usize) >= num_glyphs {
                        orig_non_empty = true;
                    } else if sn > 0 {
                        // @intCast(num_glyphs-1)：num_glyphs = gid_lookup.len ≥ 1（subsetGSUB 恒非空表）
                        let e: u16 = if (end as usize) < num_glyphs { end } else { (num_glyphs - 1) as u16 };
                        orig_non_empty = true;
                        if !(e < sorted[0] || start > sorted[sn - 1]) {
                            // 二分定位第一个 >= start 的子集 gid，顺序扫描到 > e 为止
                            let mut lo: usize = 0;
                            let mut hi: usize = sn;
                            while lo < hi {
                                let mid = (lo + hi) >> 1;
                                if sorted[mid] < start {
                                    lo = mid + 1;
                                } else {
                                    hi = mid;
                                }
                            }
                            let mut j = lo;
                            while j < sn {
                                let g = sorted[j];
                                if g > e {
                                    break;
                                }
                                // @intCast(i32→u16)：sorted 中的 gid 必在子集内，映射值 ≥ 0
                                new_gids.push(ctx.gid_lookup[g as usize] as u16);
                                j += 1;
                            }
                        }
                    } else {
                        orig_non_empty = true;
                    }
                }
                p += 6;
            }
        }
    }
    if new_gids.is_empty() && orig_non_empty {
        return None;
    }
    // 缓存入口统一升序排序（原 coverage 升序但 原 gid→新 gid 映射不保序；emitCoverage 假定升序输入）
    if new_gids.len() > 1 {
        new_gids.sort_unstable();
    }
    ctx.cov_cache
        .insert(off, CovEntry { remapped: Some(new_gids.clone()), ..Default::default() });
    Some(new_gids)
}

// ===== GSUB lookup 结构解析（reachable 与 subset 共用）=====

/// 解析后的单个 lookup（effectiveType 已解包 Extension）
struct Lookup {
    effective_type: i32,
    sub_offs: Vec<usize>,
    /// 原始 lookup 表头绝对偏移（subsetGSUB 读 lookupFlag / markFilteringSet 用；可达侧不用）
    orig_off: usize,
}

/// 解析 LookupList：每 lookup 的 effectiveType 与 subtable 绝对偏移。
/// Extension(type7) 解引用：内嵌 type/subtableOffset 指向内嵌 subtable。
fn parse_lookups(r: &Reader, lookup_list_off: usize) -> Vec<Lookup> {
    let lookup_count = r.rd16(lookup_list_off) as usize;
    let mut lookups: Vec<Lookup> = Vec::new();
    for i in 0..lookup_count {
        let l_off = lookup_list_off + r.raw16(lookup_list_off + 2 + i * 2) as usize;
        let lookup_type = r.raw16(l_off) as usize;
        let sub_table_count = r.raw16(l_off + 4) as usize;
        let mut sub_offs: Vec<usize> = Vec::new();
        let mut effective_type: i32 = lookup_type as i32;
        for j in 0..sub_table_count {
            let sub_off = l_off + r.raw16(l_off + 6 + j * 2) as usize;
            if lookup_type == 7 {
                // ExtensionSubst format1：ExtensionFormat(=1) + ExtensionLookupType + ExtensionOffset(u32)
                if r.raw16(sub_off) != 1 {
                    effective_type = -1;
                    continue;
                }
                effective_type = i32::from(r.raw16(sub_off + 2));
                sub_offs.push(sub_off + r.rd32(sub_off + 4) as usize);
            } else {
                sub_offs.push(sub_off);
            }
        }
        lookups.push(Lookup { effective_type, sub_offs, orig_off: l_off });
    }
    lookups
}

// ===== 可达收集（gsub-reachable.ts）=====

/// 从 seed gids 出发、经 GSUB 替换链可达的全部 gid（含 seed；固定点迭代）。
/// 返回「插入序」数组（TS Set 迭代序语义，决定 TS subsetGids 追加顺序/新 gid 编号）。
/// 版本不支持时返回空 Vec（≠ 错误，调用方退 seed 序）。
pub fn collect_reachable(gsub_bytes: &[u8], seed_gids: &[u16]) -> Result<Vec<u16>, GsubError> {
    let r = Reader::new(gsub_bytes);
    let major = r.rd16(0);
    let minor = r.rd16(2);
    if major != 1 || minor > 1 {
        return Ok(Vec::new());
    }
    let lookup_list_off = r.rd16(8) as usize;
    let lookups = parse_lookups(&r, lookup_list_off);

    let mut reachable = OrderedGidSet::default();
    for &g in seed_gids {
        reachable.add(g);
    }

    // 固定点迭代（与 TS 循环结构逐句对应；TS 的 settledChain/failGidMap 记忆层不影响
    // 结果集合与插入顺序，故省略——失败状态下扫描该 subtable 不产任何 target/ctxGid）
    let mut ctx_gids = OrderedGidSet::default();
    let mut refs = OrderedGidSet::default();
    let mut changed = true;
    while changed {
        changed = false;
        for lk in &lookups {
            for &sub_abs in &lk.sub_offs {
                if lk.effective_type == 6 {
                    // type6 ChainedContext：收集可触发规则引用的 lookup index 与所需 context gid
                    ctx_gids.clear();
                    refs.clear();
                    collect_chain_refs(&r, sub_abs, &mut refs, &mut ctx_gids, &reachable);
                    for &g in &ctx_gids.items {
                        if reachable.add(g) {
                            changed = true;
                        }
                    }
                    for &li in &refs.items {
                        let li = li as usize;
                        if li >= lookups.len() {
                            continue;
                        }
                        let ref_lk = &lookups[li];
                        for &ref_sub in &ref_lk.sub_offs {
                            let ref_targets =
                                collect_subtable_targets(&r, ref_sub, ref_lk.effective_type, &reachable);
                            for g in ref_targets {
                                if reachable.add(g) {
                                    changed = true;
                                }
                            }
                        }
                    }
                } else {
                    let new_targets = collect_subtable_targets(&r, sub_abs, lk.effective_type, &reachable);
                    for g in new_targets {
                        if reachable.add(g) {
                            changed = true;
                        }
                    }
                }
            }
        }
        if r.error_flag.get() {
            break;
        }
    }
    Ok(reachable.items)
}

/// 从单个 subtable 收集 target gid（type1/2/3/4）；type6 不直接产生 target（经 chainRefs 间接）
fn collect_subtable_targets(r: &Reader, off: usize, lookup_type: i32, reachable: &OrderedGidSet) -> Vec<u16> {
    let mut targets: Vec<u16> = Vec::new();
    if lookup_type == 1 {
        // SingleSubst: format1 coverage+delta / format2 coverage+gidArray
        let format = r.rd16(off);
        let cov_off = off + r.rd16(off + 2) as usize;
        if format == 1 {
            let delta = r.rd16s(off + 4);
            if coverage_count(r, cov_off) > reachable.count() {
                // 反转路径（大 coverage）：遍历 reachable 二分 coverage（决定插入序，必须保留）
                for &g in &reachable.items {
                    if coverage_index_of(r, cov_off, g) >= 0 {
                        targets.push(g.wrapping_add(delta as u16));
                    }
                }
            } else {
                let cov_gids = read_coverage_gids(r, cov_off);
                for g in cov_gids {
                    if reachable.contains(g) {
                        targets.push(g.wrapping_add(delta as u16));
                    }
                }
            }
        } else if format == 2 {
            let count = r.rd16(off + 4) as usize;
            if coverage_count(r, cov_off) > reachable.count() {
                for &g in &reachable.items {
                    let idx = coverage_index_of(r, cov_off, g);
                    if idx >= 0 && (idx as usize) < count {
                        targets.push(r.raw16(off + 6 + idx as usize * 2));
                    }
                }
            } else {
                let cov_gids = read_coverage_gids(r, cov_off);
                let lim = cov_gids.len().min(count);
                for i in 0..lim {
                    if reachable.contains(cov_gids[i]) {
                        targets.push(r.raw16(off + 6 + i * 2));
                    }
                }
            }
        }
    } else if lookup_type == 2 {
        // MultipleSubst: coverage gid → 多个 target
        let cov_off = off + r.rd16(off + 2) as usize;
        let seq_count = r.rd16(off + 4) as usize;
        let cov_gids = read_coverage_gids(r, cov_off);
        let lim = cov_gids.len().min(seq_count);
        for i in 0..lim {
            if !reachable.contains(cov_gids[i]) {
                continue;
            }
            let seq_off = off + r.raw16(off + 6 + i * 2) as usize;
            let glyph_count = r.raw16(seq_off) as usize;
            for k in 0..glyph_count {
                targets.push(r.raw16(seq_off + 2 + k * 2));
            }
        }
    } else if lookup_type == 3 {
        // AlternateSubst: coverage gid → 多个候选 target（全部保留）
        let cov_off = off + r.rd16(off + 2) as usize;
        let alt_count = r.rd16(off + 4) as usize;
        let cov_gids = read_coverage_gids(r, cov_off);
        let lim = cov_gids.len().min(alt_count);
        if cov_gids.len() > reachable.count() {
            // 反转路径：遍历 reachable，对 covGids[0..lim] 二分
            for &g in &reachable.items {
                let mut lo: usize = 0;
                let mut hi: usize = lim;
                while lo < hi {
                    let mid = (lo + hi) >> 1;
                    let mg = cov_gids[mid];
                    if mg < g {
                        lo = mid + 1;
                    } else if mg > g {
                        hi = mid;
                    } else {
                        let alt_off = off + r.raw16(off + 6 + mid * 2) as usize;
                        let cnt = r.raw16(alt_off) as usize;
                        for k in 0..cnt {
                            targets.push(r.raw16(alt_off + 2 + k * 2));
                        }
                        break;
                    }
                }
            }
        } else {
            for i in 0..lim {
                if !reachable.contains(cov_gids[i]) {
                    continue;
                }
                let alt_off = off + r.raw16(off + 6 + i * 2) as usize;
                let cnt = r.raw16(alt_off) as usize;
                for k in 0..cnt {
                    targets.push(r.raw16(alt_off + 2 + k * 2));
                }
            }
        }
    } else if lookup_type == 4 {
        // LigatureSubst: 全部 component 在子集 → target gid
        let cov_off = off + r.rd16(off + 2) as usize;
        let set_count = r.rd16(off + 4) as usize;
        let cov_gids = read_coverage_gids(r, cov_off);
        let lim = cov_gids.len().min(set_count);
        for i in 0..lim {
            // 第一分量（coverage gid）不在子集时整条 ligature 不触发，跳过整个 LigatureSet
            if !reachable.contains(cov_gids[i]) {
                continue;
            }
            let set_off = off + r.raw16(off + 6 + i * 2) as usize;
            let lig_count = r.raw16(set_off) as usize;
            for j in 0..lig_count {
                let lig_off = set_off + r.raw16(set_off + 2 + j * 2) as usize;
                let comp_count = r.raw16(lig_off) as usize;
                let target = r.raw16(lig_off + 2);
                let mut all_in = true;
                let mut k: usize = 0;
                while k + 1 < comp_count {
                    if !reachable.contains(r.raw16(lig_off + 4 + k * 2)) {
                        all_in = false;
                        break;
                    }
                    k += 1;
                }
                if all_in {
                    targets.push(target);
                }
            }
        }
    }
    // type5 ReverseChain / type6 ChainedContext 不直接产生 target
    targets
}

/// 收集 type6 ChainedContext subtable 中「可触发规则」引用的 lookup index 与所需 context gid
/// （对应 TS collectChainRefs；stable 返回值仅 TS 跨轮记忆用，此处省略）
fn collect_chain_refs(
    r: &Reader,
    off: usize,
    refs: &mut OrderedGidSet,
    context_gids: &mut OrderedGidSet,
    reachable: &OrderedGidSet,
) {
    let format = r.rd16(off);
    if format == 1 {
        // format1: coverage(gid) + SubRuleSet 数组，按 coverage gid 索引
        let cov_off = off + r.rd16(off + 2) as usize;
        let cov_gids = read_coverage_gids(r, cov_off);
        let set_count = r.rd16(off + 4) as usize;
        let lim = cov_gids.len().min(set_count);
        for i in 0..lim {
            // 第一分量（coverage gid）须在子集，否则该 SubRuleSet 不触发
            if !reachable.contains(cov_gids[i]) {
                continue;
            }
            context_gids.add(cov_gids[i]);
            let set_off_rel = r.raw16(off + 6 + i * 2) as usize;
            if set_off_rel == 0 {
                continue;
            }
            let set_off = off + set_off_rel;
            let rule_count = r.raw16(set_off) as usize;
            for j in 0..rule_count {
                let rule_off = set_off + r.raw16(set_off + 2 + j * 2) as usize;
                collect_chain_rule_refs(r, rule_off, refs, context_gids, reachable, true);
            }
        }
    } else if format == 2 {
        // format2: 三个 ClassDef + 按 input 第一分量 class 索引的 SubClassSet。
        // class index 不是 gid，无法 inSubset 判断，保守收集全部被引用 lookup 与 ClassDef gid。
        let class_set_count = r.rd16(off + 10) as usize;
        for i in 0..class_set_count {
            let set_off_rel = r.raw16(off + 12 + i * 2) as usize;
            if set_off_rel == 0 {
                continue;
            }
            let set_off = off + set_off_rel;
            let rule_count = r.raw16(set_off) as usize;
            for j in 0..rule_count {
                let rule_off = set_off + r.raw16(set_off + 2 + j * 2) as usize;
                collect_chain_rule_refs(r, rule_off, refs, context_gids, reachable, false);
            }
        }
    } else if format == 3 {
        // format3: 显式 coverage 数组（backtrack/input/lookahead）+ SubstLookupRecords。
        // 第一遍：逐 coverage 找首个不在子集的 gid，全在子集才可触发。
        let mut p = off + 2;
        let mut triggerable = true;
        let mut seg: usize = 0;
        while seg < 3 && triggerable {
            let cnt = r.rd16(p) as usize;
            p += 2;
            for k in 0..cnt {
                let cov_off = off + r.raw16(p + k * 2) as usize;
                if coverage_first_excluded_gid(r, cov_off, reachable).is_some() {
                    triggerable = false;
                    break;
                }
            }
            p += cnt * 2;
            seg += 1;
        }
        if triggerable {
            // 第二遍：三段 coverage 全部 gid 收进 contextGids + 收集 refs
            let mut p2 = off + 2;
            let mut seg2: usize = 0;
            while seg2 < 3 {
                let cnt = r.rd16(p2) as usize;
                p2 += 2;
                for k in 0..cnt {
                    let cov_gids = read_coverage_gids(r, off + r.raw16(p2 + k * 2) as usize);
                    for g in cov_gids {
                        context_gids.add(g);
                    }
                }
                p2 += cnt * 2;
                seg2 += 1;
            }
            let subst_count = r.rd16(p2) as usize;
            for k in 0..subst_count {
                refs.add(r.raw16(p2 + 2 + k * 4 + 2));
            }
        }
    }
}

/// 从一条 ChainSubstRule 收集引用的 lookup index 与 context gid。
/// is_gid_format=true（format1）：元素为 gid，全部在子集才收集（校验失败直接返回）；
/// false（format2）：元素为 class index，原样收集 refs（不判断 gid）。
fn collect_chain_rule_refs(
    r: &Reader,
    rule_off: usize,
    refs: &mut OrderedGidSet,
    context_gids: &mut OrderedGidSet,
    reachable: &OrderedGidSet,
    is_gid_format: bool,
) {
    // format1/2 rule: backtrackCount + backtrack[] + inputCount + input[] + lookaheadCount + lookahead[] + substCount + substRecords[]
    let backtrack_count = r.rd16(rule_off) as usize;
    let backtrack_end = rule_off + 2 + backtrack_count * 2;
    let input_count = r.rd16(backtrack_end) as usize;
    let input_len = if input_count > 0 { input_count - 1 } else { 0 };
    let input_end = backtrack_end + 2 + input_len * 2;
    let lookahead_count = r.rd16(input_end) as usize;
    let lookahead_end = input_end + 2 + lookahead_count * 2;
    let subst_count = r.rd16(lookahead_end) as usize;

    if is_gid_format {
        // 第一遍：校验 backtrack + input + lookahead 全部 gid 在子集（遇子集外即放弃规则）
        let mut q = rule_off + 2;
        for k in 0..backtrack_count {
            if !reachable.contains(r.raw16(q + k * 2)) {
                return;
            }
        }
        q += backtrack_count * 2 + 2;
        for k in 0..input_len {
            if !reachable.contains(r.raw16(q + k * 2)) {
                return;
            }
        }
        q += input_len * 2 + 2;
        for k in 0..lookahead_count {
            if !reachable.contains(r.raw16(q + k * 2)) {
                return;
            }
        }
        // 第二遍：全部在子集，收集 context gid
        q = rule_off + 2;
        for k in 0..backtrack_count {
            context_gids.add(r.raw16(q + k * 2));
        }
        q += backtrack_count * 2 + 2;
        for k in 0..input_len {
            context_gids.add(r.raw16(q + k * 2));
        }
        q += input_len * 2 + 2;
        for k in 0..lookahead_count {
            context_gids.add(r.raw16(q + k * 2));
        }
    }
    for k in 0..subst_count {
        // SubstLookupRecord: sequenceIndex(2) + lookupListIndex(2)
        refs.add(r.raw16(lookahead_end + 2 + k * 4 + 2));
    }
}

// ===== GSUB 表子集化（gsub-subset.ts）=====

/// 单条 ChainSubRule（重映射后）
struct ChainRule {
    back: Vec<u16>,
    input: Vec<u16>,
    look: Vec<u16>,
    records: Vec<Rec>,
}

/// SubstLookupRecord：sequenceIndex + lookupListIndex
#[derive(Clone, Copy)]
struct Rec {
    seq: u16,
    lookup_idx: u16,
}

struct SingleEntry {
    from: u16,
    to: u16,
}

struct SeqEntry {
    from: u16,
    seq: Vec<u16>,
}

struct Lig {
    comp: Vec<u16>,
    lig: u16,
}

struct LigEntry {
    from: u16,
    ligs: Vec<Lig>,
}

struct ChainEntry {
    first_gid: u16,
    rules: Vec<ChainRule>,
}

/// 从一组（子集内的）新 gid 序列写出 Coverage 表（假定升序无重复），返回起始偏移。
/// format 判据与 TS 一致：rangeCount*6 < n*2 选 format2，否则 format1。
fn emit_coverage(w: &mut Writer, new_gids: &[u16]) -> usize {
    let off = w.len();
    let n = new_gids.len();
    let mut range_starts: Vec<u16> = Vec::new();
    let mut range_ends: Vec<u16> = Vec::new();
    let mut i: usize = 0;
    while i < n {
        let start = new_gids[i];
        let mut j = i;
        while j + 1 < n && new_gids[j + 1] == new_gids[j].wrapping_add(1) {
            j += 1;
        }
        range_starts.push(start);
        range_ends.push(new_gids[j]);
        i = j + 1;
    }
    let range_count = range_starts.len();
    if range_count > 0 && range_count * 6 < n * 2 {
        w.w16(2);
        w.w16(range_count as u16);
        let mut cov_index: u16 = 0;
        for (&rs, &re) in range_starts.iter().zip(range_ends.iter()) {
            w.w16(rs);
            w.w16(re);
            w.w16(cov_index);
            cov_index = cov_index.wrapping_add(re.wrapping_sub(rs).wrapping_add(1));
        }
    } else {
        w.w16(1);
        w.w16(n as u16);
        for &g in new_gids {
            w.w16(g);
        }
    }
    off
}

/// 写出合法「空 subtable」用于降级（format：SingleSubst 用 2，其余用 1；coverageOffset 恒 6）
fn write_empty_subtable(w: &mut Writer, effective_type: i32) {
    let format: u16 = if effective_type == 1 { 2 } else { 1 };
    w.w16(format);
    w.w16(6);
    w.w16(0);
    w.w16(1); // 空 coverage：format1 + count0
    w.w16(0);
}

/// 读取 ClassDef 表为 (新 gid → classIndex) map，class index 原样保留（对应 TS readClassDefMap）
fn read_class_def_map(ctx: &SubCtx, off: usize) -> HashMap<u16, u16> {
    let mut result: HashMap<u16, u16> = HashMap::new();
    if off == 0 {
        return result;
    }
    let r = ctx.r;
    let format = r.rd16(off);
    if format == 1 {
        let start_gid = u32::from(r.rd16(off + 2));
        let count = r.rd16(off + 4) as usize;
        for i in 0..count {
            let orig_gid = start_gid + i as u32;
            if let Some(new_gid) = ctx.remap(orig_gid) {
                result.insert(new_gid, r.raw16(off + 6 + i * 2));
            }
        }
    } else if format == 2 {
        let range_count = r.rd16(off + 2) as usize;
        let sorted = &ctx.sorted_subset;
        let sn = sorted.len();
        if sn == 0 {
            return result;
        }
        let ranges_base = off + 4;
        let min_subset = sorted[0];
        let max_subset = sorted[sn - 1];
        for i in 0..range_count {
            let p = ranges_base + i * 6;
            let start = r.raw16(p);
            let end = r.raw16(p + 2);
            if end < min_subset || start > max_subset {
                continue;
            }
            let cls = r.raw16(p + 4);
            // 二分定位第一个 >= start 的子集 gid，顺序遍历到 > end 为止
            let mut lo: usize = 0;
            let mut hi: usize = sn;
            while lo < hi {
                let mid = (lo + hi) >> 1;
                if sorted[mid] < start {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            let mut j = lo;
            while j < sn {
                let g = sorted[j];
                if g > end {
                    break;
                }
                // @intCast(i32→u16)：sorted 中的 gid 必在子集内，映射值 ≥ 0
                result.insert(ctx.gid_lookup[g as usize] as u16, cls);
                j += 1;
            }
        }
    }
    result
}

/// 从 (新 gid → class) map 写出 ClassDef（format2 区间），返回起始偏移
fn write_class_def_from_map(w: &mut Writer, map: &HashMap<u16, u16>) -> usize {
    let off = w.len();
    if map.is_empty() {
        w.w16(2);
        w.w16(0);
        return off;
    }
    // map 迭代序不影响输出：entries 随后按 gid 升序排序（key 单射，排序全序确定）
    let mut entries: Vec<(u16, u16)> = map.iter().map(|(&gid, &cls)| (gid, cls)).collect();
    entries.sort_unstable_by_key(|e| e.0);
    // 连续同 class 折叠为 range
    let mut ranges: Vec<(u16, u16, u16)> = Vec::new(); // (start, end, cls)
    let mut i: usize = 0;
    while i < entries.len() {
        let cls = entries[i].1;
        let mut j = i;
        while j + 1 < entries.len()
            && entries[j + 1].0 == entries[j].0.wrapping_add(1)
            && entries[j + 1].1 == cls
        {
            j += 1;
        }
        ranges.push((entries[i].0, entries[j].0, cls));
        i = j + 1;
    }
    w.w16(2);
    w.w16(ranges.len() as u16);
    for rg in &ranges {
        w.w16(rg.0);
        w.w16(rg.1);
        w.w16(rg.2);
    }
    off
}

/// 廉价预检：subtable 是否可跳过深度序列化（输出空 subtable）。
/// format2 class 驱动不预检（主 coverage 全空不代表无效）。
fn is_subtable_skipable_by_coverage(ctx: &SubCtx, off: usize, lookup_type: i32) -> bool {
    let r = ctx.r;
    let data_len = r.data.len();
    if lookup_type == 6 {
        if off + 2 > data_len {
            return false;
        }
        let chain_fmt = r.raw16(off);
        if chain_fmt == 2 {
            return false;
        }
        if chain_fmt == 3 {
            let mut p = off + 2;
            for _grp in 0..3 {
                if p + 2 > data_len {
                    return false;
                }
                let cnt = r.raw16(p) as usize;
                p += 2;
                for k in 0..cnt {
                    if p + 2 > data_len {
                        return false;
                    }
                    let cov_off = off + r.raw16(p + k * 2) as usize;
                    if coverage_all_out_of_subset(ctx, cov_off) {
                        return true;
                    }
                }
                p += cnt * 2;
            }
            return false;
        }
    }
    if off + 4 > data_len {
        return false;
    }
    let cov_off = off + r.raw16(off + 2) as usize;
    coverage_all_out_of_subset(ctx, cov_off)
}

/// 单个 subtable 序列化分发。返回 false 表示该 subtable 无法重映射（调用方降级空 subtable）
fn serialize_subtable(w: &mut Writer, ctx: &mut SubCtx, off: usize, lookup_type: i32, skipable: bool) -> bool {
    let r = ctx.r;
    if skipable {
        return false;
    }
    r.clear_error();
    let ok: bool = match lookup_type {
        1 => serialize_single_subst(w, ctx, off),
        2 => serialize_multiple_subst(w, ctx, off),
        3 => serialize_alternate_subst(w, ctx, off),
        4 => serialize_ligature_subst(w, ctx, off),
        6 => serialize_chained_context_subst(w, ctx, off),
        _ => false,
    };
    if r.error_flag.get() {
        return false;
    }
    ok
}

/// SingleSubst（type1）：format1 delta / format2 数组；统一 delta 时用 format1，否则 format2
fn serialize_single_subst(w: &mut Writer, ctx: &mut SubCtx, off: usize) -> bool {
    let r = ctx.r;
    let format = r.rd16(off);
    let cov_off = off + r.rd16(off + 2) as usize;
    let mut entries: Vec<SingleEntry> = Vec::new();
    if format == 1 {
        let delta = r.rd16s(off + 4);
        let cov_gids = read_coverage_gids(r, cov_off);
        for g in cov_gids {
            let from_new = ctx.remap(u32::from(g));
            let to_new = ctx.remap(u32::from(g.wrapping_add(delta as u16)));
            if let (Some(from), Some(to)) = (from_new, to_new) {
                entries.push(SingleEntry { from, to });
            }
        }
    } else if format == 2 {
        let count = r.rd16(off + 4) as usize;
        let cov_gids = read_coverage_gids(r, cov_off);
        let lim = cov_gids.len().min(count);
        for i in 0..lim {
            let from_new = ctx.remap(u32::from(cov_gids[i]));
            let to_new = ctx.remap(u32::from(r.raw16(off + 6 + i * 2)));
            if let (Some(from), Some(to)) = (from_new, to_new) {
                entries.push(SingleEntry { from, to });
            }
        }
    } else {
        return false;
    }
    if entries.is_empty() {
        return false;
    }
    // 按 from 升序排序：coverage（emitCoverage 强制升序）与 target 数组按下标配对
    entries.sort_unstable_by_key(|e| e.from);

    let first_delta = entries[0].to.wrapping_sub(entries[0].from);
    let uniform = entries.iter().all(|e| e.to.wrapping_sub(e.from) == first_delta);

    let sub_start = w.len();
    let cov_slot = sub_start + 2;
    let froms: Vec<u16> = entries.iter().map(|e| e.from).collect();
    if uniform {
        w.w16(1);
        w.w16(0); // coverage 偏移槽占位
        w.w16(first_delta);
    } else {
        w.w16(2);
        w.w16(0);
        w.w16(entries.len() as u16);
        for e in &entries {
            w.w16(e.to);
        }
    }
    let cov_pos = emit_coverage(w, &froms);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);
    true
}

/// MultipleSubst（type2）：coverage + sequence 数组（每项 = gid 数组）
fn serialize_multiple_subst(w: &mut Writer, ctx: &mut SubCtx, off: usize) -> bool {
    let r = ctx.r;
    let cov_off = off + r.rd16(off + 2) as usize;
    let seq_count = r.rd16(off + 4) as usize;
    let mut entries: Vec<SeqEntry> = Vec::new();
    let cov_gids = read_coverage_gids(r, cov_off);
    let lim = cov_gids.len().min(seq_count);
    for i in 0..lim {
        let Some(from_new) = ctx.remap(u32::from(cov_gids[i])) else {
            continue;
        };
        let seq_off = off + r.raw16(off + 6 + i * 2) as usize;
        let glyph_count = r.raw16(seq_off) as usize;
        let mut new_seq: Vec<u16> = Vec::new();
        for k in 0..glyph_count {
            if let Some(g) = ctx.remap(u32::from(r.raw16(seq_off + 2 + k * 2))) {
                new_seq.push(g);
            }
        }
        if !new_seq.is_empty() {
            entries.push(SeqEntry { from: from_new, seq: new_seq });
        }
    }
    if entries.is_empty() {
        return false;
    }
    entries.sort_unstable_by_key(|e| e.from);

    let sub_start = w.len();
    let cov_slot = sub_start + 2;
    let seq_slots = sub_start + 6;
    let froms: Vec<u16> = entries.iter().map(|e| e.from).collect();
    w.w16(1);
    w.w16(0); // coverage 偏移槽
    w.w16(entries.len() as u16);
    for _ in 0..entries.len() {
        w.w16(0); // sequence 偏移槽
    }
    let cov_pos = emit_coverage(w, &froms);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);
    for (ei, e) in entries.iter().enumerate() {
        let seq_pos = w.len();
        w.w16at(seq_slots + ei * 2, (seq_pos - sub_start) as u16);
        w.w16(e.seq.len() as u16);
        for &g in &e.seq {
            w.w16(g);
        }
    }
    true
}

/// AlternateSubst（type3）：与 MultipleSubst 结构同形，仅语义不同
fn serialize_alternate_subst(w: &mut Writer, ctx: &mut SubCtx, off: usize) -> bool {
    let r = ctx.r;
    let cov_off = off + r.rd16(off + 2) as usize;
    let alt_count = r.rd16(off + 4) as usize;
    let mut entries: Vec<SeqEntry> = Vec::new();
    let cov_gids = read_coverage_gids(r, cov_off);
    let lim = cov_gids.len().min(alt_count);
    for i in 0..lim {
        let Some(from_new) = ctx.remap(u32::from(cov_gids[i])) else {
            continue;
        };
        let alt_off = off + r.raw16(off + 6 + i * 2) as usize;
        let cnt = r.raw16(alt_off) as usize;
        let mut new_alts: Vec<u16> = Vec::new();
        for k in 0..cnt {
            if let Some(g) = ctx.remap(u32::from(r.raw16(alt_off + 2 + k * 2))) {
                new_alts.push(g);
            }
        }
        if !new_alts.is_empty() {
            entries.push(SeqEntry { from: from_new, seq: new_alts });
        }
    }
    if entries.is_empty() {
        return false;
    }
    entries.sort_unstable_by_key(|e| e.from);

    let sub_start = w.len();
    let cov_slot = sub_start + 2;
    let alt_slots = sub_start + 6;
    let froms: Vec<u16> = entries.iter().map(|e| e.from).collect();
    w.w16(1);
    w.w16(0);
    w.w16(entries.len() as u16);
    for _ in 0..entries.len() {
        w.w16(0);
    }
    let cov_pos = emit_coverage(w, &froms);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);
    for (ei, e) in entries.iter().enumerate() {
        let alt_pos = w.len();
        w.w16at(alt_slots + ei * 2, (alt_pos - sub_start) as u16);
        w.w16(e.seq.len() as u16);
        for &g in &e.seq {
            w.w16(g);
        }
    }
    true
}

/// LigatureSubst（type4）：coverage + ligature set 数组
fn serialize_ligature_subst(w: &mut Writer, ctx: &mut SubCtx, off: usize) -> bool {
    let r = ctx.r;
    let cov_off = off + r.rd16(off + 2) as usize;
    let set_count = r.rd16(off + 4) as usize;
    let mut entries: Vec<LigEntry> = Vec::new();
    let cov_gids = read_coverage_gids(r, cov_off);
    let lim = cov_gids.len().min(set_count);
    for i in 0..lim {
        let Some(from_new) = ctx.remap(u32::from(cov_gids[i])) else {
            continue;
        };
        let set_off = off + r.raw16(off + 6 + i * 2) as usize;
        let lig_count = r.raw16(set_off) as usize;
        let mut new_ligs: Vec<Lig> = Vec::new();
        for j in 0..lig_count {
            let lig_off = set_off + r.raw16(set_off + 2 + j * 2) as usize;
            let comp_count = r.raw16(lig_off) as usize;
            let Some(lig_new) = ctx.remap(u32::from(r.raw16(lig_off + 2))) else {
                continue;
            };
            // components 从第 2 字形开始（第 1 字形即 coverage 字形），compCount 含第 1 字形
            let mut comp_new: Vec<u16> = vec![from_new];
            let mut ok = true;
            let mut k: usize = 0;
            while k + 1 < comp_count {
                match ctx.remap(u32::from(r.raw16(lig_off + 4 + k * 2))) {
                    Some(c) => comp_new.push(c),
                    None => {
                        ok = false;
                        break;
                    }
                }
                k += 1;
            }
            if ok {
                new_ligs.push(Lig { comp: comp_new, lig: lig_new });
            }
        }
        if !new_ligs.is_empty() {
            entries.push(LigEntry { from: from_new, ligs: new_ligs });
        }
    }
    if entries.is_empty() {
        return false;
    }
    entries.sort_unstable_by_key(|e| e.from);

    let sub_start = w.len();
    let cov_slot = sub_start + 2;
    let set_slots = sub_start + 6;
    let froms: Vec<u16> = entries.iter().map(|e| e.from).collect();
    w.w16(1);
    w.w16(0);
    w.w16(entries.len() as u16);
    for _ in 0..entries.len() {
        w.w16(0);
    }
    let cov_pos = emit_coverage(w, &froms);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);
    for (ei, e) in entries.iter().enumerate() {
        let set_pos = w.len();
        w.w16at(set_slots + ei * 2, (set_pos - sub_start) as u16);
        w.w16(e.ligs.len() as u16);
        let lig_slots = w.len();
        for _ in 0..e.ligs.len() {
            w.w16(0);
        }
        for (lj2, lig) in e.ligs.iter().enumerate() {
            let lig_pos = w.len();
            w.w16at(lig_slots + lj2 * 2, (lig_pos - set_pos) as u16);
            w.w16(lig.comp.len() as u16);
            w.w16(lig.lig);
            // 第 2 个分量起
            for &g in &lig.comp[1..] {
                w.w16(g);
            }
        }
    }
    true
}

/// 解析 format1/format2 的单条 ChainSubRule，返回重映射后的规则或 None（含子集外 gid）
fn parse_chain_rule_format1or2(ctx: &SubCtx, rule_off: usize, is_gid_format: bool) -> Option<ChainRule> {
    let r = ctx.r;
    let back_count = r.rd16(rule_off) as usize;
    if back_count > 255 {
        return None;
    }
    let mut p = rule_off + 2;
    let back = read_chain_seq(ctx, p, back_count, is_gid_format)?;
    p += back_count * 2;
    let input_count = r.rd16(p) as usize;
    // inputCount 为 0 异常（ChainSubRule 至少含第一分量），返回 None
    if input_count == 0 || input_count > 255 {
        return None;
    }
    p += 2;
    // input 序列不含第一分量（第一分量由 coverage/class 决定）
    let input = read_chain_seq(ctx, p, input_count - 1, is_gid_format)?;
    p += (input_count - 1) * 2;
    let look_count = r.rd16(p) as usize;
    if look_count > 255 {
        return None;
    }
    p += 2;
    let look = read_chain_seq(ctx, p, look_count, is_gid_format)?;
    p += look_count * 2;
    let seq_count = r.rd16(p) as usize;
    if seq_count > 255 {
        return None;
    }
    p += 2;
    let mut records: Vec<Rec> = Vec::new();
    for k in 0..seq_count {
        records.push(Rec { seq: r.raw16(p + k * 4), lookup_idx: r.raw16(p + k * 4 + 2) });
    }
    Some(ChainRule { back, input, look, records })
}

/// 读 ChainSubRule 的一个 gid/class 序列；format1 遇子集外 gid 返回 None
fn read_chain_seq(ctx: &SubCtx, p: usize, count: usize, is_gid_format: bool) -> Option<Vec<u16>> {
    let r = ctx.r;
    let mut out: Vec<u16> = Vec::new();
    for k in 0..count {
        let raw = r.raw16(p + k * 2);
        if is_gid_format {
            let m = ctx.remap(u32::from(raw))?;
            out.push(m);
        } else {
            out.push(raw);
        }
    }
    Some(out)
}

/// 写出单条 ChainSubRule 主体（不含偏移量槽）
fn write_chain_rule_body(w: &mut Writer, rule: &ChainRule) {
    w.w16(rule.back.len() as u16);
    for &g in &rule.back {
        w.w16(g);
    }
    // inputCount 含第一分量
    w.w16((rule.input.len() + 1) as u16);
    for &g in &rule.input {
        w.w16(g);
    }
    w.w16(rule.look.len() as u16);
    for &g in &rule.look {
        w.w16(g);
    }
    w.w16(rule.records.len() as u16);
    for rc in &rule.records {
        w.w16(rc.seq);
        w.w16(rc.lookup_idx);
    }
}

/// ChainedContextSubst（type6）subtable 序列化，format1/2/3 均支持
fn serialize_chained_context_subst(w: &mut Writer, ctx: &mut SubCtx, off: usize) -> bool {
    let r = ctx.r;
    let format = r.rd16(off);
    if format == 1 {
        let cov_off = off + r.rd16(off + 2) as usize;
        // 唯一带缓存的 readCoverageGids 调用方（TS 936 行）：填充 covCache 的 gids 侧，
        // 供同 off 的 fmt3/writeChainFormat2 命中「原序重映射」分支
        let cov_gids = cov_gids_cached(ctx, cov_off);
        let rule_set_count = r.rd16(off + 4) as usize;
        if rule_set_count > 0x7fff {
            return false;
        }
        let mut entries: Vec<ChainEntry> = Vec::new();
        let lim = cov_gids.len().min(rule_set_count);
        for i in 0..lim {
            let Some(first_new) = ctx.remap(u32::from(cov_gids[i])) else {
                continue;
            };
            let set_off = off + r.raw16(off + 6 + i * 2) as usize;
            let rule_count = r.raw16(set_off) as usize;
            if rule_count > 0x7fff {
                return false;
            }
            let mut valid_rules: Vec<ChainRule> = Vec::new();
            for j in 0..rule_count {
                let rule_off = set_off + r.raw16(set_off + 2 + j * 2) as usize;
                if let Some(parsed) = parse_chain_rule_format1or2(ctx, rule_off, true) {
                    valid_rules.push(parsed);
                }
            }
            if !valid_rules.is_empty() {
                entries.push(ChainEntry { first_gid: first_new, rules: valid_rules });
            }
        }
        if entries.is_empty() {
            return false;
        }
        entries.sort_unstable_by_key(|e| e.first_gid);
        write_chain_format1(w, &entries);
        return true;
    }

    if format == 2 {
        // format2（ClassDef 匹配）：Coverage + 三个 ClassDef + 按 input 第一分量 class 索引的 rule sets。
        // class index 不重编号（保留 class 0 的「未分类」语义），仅重映射 ClassDef 内的 gid。
        let coverage_off = off + r.rd16(off + 2) as usize;
        let backtrack_cd_off = off + r.rd16(off + 4) as usize;
        let input_cd_off = off + r.rd16(off + 6) as usize;
        let lookahead_cd_off = off + r.rd16(off + 8) as usize;
        let class_set_count = r.rd16(off + 10) as usize;
        // classSetCount 异常大（>256）意味着扩展 padding / 异常结构，严格解析读到重叠垃圾数据，降级
        if class_set_count > 256 {
            return false;
        }

        let mut class_sets: Vec<Option<Vec<ChainRule>>> =
            (0..class_set_count).map(|_| None).collect();
        let mut any = false;
        for i in 0..class_set_count {
            let set_off_rel = r.raw16(off + 12 + i * 2) as usize;
            if set_off_rel == 0 {
                continue;
            }
            let set_off = off + set_off_rel;
            let rule_count = r.raw16(set_off) as usize;
            if rule_count > 0x7fff {
                return false;
            }
            for j in 0..rule_count {
                let rule_off = set_off + r.raw16(set_off + 2 + j * 2) as usize;
                // format2 元素是 class index（非 gid），规则恒保留
                let Some(parsed) = parse_chain_rule_format1or2(ctx, rule_off, false) else {
                    continue;
                };
                class_sets[i].get_or_insert_with(Vec::new).push(parsed);
                any = true;
            }
        }
        if !any {
            return false;
        }
        write_chain_format2(w, ctx, coverage_off, backtrack_cd_off, input_cd_off, lookahead_cd_off, &class_sets);
        return true;
    }

    if format == 3 {
        let Some(parsed) = parse_chain_format3(ctx, off) else {
            return false;
        };
        write_chain_format3(w, parsed);
        return true;
    }

    false
}

/// 写出 ChainedContext format1（coverage + rule sets）
fn write_chain_format1(w: &mut Writer, entries: &[ChainEntry]) {
    let sub_start = w.len();
    let cov_slot = sub_start + 2;
    let set_slots = sub_start + 6;
    let firsts: Vec<u16> = entries.iter().map(|e| e.first_gid).collect();
    w.w16(1);
    w.w16(0); // coverage 偏移槽
    w.w16(entries.len() as u16);
    for _ in 0..entries.len() {
        w.w16(0); // SubRuleSet 偏移槽
    }
    let cov_pos = emit_coverage(w, &firsts);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);
    for (ei, e) in entries.iter().enumerate() {
        let set_pos = w.len();
        w.w16at(set_slots + ei * 2, (set_pos - sub_start) as u16);
        w.w16(e.rules.len() as u16);
        let rule_slots = w.len();
        for _ in 0..e.rules.len() {
            w.w16(0);
        }
        for (rj2, rule) in e.rules.iter().enumerate() {
            let rule_pos = w.len();
            w.w16at(rule_slots + rj2 * 2, (rule_pos - set_pos) as u16);
            write_chain_rule_body(w, rule);
        }
    }
}

/// 写出 ChainedContext format2（三个 ClassDef + 按 class 的 rule sets）
#[allow(clippy::too_many_arguments)]
fn write_chain_format2(
    w: &mut Writer,
    ctx: &mut SubCtx,
    coverage_off: usize,
    backtrack_cd_off: usize,
    input_cd_off: usize,
    lookahead_cd_off: usize,
    class_sets: &[Option<Vec<ChainRule>>],
) {
    let sub_start = w.len();
    let cov_slot = sub_start + 2;
    let back_slot = sub_start + 4;
    let input_slot = sub_start + 6;
    let look_slot = sub_start + 8;
    w.w16(2);
    w.w16(0);
    w.w16(0);
    w.w16(0);
    w.w16(0);

    // classSetCount = 最大非空 class index + 1（保持原始 class index）
    let mut max_class: i64 = -1;
    for (i, cs) in class_sets.iter().enumerate() {
        if cs.is_some() && i as i64 > max_class {
            max_class = i as i64;
        }
    }
    let class_set_count: usize = if max_class < 0 { 0 } else { (max_class + 1) as usize };
    w.w16(class_set_count as u16);
    let set_slots = w.len();
    for i in 0..class_set_count {
        // 0xAA 只为占位区分，实际值由 w16at 回填覆盖（对译 Zig 的占位写法，输出一致）
        w.w16(if i < class_sets.len() && class_sets[i].is_some() { 0xAA } else { 0 });
    }
    // 占位统一为 0：先全部写 0，稍后有规则的回填
    for i in 0..class_set_count {
        w.w16at(set_slots + i * 2, 0);
    }

    // Coverage 重映射：仅保留子集内 gid（readCoverageRemapped None → 写空 coverage）
    let new_cov_gids: Vec<u16> = read_coverage_remapped(ctx, coverage_off).unwrap_or_default();
    let cov_pos = emit_coverage(w, &new_cov_gids);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);

    // 重映射三个 ClassDef 的 gid（class index 不变）
    let back_map = read_class_def_map(ctx, backtrack_cd_off);
    let input_map = read_class_def_map(ctx, input_cd_off);
    let look_map = read_class_def_map(ctx, lookahead_cd_off);
    let back_pos = write_class_def_from_map(w, &back_map);
    let input_pos = write_class_def_from_map(w, &input_map);
    let look_pos = write_class_def_from_map(w, &look_map);
    w.w16at(back_slot, (back_pos - sub_start) as u16);
    w.w16at(input_slot, (input_pos - sub_start) as u16);
    w.w16at(look_slot, (look_pos - sub_start) as u16);

    for i in 0..class_set_count {
        let Some(rules) = &class_sets[i] else { continue };
        let set_pos = w.len();
        w.w16at(set_slots + i * 2, (set_pos - sub_start) as u16);
        w.w16(rules.len() as u16);
        let rule_slots = w.len();
        for _ in 0..rules.len() {
            w.w16(0);
        }
        for (rj2, rule) in rules.iter().enumerate() {
            let rule_pos = w.len();
            w.w16at(rule_slots + rj2 * 2, (rule_pos - set_pos) as u16);
            write_chain_rule_body(w, rule);
        }
    }
}

/// 解析 format3：显式 coverage 数组 + records；任一 coverage 全子集外（原非空）→ None
struct ChainFormat3 {
    back_covs: Vec<Vec<u16>>,
    input_covs: Vec<Vec<u16>>,
    look_covs: Vec<Vec<u16>>,
    records: Vec<Rec>,
}

fn parse_chain_format3(ctx: &mut SubCtx, off: usize) -> Option<ChainFormat3> {
    let mut p = off + 2;
    // 对译 Zig inline for 的三段 coverage 组（backtrack/input/lookahead）
    let mut cov_groups: Vec<Vec<Vec<u16>>> = Vec::with_capacity(3);
    for _ in 0..3 {
        let count = ctx.r.rd16(p) as usize;
        p += 2;
        let mut arr: Vec<Vec<u16>> = Vec::new();
        for k in 0..count {
            let cov_off = off + ctx.r.raw16(p + k * 2) as usize;
            let new_gids = read_coverage_remapped(ctx, cov_off)?;
            arr.push(new_gids);
        }
        p += count * 2;
        cov_groups.push(arr);
    }
    let seq_count = ctx.r.rd16(p) as usize;
    p += 2;
    let mut records: Vec<Rec> = Vec::new();
    for k in 0..seq_count {
        records.push(Rec { seq: ctx.r.raw16(p + k * 4), lookup_idx: ctx.r.raw16(p + k * 4 + 2) });
    }
    let mut cov_groups = cov_groups;
    let look_covs = cov_groups.pop().expect("3 groups");
    let input_covs = cov_groups.pop().expect("3 groups");
    let back_covs = cov_groups.pop().expect("3 groups");
    Some(ChainFormat3 { back_covs, input_covs, look_covs, records })
}

/// 写出 format3：重映射后的 coverage 数组 + records
fn write_chain_format3(w: &mut Writer, parsed: ChainFormat3) {
    let sub_start = w.len();
    let mut cov_slot_positions: Vec<usize> = Vec::new();
    w.w16(3);
    w.w16(parsed.back_covs.len() as u16);
    for _ in 0..parsed.back_covs.len() {
        cov_slot_positions.push(w.len());
        w.w16(0);
    }
    w.w16(parsed.input_covs.len() as u16);
    for _ in 0..parsed.input_covs.len() {
        cov_slot_positions.push(w.len());
        w.w16(0);
    }
    w.w16(parsed.look_covs.len() as u16);
    for _ in 0..parsed.look_covs.len() {
        cov_slot_positions.push(w.len());
        w.w16(0);
    }
    w.w16(parsed.records.len() as u16);
    for rc in &parsed.records {
        w.w16(rc.seq);
        w.w16(rc.lookup_idx);
    }

    // 写出各组 coverage 并回填偏移槽（相对 subStart）
    let mut pos_idx: usize = 0;
    for cov in parsed.back_covs.iter().chain(&parsed.input_covs).chain(&parsed.look_covs) {
        let pos = emit_coverage(w, cov);
        w.w16at(cov_slot_positions[pos_idx], (pos - sub_start) as u16);
        pos_idx += 1;
    }
}

/// ScriptList 连续字节跨度（ot-bytes.ts scriptListSpan）；解析异常返回 -1
fn script_list_span(r: &Reader, list_abs: usize) -> i64 {
    r.clear_error();
    let script_count = r.rd16(list_abs) as usize;
    let mut span: usize = 2 + script_count * 6;
    for i in 0..script_count {
        let script_rel = r.rd16(list_abs + 2 + i * 6 + 4) as usize;
        let script_abs = list_abs + script_rel;
        let default_lang_sys_off = r.rd16(script_abs) as usize;
        let lang_sys_count = r.rd16(script_abs + 2) as usize;
        span = span.max(script_rel + 4 + lang_sys_count * 6);
        if default_lang_sys_off != 0 {
            let dl_rel = script_rel + default_lang_sys_off;
            let fic = r.rd16(script_abs + default_lang_sys_off + 4) as usize;
            span = span.max(dl_rel + 6 + fic * 2);
        }
        for li in 0..lang_sys_count {
            let ls_rel = r.rd16(script_abs + 4 + li * 6 + 4) as usize;
            let fic = r.rd16(script_abs + ls_rel + 4) as usize;
            span = span.max(script_rel + ls_rel + 6 + fic * 2);
        }
    }
    if r.error_flag.get() {
        -1
    } else {
        span as i64
    }
}

/// FeatureList 连续字节跨度（ot-bytes.ts featureListSpan）；解析异常返回 -1
fn feature_list_span(r: &Reader, list_abs: usize) -> i64 {
    r.clear_error();
    let feature_count = r.rd16(list_abs) as usize;
    let mut span: usize = 2 + feature_count * 6;
    for i in 0..feature_count {
        let ft_rel = r.rd16(list_abs + 2 + i * 6 + 4) as usize;
        let ft_abs = list_abs + ft_rel;
        let lookup_index_count = r.rd16(ft_abs + 2) as usize;
        span = span.max(ft_rel + 4 + lookup_index_count * 2);
    }
    if r.error_flag.get() {
        -1
    } else {
        span as i64
    }
}

/// 拷贝一个 LangSys 表（lookupOrder 恒写 0）
fn copy_lang_sys(w: &mut Writer, r: &Reader, abs_off: usize) {
    w.w16(0);
    w.w16(r.rd16(abs_off + 2));
    let fic = r.rd16(abs_off + 4) as usize;
    w.w16(fic as u16);
    for fi in 0..fic {
        w.w16(r.rd16(abs_off + 6 + fi * 2));
    }
}

/// 重新序列化 ScriptList（GPOS/GSUB 通用）；解析异常返回 None
fn serialize_script_list(r: &Reader, list_abs: usize) -> Option<Vec<u8>> {
    r.clear_error();
    let mut w = Writer::new();
    let script_count = r.rd16(list_abs) as usize;
    w.w16(script_count as u16);
    let script_slots = w.len();
    for i in 0..script_count {
        let s = list_abs + 2 + i * 6;
        w.wbytes(&r.data[s..s + 4]); // tag 4 字节原样拷贝
        w.w16(0); // 偏移槽
    }
    for i in 0..script_count {
        let script_new_off = w.len();
        w.w16at(script_slots + i * 2, script_new_off as u16); // ScriptRecord 偏移相对 ScriptList 起始（writer 0）
        let script_old_off = list_abs + r.rd16(list_abs + 2 + i * 6 + 4) as usize;
        let default_lang_sys_off = r.rd16(script_old_off) as usize;
        let lang_sys_count = r.rd16(script_old_off + 2) as usize;
        let st_start = w.len();
        let default_slot = w.len();
        w.w16(0); // defaultLangSysOffset 槽（相对 ScriptTable 起始）
        w.w16(lang_sys_count as u16);
        let ls_slots = w.len();
        for li in 0..lang_sys_count {
            let s = script_old_off + 4 + li * 6;
            w.wbytes(&r.data[s..s + 4]); // LangSysRecord tag
            w.w16(0); // 偏移槽
        }
        if default_lang_sys_off != 0 {
            let dl_pos = w.len();
            w.w16at(default_slot, (dl_pos - st_start) as u16);
            copy_lang_sys(&mut w, r, script_old_off + default_lang_sys_off);
        }
        for li in 0..lang_sys_count {
            let ls_old_off = script_old_off + r.rd16(script_old_off + 4 + li * 6 + 4) as usize;
            let ls_pos = w.len();
            w.w16at(ls_slots + li * 2, (ls_pos - st_start) as u16);
            copy_lang_sys(&mut w, r, ls_old_off);
        }
    }
    if r.error_flag.get() {
        return None;
    }
    Some(w.list)
}

/// 重新序列化 FeatureList；解析异常返回 None
fn serialize_feature_list(r: &Reader, list_abs: usize) -> Option<Vec<u8>> {
    r.clear_error();
    let mut w = Writer::new();
    let feature_count = r.rd16(list_abs) as usize;
    w.w16(feature_count as u16);
    let feature_slots = w.len();
    for i in 0..feature_count {
        let s = list_abs + 2 + i * 6;
        w.wbytes(&r.data[s..s + 4]); // tag 4 字节原样拷贝
        w.w16(0); // 偏移槽
    }
    for i in 0..feature_count {
        let ft_new_off = w.len();
        w.w16at(feature_slots + i * 2, ft_new_off as u16);
        let ft_old_off = list_abs + r.rd16(list_abs + 2 + i * 6 + 4) as usize;
        let feature_params_off = r.rd16(ft_old_off);
        let lookup_index_count = r.rd16(ft_old_off + 2) as usize;
        // featureParamsOffset 原样保留（非 0 时相对 FeatureTable，其内容不含 gid）
        w.w16(feature_params_off);
        w.w16(lookup_index_count as u16);
        for li in 0..lookup_index_count {
            w.w16(r.rd16(ft_old_off + 4 + li * 2));
        }
    }
    if r.error_flag.get() {
        return None;
    }
    Some(w.list)
}

/// GSUB 子集化入口（对应 TS subsetGSUB）。
/// keep：子集保留的原始 gid 序列（新 gid = 下标；与 TS subsetGids 顺序语义一致）。
/// 版本不支持时返回原始字节拷贝（TS 语义：原样返回）。
pub fn subset_gsub(gsub_bytes: &[u8], keep: &[u16]) -> Result<Vec<u8>, GsubError> {
    let r = Reader::new(gsub_bytes);

    // 原 gid→新 gid 查找表（下标=原 gid，值=新 gid，-1=不在子集）
    let mut max_orig_gid: usize = 0;
    for &g in keep {
        if g as usize > max_orig_gid {
            max_orig_gid = g as usize;
        }
    }
    let mut gid_lookup = vec![-1i32; max_orig_gid + 1];
    for (new_gid, &g) in keep.iter().enumerate() {
        gid_lookup[g as usize] = new_gid as i32;
    }
    let mut sorted_subset = keep.to_vec();
    sorted_subset.sort_unstable();

    let mut ctx = SubCtx { r: &r, gid_lookup, sorted_subset, cov_cache: HashMap::new() };

    // ---- GSUB Header ----
    let major = r.raw16(0);
    let minor = r.raw16(2);
    if major != 1 || minor > 1 {
        return Ok(gsub_bytes.to_vec());
    }
    let script_list_off = r.raw16(4) as usize;
    let feature_list_off = r.raw16(6) as usize;
    let lookup_list_off = r.raw16(8) as usize;
    let lookups = parse_lookups(&r, lookup_list_off);

    // 第一遍：supported 判定 + 每子表 skipable 预扫描 + lookup 级 allEmpty
    let mut supported = vec![false; lookups.len()];
    let mut all_empty = vec![false; lookups.len()];
    let mut skipable: Vec<Vec<bool>> = Vec::with_capacity(lookups.len());
    for (i, lk) in lookups.iter().enumerate() {
        let et = lk.effective_type;
        supported[i] = matches!(et, 1 | 2 | 3 | 4 | 6);
        let subs = &lk.sub_offs;
        let mut all = !subs.is_empty();
        let sk: Vec<bool> = subs
            .iter()
            .map(|&so| {
                let s = is_subtable_skipable_by_coverage(&ctx, so, et);
                if !s {
                    all = false;
                }
                s
            })
            .collect();
        skipable.push(sk);
        all_empty[i] = all;
    }

    // ---- ScriptList / FeatureList ----
    let sl_span = script_list_span(&r, script_list_off);
    let sl_contiguous = sl_span >= 0 && script_list_off + sl_span as usize <= feature_list_off;
    let script_list_bytes: Option<Vec<u8>> = if sl_contiguous {
        Some(gsub_bytes[script_list_off..script_list_off + sl_span as usize].to_vec())
    } else {
        serialize_script_list(&r, script_list_off)
    };
    let fl_span = feature_list_span(&r, feature_list_off);
    let fl_contiguous = fl_span >= 0 && feature_list_off + fl_span as usize <= lookup_list_off;
    let feature_list_bytes: Option<Vec<u8>> = if fl_contiguous {
        Some(gsub_bytes[feature_list_off..feature_list_off + fl_span as usize].to_vec())
    } else {
        serialize_feature_list(&r, feature_list_off)
    };
    r.clear_error();
    // ScriptList/FeatureList 解析失败则整体保留原始 GSUB 字节（安全降级）
    let (script_list_bytes, feature_list_bytes) = match (script_list_bytes, feature_list_bytes) {
        (Some(sl), Some(fl)) => (sl, fl),
        _ => return Ok(gsub_bytes.to_vec()),
    };

    // ---- 主 Writer（输出恒小于原表，按原表长度预分配）----
    let mut w = Writer::with_capacity(gsub_bytes.len());

    // Header
    w.w16(1);
    w.w16(minor);
    let sl_slot = w.len();
    w.w16(0);
    let fl_slot = w.len();
    w.w16(0);
    let ll_slot = w.len();
    w.w16(0);

    // ScriptList
    let sl_abs = w.len();
    w.wbytes(&script_list_bytes);
    // FeatureList
    let fl_abs = w.len();
    w.wbytes(&feature_list_bytes);

    // LookupList
    let ll_abs = w.len();
    w.w16(lookups.len() as u16);
    let lookup_slots = w.len();
    for _ in 0..lookups.len() {
        w.w16(0);
    }

    for (i, lk) in lookups.iter().enumerate() {
        let lookup_abs = w.len();
        let et = lk.effective_type;
        if supported[i] {
            let lookup_flag = r.rd16(lk.orig_off + 2);
            let use_mark_filtering_set = (lookup_flag & 0x0010) != 0;
            // 输出用 effectiveType（extension 解包后内嵌，不再用 extension 包裹）
            w.w16(et as u16);
            w.w16(lookup_flag);
            if all_empty[i] {
                // 全空 lookup 折叠 subCount=1 的单个空 subtable（feature 按 index 引用不受影响）
                w.w16(1);
                let lookup_start = w.len() - 6;
                let subtable_slot = w.len();
                w.w16(0);
                if use_mark_filtering_set {
                    w.w16(r.rd16(lk.orig_off + 6 + lk.sub_offs.len() * 2));
                }
                let subtable_pos = w.len();
                write_empty_subtable(&mut w, et);
                w.w16at(subtable_slot, (subtable_pos - lookup_start) as u16);
            } else {
                // 跳过 coverage gid 全不在子集的 subtable（渲染等价：必空 subtable 查不到字形）
                let mut kept: Vec<usize> = Vec::new();
                for (j, &sk) in skipable[i].iter().enumerate() {
                    if !sk {
                        kept.push(j);
                    }
                }
                let kept_count = kept.len();
                w.w16(kept_count as u16);
                let lookup_start = w.len() - 6;
                let subtable_slots = w.len();
                for _ in 0..kept_count {
                    w.w16(0);
                }
                if use_mark_filtering_set {
                    w.w16(r.rd16(lk.orig_off + 6 + lk.sub_offs.len() * 2));
                }
                for (j, &orig_idx) in kept.iter().enumerate() {
                    let before = w.len();
                    let ok = serialize_subtable(&mut w, &mut ctx, lk.sub_offs[orig_idx], et, skipable[i][orig_idx]);
                    if !ok {
                        w.rollback(before);
                        write_empty_subtable(&mut w, et);
                    }
                    w.w16at(subtable_slots + j * 2, (before - lookup_start) as u16);
                }
            }
        } else {
            // 不支持的 lookup（type5 等）：类型/flag 保留原值，单空 subtable 降级
            let lookup_flag = r.rd16(lk.orig_off + 2);
            let use_mark_filtering_set = (lookup_flag & 0x0010) != 0;
            w.w16(r.rd16(lk.orig_off));
            w.w16(lookup_flag);
            w.w16(1);
            let lookup_start = w.len() - 6;
            let subtable_slot = w.len();
            w.w16(0);
            if use_mark_filtering_set {
                w.w16(r.rd16(lk.orig_off + 6 + lk.sub_offs.len() * 2));
            }
            let subtable_pos = w.len();
            write_empty_subtable(&mut w, et);
            w.w16at(subtable_slot, (subtable_pos - lookup_start) as u16);
        }
        // 回填 lookup 偏移槽（相对 LookupList 起始）
        w.w16at(lookup_slots + i * 2, (lookup_abs - ll_abs) as u16);
    }

    // Header 偏移回填
    w.w16at(sl_slot, sl_abs as u16);
    w.w16at(fl_slot, fl_abs as u16);
    w.w16at(ll_slot, ll_abs as u16);

    Ok(w.list)
}

// ===== GPOS 子集化（对应 gpos-subset.ts：LookupType 1 SinglePos / 2 PairPos，
//       Mark*（4/5/6）等 unsupported 降级空 subtable，版本不支持整体降级返回 None）=====

/// ValueFormat 位：Device/VariationIndex 四位（含任一则整体降级）
const VF_DEVICE_MASK: u16 = 0x00F0;

/// 一个 ValueRecord 占用的 uint16 数量（valueFormat 低 8 位的 set bit 数）
fn value_record_size(value_format: u16) -> usize {
    let mut n: usize = 0;
    let mut bits = value_format & 0xff;
    while bits != 0 {
        n += (bits & 1) as usize;
        bits >>= 1;
    }
    n
}

/// 写空 coverage 表（format1 + count0）
fn write_empty_coverage(w: &mut Writer) {
    w.w16(1);
    w.w16(0);
}

/// 写合法的空 Position subtable（浏览器查不到字形跳过；unsupported lookup 保守降级用）
fn write_empty_pos_subtable(w: &mut Writer, effective_type: i32) {
    w.w16(1);
    if effective_type == 4 || effective_type == 5 || effective_type == 6 {
        // MarkBase/MarkLig/MarkMark format1：12 字节头 + 空 markCoverage/baseCoverage/markArray/baseArray
        w.w16(12); // markCoverageOff
        w.w16(16); // baseCoverageOff
        w.w16(0); // markClassCount = 0
        w.w16(20); // markArrayOff
        w.w16(22); // baseArrayOff
        write_empty_coverage(w); // @12
        write_empty_coverage(w); // @16
        w.w16(0); // markArray: markCount = 0 @20
        w.w16(0); // baseArray: baseCount = 0 @22
        return;
    }
    // coverageOff 相对 subtable 的常量：SinglePos/Cursive 等头 6 字节、PairPos 头 10 字节
    let coverage_off_const: u16 = if effective_type == 2 { 10 } else { 6 };
    w.w16(coverage_off_const);
    if effective_type == 1 {
        w.w16(0); // valueFormat = 0
    } else if effective_type == 2 {
        w.w16(0); // valueFormat1
        w.w16(0); // valueFormat2
        w.w16(0); // pairSetCount
    } else {
        w.w16(0); // Cursive: entryExitCount=0；Context/ChainContext: ruleSetCount=0；-1: 同形
    }
    write_empty_coverage(w);
}

/// SinglePos/PairPos 的 coverage 是否含任意子集字形（提前退出；对应 TS subtableCoverageHits）
fn pos_subtable_coverage_hits(ctx: &SubCtx, sub_abs: usize) -> bool {
    let r = ctx.r;
    if sub_abs + 4 > r.data.len() {
        return false;
    }
    let cov_abs = sub_abs + r.raw16(sub_abs + 2) as usize;
    if cov_abs + 4 > r.data.len() {
        return false;
    }
    let fmt = r.raw16(cov_abs);
    if fmt == 1 {
        let count = r.raw16(cov_abs + 2) as usize;
        let base = cov_abs + 4;
        if base + count * 2 > r.data.len() {
            return false;
        }
        for i in 0..count {
            if ctx.remap(u32::from(r.raw16(base + i * 2))).is_some() {
                return true;
            }
        }
        return false;
    }
    if fmt == 2 {
        let range_count = r.raw16(cov_abs + 2) as usize;
        let mut p = cov_abs + 4;
        for _ in 0..range_count {
            if p + 6 > r.data.len() {
                break;
            }
            let start = r.raw16(p);
            let end = r.raw16(p + 2);
            // u32 循环避免 end=0xFFFF 时 u16 环绕
            let mut g: u32 = u32::from(start);
            while g <= u32::from(end) {
                if ctx.remap(g).is_some() {
                    return true;
                }
                g += 1;
            }
            p += 6;
        }
        return false;
    }
    true // 未知 format 保守视为命中（避免错误折叠）
}

/// 写 ValueRecord（按 valueFormat 顺序 xPla/yPla/xAdv/yAdv；含 Device 位返回 false 整体降级）
fn write_value_record(w: &mut Writer, r: &Reader, abs_off: usize, value_format: u16) -> bool {
    if value_format & VF_DEVICE_MASK != 0 {
        return false;
    }
    let mut off = abs_off;
    for bit in [0x0001u16, 0x0002, 0x0004, 0x0008] {
        if value_format & bit != 0 {
            // @bitCast(i16→u16)：`as` 同为位模式重解释
            w.w16(r.rd16s(off) as u16);
            off += 2;
        }
    }
    true
}

/// GPOS 版 ClassDef 输出（选更紧凑 format；fmt1 用 startGlyph/glyphCount 展开含 class0 段；
/// 与 gsub 版（恒 format2）不同，对应 TS gpos-subset emitClassDefFromClassMap）
fn emit_class_def_from_class_map(w: &mut Writer, class_map: &HashMap<u16, u16>) -> usize {
    let off = w.len();
    if class_map.is_empty() {
        w.w16(1);
        w.w16(0);
        w.w16(0);
        return off;
    }
    // map 迭代序不影响输出：entries 随后按 gid 升序排序（key 单射，排序全序确定）
    let mut entries: Vec<(u16, u16)> = class_map.iter().map(|(&gid, &cls)| (gid, cls)).collect();
    entries.sort_unstable_by_key(|e| e.0);
    // 连续同 class 折叠为 range
    let mut ranges: Vec<(u16, u16, u16)> = Vec::new(); // (start, end, cls)
    let mut i: usize = 0;
    while i < entries.len() {
        let cls = entries[i].1;
        let mut j = i;
        while j + 1 < entries.len()
            && entries[j + 1].0 == entries[j].0.wrapping_add(1)
            && entries[j + 1].1 == cls
        {
            j += 1;
        }
        ranges.push((entries[i].0, entries[j].0, cls));
        i = j + 1;
    }
    let list_start = entries[0].0;
    let list_count: usize = entries[entries.len() - 1].0 as usize - list_start as usize + 1;
    let list_cost: usize = 6 + list_count * 2;
    let range_cost: usize = 4 + ranges.len() * 6;
    if range_cost < list_cost {
        w.w16(2);
        w.w16(ranges.len() as u16);
        for rg in &ranges {
            w.w16(rg.0);
            w.w16(rg.1);
            w.w16(rg.2);
        }
    } else {
        w.w16(1);
        w.w16(list_start);
        w.w16(list_count as u16);
        for gid in list_start as usize..list_start as usize + list_count {
            let cls = class_map.get(&(gid as u16)).copied().unwrap_or(0);
            w.w16(cls);
        }
    }
    off
}

/// SinglePos 子表序列化（fmt1 共用 ValueRecord；fmt2 按 coverage index 对齐）。
/// 失败（含 Device 位 / 未知 format）返回 false → 整体降级。
fn serialize_single_pos(w: &mut Writer, ctx: &mut SubCtx, sub_abs: usize) -> bool {
    let r = ctx.r;
    let fmt = r.raw16(sub_abs);
    let coverage_off = r.raw16(sub_abs + 2) as usize;
    let value_format = r.raw16(sub_abs + 4);
    let orig_gids = read_coverage_gids(r, sub_abs + coverage_off);
    let sz = value_record_size(value_format);

    struct Kept {
        new_gid: u16,
        value_abs: usize,
    }
    let mut kept: Vec<Kept> = Vec::new();
    for (idx, &g) in orig_gids.iter().enumerate() {
        let Some(new_gid) = ctx.remap(u32::from(g)) else {
            continue;
        };
        if fmt == 1 {
            kept.push(Kept { new_gid, value_abs: sub_abs + 6 });
        } else if fmt == 2 {
            kept.push(Kept { new_gid, value_abs: sub_abs + 8 + idx * sz * 2 });
        } else {
            return false;
        }
    }
    kept.sort_unstable_by_key(|k| k.new_gid);

    let sub_start = w.len();
    w.w16(fmt); // 1 或 2 原样保留（无降级折叠）
    let cov_slot = w.len();
    w.w16(0);
    w.w16(value_format);
    if fmt == 2 {
        w.w16(kept.len() as u16);
    }
    for e in &kept {
        if !write_value_record(w, r, e.value_abs, value_format) {
            return false;
        }
    }
    let cov_gids: Vec<u16> = kept.iter().map(|e| e.new_gid).collect();
    let cov_pos = emit_coverage(w, &cov_gids);
    w.w16at(cov_slot, (cov_pos - sub_start) as u16);
    true
}

/// PairPos 子表序列化（fmt1 glyph 对 / fmt2 class 对 + class 紧致重编号）
fn serialize_pair_pos(w: &mut Writer, ctx: &mut SubCtx, sub_abs: usize) -> bool {
    let r = ctx.r;
    let fmt = r.raw16(sub_abs);
    let coverage_off = r.raw16(sub_abs + 2) as usize;
    let value_format1 = r.raw16(sub_abs + 4);
    let value_format2 = r.raw16(sub_abs + 6);
    let vr1 = value_record_size(value_format1);
    let vr2 = value_record_size(value_format2);
    if value_format1 & VF_DEVICE_MASK != 0 || value_format2 & VF_DEVICE_MASK != 0 {
        return false;
    }

    if fmt == 1 {
        let first_gids = read_coverage_gids(r, sub_abs + coverage_off);
        let pair_set_count = r.raw16(sub_abs + 8) as usize;

        struct Rebuilt {
            new_first: u16,
            bytes: Vec<u8>,
        }
        let mut rebuilt: Vec<Rebuilt> = Vec::new();
        for idx in 0..pair_set_count {
            if idx >= first_gids.len() {
                continue;
            }
            let Some(new_first) = ctx.remap(u32::from(first_gids[idx])) else {
                continue;
            };
            let pair_set_off = sub_abs + r.raw16(sub_abs + 10 + idx * 2) as usize;
            let pair_value_count = r.raw16(pair_set_off) as usize;
            struct KeptSecond {
                new_second: u16,
                rec_abs: usize,
            }
            let mut kept_seconds: Vec<KeptSecond> = Vec::new();
            for p in 0..pair_value_count {
                let rec_abs = pair_set_off + 2 + p * (2 + vr1 * 2 + vr2 * 2);
                let Some(new_second) = ctx.remap(u32::from(r.raw16(rec_abs))) else {
                    continue;
                };
                kept_seconds.push(KeptSecond { new_second, rec_abs });
            }
            kept_seconds.sort_unstable_by_key(|k| k.new_second);
            let mut pw = Writer::new();
            pw.w16(kept_seconds.len() as u16);
            for ks in &kept_seconds {
                pw.w16(ks.new_second);
                if vr1 > 0 && !write_value_record(&mut pw, r, ks.rec_abs + 2, value_format1) {
                    return false;
                }
                if vr2 > 0 && !write_value_record(&mut pw, r, ks.rec_abs + 2 + vr1 * 2, value_format2) {
                    return false;
                }
            }
            rebuilt.push(Rebuilt { new_first, bytes: pw.list });
        }
        rebuilt.sort_unstable_by_key(|k| k.new_first);

        let sub_start = w.len();
        w.w16(1);
        let cov_slot = w.len();
        w.w16(0);
        w.w16(value_format1);
        w.w16(value_format2);
        w.w16(rebuilt.len() as u16);
        let slot_base = w.len();
        for _ in 0..rebuilt.len() {
            w.w16(0);
        }
        for (si, e) in rebuilt.iter().enumerate() {
            let pos = w.len();
            w.wbytes(&e.bytes);
            w.w16at(slot_base + si * 2, (pos - sub_start) as u16);
        }
        let cov_gids: Vec<u16> = rebuilt.iter().map(|e| e.new_first).collect();
        let cov_pos = emit_coverage(w, &cov_gids);
        w.w16at(cov_slot, (cov_pos - sub_start) as u16);
        return true;
    }

    if fmt == 2 {
        let class_def1_off = r.raw16(sub_abs + 8) as usize;
        let class_def2_off = r.raw16(sub_abs + 10) as usize;
        let class2_count = r.raw16(sub_abs + 14) as usize;
        let gid_to_class1 = read_class_def_map(ctx, sub_abs + class_def1_off);
        let gid_to_class2 = read_class_def_map(ctx, sub_abs + class_def2_off);

        // 实际命中的 class（class 0 恒保留），升序紧致重编号
        let mut used1: Vec<u16> = vec![0];
        for &c in gid_to_class1.values() {
            if !used1.contains(&c) {
                used1.push(c);
            }
        }
        let mut used2: Vec<u16> = vec![0];
        for &c in gid_to_class2.values() {
            if !used2.contains(&c) {
                used2.push(c);
            }
        }
        used1.sort_unstable();
        used2.sort_unstable();
        // 原 class → 紧致 class（升序重编号）
        let c1_remap: HashMap<u16, u16> =
            used1.iter().enumerate().map(|(i, &c)| (c, i as u16)).collect();
        let c2_remap: HashMap<u16, u16> =
            used2.iter().enumerate().map(|(i, &c)| (c, i as u16)).collect();
        let new_class1_count = used1.len();
        let new_class2_count = used2.len();

        // 紧致后的 ClassDef（新 gid -> 紧致 class）
        let mut compact_cd1: HashMap<u16, u16> = HashMap::with_capacity(gid_to_class1.len());
        for (&gid, &cls) in &gid_to_class1 {
            // 单射反查：Zig 迭代找 value==nc 的 key 等价于 used 数组按下标取（紧致映射恒存在）
            compact_cd1.insert(gid, c1_remap[&cls]);
        }
        let mut compact_cd2: HashMap<u16, u16> = HashMap::with_capacity(gid_to_class2.len());
        for (&gid, &cls) in &gid_to_class2 {
            compact_cd2.insert(gid, c2_remap[&cls]);
        }

        // coverage 重映射（升序）
        let cov_gids = read_coverage_gids(r, sub_abs + coverage_off);
        let mut new_cov: Vec<u16> = Vec::new();
        for g in cov_gids {
            if let Some(ng) = ctx.remap(u32::from(g)) {
                new_cov.push(ng);
            }
        }
        new_cov.sort_unstable();

        let class2_rec_size = vr1 * 2 + vr2 * 2;
        let sub_start = w.len();
        w.w16(2);
        let cov_slot = w.len();
        w.w16(0);
        w.w16(value_format1);
        w.w16(value_format2);
        let cd1_slot = w.len();
        w.w16(0);
        let cd2_slot = w.len();
        w.w16(0);
        w.w16(new_class1_count as u16);
        w.w16(new_class2_count as u16);

        // class1Records：按紧致 class 遍历，从原始数组 (原class1 * class2Count + 原class2) 取值
        for nc1 in 0..new_class1_count {
            // 原 class = used1 中第 nc1 个（升序重编号，直接查表）
            let oc1 = used1[nc1];
            for nc2 in 0..new_class2_count {
                let oc2 = used2[nc2];
                let rec_abs = sub_abs + 16 + (oc1 as usize * class2_count + oc2 as usize) * class2_rec_size;
                if vr1 > 0 && !write_value_record(w, r, rec_abs, value_format1) {
                    return false;
                }
                if vr2 > 0 && !write_value_record(w, r, rec_abs + vr1 * 2, value_format2) {
                    return false;
                }
            }
        }

        let cd1_pos = emit_class_def_from_class_map(w, &compact_cd1);
        let cd2_pos = emit_class_def_from_class_map(w, &compact_cd2);
        let cov_pos = emit_coverage(w, &new_cov);
        w.w16at(cd1_slot, (cd1_pos - sub_start) as u16);
        w.w16at(cd2_slot, (cd2_pos - sub_start) as u16);
        w.w16at(cov_slot, (cov_pos - sub_start) as u16);
        return true;
    }
    false
}

/// GPOS 子集化入口（对应 TS subsetGPOS）。
/// 返回重映射后的 GPOS 字节；版本不支持/解析异常/含 Device ValueRecord 时返回 None
/// （调用方保留原始 GPOS 字节——None = 透传原始字节，区别于错误）。
pub fn subset_gpos(gpos_bytes: &[u8], keep: &[u16]) -> Result<Option<Vec<u8>>, GsubError> {
    let r = Reader::new(gpos_bytes);
    let mut max_orig_gid: usize = 0;
    for &g in keep {
        if g as usize > max_orig_gid {
            max_orig_gid = g as usize;
        }
    }
    let mut gid_lookup = vec![-1i32; max_orig_gid + 1];
    for (new_gid, &g) in keep.iter().enumerate() {
        gid_lookup[g as usize] = new_gid as i32;
    }
    // PairPos format2 的 ClassDef fmt2 读取（read_class_def_map）依赖升序原 gid 二分，必须填充；
    // 曾传空导致 fmt2 class 全丢、类矩阵塌缩 1x1（PairPos2 kerning 全失，仅 CJK 全字 GPOS 暴露）
    let mut sorted_subset = keep.to_vec();
    sorted_subset.sort_unstable();
    let mut ctx = SubCtx { r: &r, gid_lookup, sorted_subset, cov_cache: HashMap::new() };

    // ---- Header：仅 v1.0 / v1.1（v1.1 的 FeatureVariations 非零不处理）----
    let major = r.raw16(0);
    let minor = r.raw16(2);
    if major != 1 || minor > 1 {
        return Ok(None);
    }
    let script_list_off = r.raw16(4) as usize;
    let feature_list_off = r.raw16(6) as usize;
    let lookup_list_off = r.raw16(8) as usize;
    if minor == 1 && r.rd32(10) != 0 {
        return Ok(None);
    }

    // ---- LookupList 解析（extension type9 解引用）----
    let lookup_count = r.raw16(lookup_list_off) as usize;
    struct Lk {
        supported: bool,
        effective_type: i32,
        sub_offs: Vec<usize>,
        orig_off: usize,
    }
    let mut lookups: Vec<Lk> = Vec::new();
    for li in 0..lookup_count {
        let l_off = lookup_list_off + r.raw16(lookup_list_off + 2 + li * 2) as usize;
        let lookup_type = r.raw16(l_off) as usize;
        let sub_table_count = r.raw16(l_off + 4) as usize;
        let mut sub_offs: Vec<usize> = Vec::new();
        let mut effective_type: i32 = lookup_type as i32;
        for sj in 0..sub_table_count {
            let sub_off = l_off + r.raw16(l_off + 6 + sj * 2) as usize;
            if lookup_type == 9 {
                if r.raw16(sub_off) != 1 {
                    effective_type = -1;
                    continue;
                }
                effective_type = i32::from(r.raw16(sub_off + 2));
                sub_offs.push(sub_off + r.rd32(sub_off + 4) as usize);
            } else {
                sub_offs.push(sub_off);
            }
        }
        let supported = effective_type == 1 || effective_type == 2;
        lookups.push(Lk { supported, effective_type, sub_offs, orig_off: l_off });
    }

    // 预扫描每 subtable coverage 命中（supported lookup）
    let mut hits: Vec<Vec<bool>> = Vec::with_capacity(lookups.len());
    for lk in &lookups {
        let mut h: Vec<bool> = Vec::new();
        if lk.supported {
            for &so in &lk.sub_offs {
                h.push(pos_subtable_coverage_hits(&ctx, so));
            }
        }
        hits.push(h);
    }

    // ---- ScriptList / FeatureList（span 快路径 + 重序列化降级）----
    let sl_span = script_list_span(&r, script_list_off);
    let sl_contiguous = sl_span >= 0 && script_list_off + sl_span as usize <= feature_list_off;
    let script_list_bytes: Option<Vec<u8>> = if sl_contiguous {
        Some(gpos_bytes[script_list_off..script_list_off + sl_span as usize].to_vec())
    } else {
        serialize_script_list(&r, script_list_off)
    };
    let fl_span = feature_list_span(&r, feature_list_off);
    let fl_contiguous = fl_span >= 0 && feature_list_off + fl_span as usize <= lookup_list_off;
    let feature_list_bytes: Option<Vec<u8>> = if fl_contiguous {
        Some(gpos_bytes[feature_list_off..feature_list_off + fl_span as usize].to_vec())
    } else {
        serialize_feature_list(&r, feature_list_off)
    };
    r.clear_error();
    let (script_list_bytes, feature_list_bytes) = match (script_list_bytes, feature_list_bytes) {
        (Some(sl), Some(fl)) => (sl, fl),
        _ => return Ok(None),
    };

    // ---- 主 Writer + Header（版本恒写 1.0，与 TS 一致；按原表长度预分配）----
    let mut w = Writer::with_capacity(gpos_bytes.len());
    w.w16(1);
    w.w16(0);
    let sl_slot = w.len();
    w.w16(0);
    let fl_slot = w.len();
    w.w16(0);
    let ll_slot = w.len();
    w.w16(0);

    let sl_abs = w.len();
    w.wbytes(&script_list_bytes);
    let fl_abs = w.len();
    w.wbytes(&feature_list_bytes);

    // ---- LookupList ----
    let ll_abs = w.len();
    w.w16(lookups.len() as u16);
    let lookup_slots = w.len();
    for _ in 0..lookups.len() {
        w.w16(0);
    }

    for (i, lk) in lookups.iter().enumerate() {
        let lookup_abs = w.len();
        let lookup_flag = r.rd16(lk.orig_off + 2);
        let use_mark_filtering_set = (lookup_flag & 0x0010) != 0;
        if lk.supported {
            let any_hit = hits[i].iter().any(|&h| h);
            // 输出 lookup 类型用 effectiveType（extension 解包后内嵌）
            w.w16(lk.effective_type as u16);
            w.w16(lookup_flag);
            if !any_hit {
                // 全空折叠：subCount=1 单个空 subtable
                w.w16(1);
                let lookup_start = w.len() - 6;
                let subtable_slot = w.len();
                w.w16(0);
                if use_mark_filtering_set {
                    w.w16(r.rd16(lk.orig_off + 6 + lk.sub_offs.len() * 2));
                }
                let subtable_pos = w.len();
                write_empty_pos_subtable(&mut w, lk.effective_type);
                w.w16at(subtable_slot, (subtable_pos - lookup_start) as u16);
            } else {
                // 只输出 coverage 命中的 subtable（未命中的必产出空表，渲染等价）
                let mut kept: Vec<usize> = Vec::new();
                for (j, &h) in hits[i].iter().enumerate() {
                    if h {
                        kept.push(j);
                    }
                }
                w.w16(kept.len() as u16);
                let lookup_start = w.len() - 6;
                let subtable_slots = w.len();
                for _ in 0..kept.len() {
                    w.w16(0);
                }
                if use_mark_filtering_set {
                    w.w16(r.rd16(lk.orig_off + 6 + lk.sub_offs.len() * 2));
                }
                for (j, &orig_idx) in kept.iter().enumerate() {
                    let before = w.len();
                    r.clear_error();
                    let ok = if lk.effective_type == 1 {
                        serialize_single_pos(&mut w, &mut ctx, lk.sub_offs[orig_idx])
                    } else if lk.effective_type == 2 {
                        serialize_pair_pos(&mut w, &mut ctx, lk.sub_offs[orig_idx])
                    } else {
                        false
                    };
                    if !ok || r.error_flag.get() {
                        return Ok(None);
                    }
                    // Zig 的 indexOfScalar 在顺序遍历下恒等于循环下标 j
                    w.w16at(subtable_slots + j * 2, (before - lookup_start) as u16);
                }
            }
        } else {
            // unsupported lookup：保留原 type/flag，折叠 subCount=1 空表
            w.w16(r.rd16(lk.orig_off));
            w.w16(lookup_flag);
            w.w16(1);
            let lookup_start = w.len() - 6;
            let subtable_slot = w.len();
            w.w16(0);
            if use_mark_filtering_set {
                w.w16(r.rd16(lk.orig_off + 6 + lk.sub_offs.len() * 2));
            }
            let subtable_pos = w.len();
            write_empty_pos_subtable(&mut w, lk.effective_type);
            w.w16at(subtable_slot, (subtable_pos - lookup_start) as u16);
        }
        w.w16at(lookup_slots + i * 2, (lookup_abs - ll_abs) as u16);
    }

    w.w16at(sl_slot, sl_abs as u16);
    w.w16at(fl_slot, fl_abs as u16);
    w.w16at(ll_slot, ll_abs as u16);

    Ok(Some(w.list))
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u16(out: &mut Vec<u8>, v: u16) {
        out.extend_from_slice(&v.to_be_bytes());
    }

    fn be16(b: &[u8], off: usize) -> u16 {
        u16::from_be_bytes([b[off], b[off + 1]])
    }

    /// 写 coverage format1（升序 gid 数组）
    fn push_coverage1(out: &mut Vec<u8>, gids: &[u16]) {
        push_u16(out, 1);
        push_u16(out, gids.len() as u16);
        for &g in gids {
            push_u16(out, g);
        }
    }

    /// 组装最小合法 GSUB/GPOS 表（共用结构）：Header + ScriptList(DFLT) + FeatureList(liga)
    /// + LookupList。script/feature 列表与 Zig 版序列化产物布局一致（连续 span 快路径可命中）。
    fn build_layout_table(feature_lookups: &[u16], lookups: &[Vec<u8>]) -> Vec<u8> {
        let mut script = Vec::new();
        push_u16(&mut script, 1); // scriptCount
        script.extend_from_slice(b"DFLT");
        push_u16(&mut script, 8); // scriptOffset（相对 ScriptList）
        push_u16(&mut script, 4); // defaultLangSysOff（相对 ScriptTable）
        push_u16(&mut script, 0); // langSysCount
        // LangSys @8
        push_u16(&mut script, 0); // lookupOrder
        push_u16(&mut script, 0xFFFF); // requiredFeatureIndex
        push_u16(&mut script, 1); // featureIndexCount
        push_u16(&mut script, 0); // featureIndices[0]

        let mut feature = Vec::new();
        push_u16(&mut feature, 1); // featureCount
        feature.extend_from_slice(b"liga");
        push_u16(&mut feature, 8); // featureOffset
        // FeatureTable @8
        push_u16(&mut feature, 0); // featureParams
        push_u16(&mut feature, feature_lookups.len() as u16);
        for &li in feature_lookups {
            push_u16(&mut feature, li);
        }

        let n = lookups.len();
        let mut ll = Vec::new();
        push_u16(&mut ll, n as u16);
        let mut off = 2 + 2 * n;
        for lk in lookups {
            push_u16(&mut ll, off as u16);
            off += lk.len();
        }
        for lk in lookups {
            ll.extend_from_slice(lk);
        }

        let fl_rel = 10 + script.len();
        let ll_rel = fl_rel + feature.len();
        let mut out = Vec::new();
        push_u16(&mut out, 1); // majorVersion
        push_u16(&mut out, 0); // minorVersion
        push_u16(&mut out, 10); // scriptListOffset
        push_u16(&mut out, fl_rel as u16);
        push_u16(&mut out, ll_rel as u16);
        out.extend_from_slice(&script);
        out.extend_from_slice(&feature);
        out.extend_from_slice(&ll);
        out
    }

    /// 拼一个 Lookup 表体（type + flag=0 + subtableOffsets + subtables）
    fn lookup_body(ltype: u16, subtables: &[Vec<u8>]) -> Vec<u8> {
        let mut lk = Vec::new();
        push_u16(&mut lk, ltype);
        push_u16(&mut lk, 0); // lookupFlag
        push_u16(&mut lk, subtables.len() as u16);
        let mut off = 6 + 2 * subtables.len();
        for st in subtables {
            push_u16(&mut lk, off as u16);
            off += st.len();
        }
        for st in subtables {
            lk.extend_from_slice(st);
        }
        lk
    }

    /// SingleSubst format1 subtable（coverage + delta）
    fn single_subst_fmt1(coverage: &[u16], delta: i16) -> Vec<u8> {
        let mut st = Vec::new();
        push_u16(&mut st, 1); // format
        push_u16(&mut st, 6); // coverageOffset
        push_u16(&mut st, delta as u16);
        push_coverage1(&mut st, coverage);
        st
    }

    /// MultipleSubst format1 subtable（coverage + sequence 数组）
    fn multiple_subst_fmt1(coverage: &[u16], sequences: &[&[u16]]) -> Vec<u8> {
        let mut st = Vec::new();
        let cov_len = 4 + 2 * coverage.len();
        push_u16(&mut st, 1); // format
        push_u16(&mut st, (6 + 2 * sequences.len()) as u16); // coverageOffset
        push_u16(&mut st, sequences.len() as u16);
        // sequence 紧跟 coverage 之后
        let mut off = 6 + 2 * sequences.len() + cov_len;
        for seq in sequences {
            push_u16(&mut st, off as u16); // sequenceOffsets
            off += 2 + 2 * seq.len();
        }
        push_coverage1(&mut st, coverage);
        for &seq in sequences {
            push_u16(&mut st, seq.len() as u16);
            for &g in seq {
                push_u16(&mut st, g);
            }
        }
        st
    }

    /// SinglePos format2 subtable（coverage + valueFormat + valueRecords）
    fn single_pos_fmt2(coverage: &[u16], values: &[u16]) -> Vec<u8> {
        let mut st = Vec::new();
        push_u16(&mut st, 2); // format
        push_u16(&mut st, (8 + 2 * values.len()) as u16); // coverageOffset（coverage 跟在 valueRecords 后）
        push_u16(&mut st, 0x0004); // valueFormat: xAdvance only
        push_u16(&mut st, values.len() as u16);
        for &v in values {
            push_u16(&mut st, v);
        }
        push_coverage1(&mut st, coverage);
        st
    }

    /// write_empty_subtable 的字节（type=2 版）
    fn expected_empty_subtable() -> Vec<u8> {
        let mut st = Vec::new();
        push_u16(&mut st, 1);
        push_u16(&mut st, 6);
        push_u16(&mut st, 0);
        push_u16(&mut st, 1);
        push_u16(&mut st, 0);
        st
    }

    /// 从 sfnt 字体提取表体（测试 fixture 用）
    fn extract_table<'a>(data: &'a [u8], tag: &[u8; 4]) -> Option<&'a [u8]> {
        if data.len() < 12 {
            return None;
        }
        let n = be16(data, 4) as usize;
        for i in 0..n {
            let off = 12 + i * 16;
            if off + 16 > data.len() {
                return None;
            }
            if &data[off..off + 4] == tag {
                let s = u32::from_be_bytes(data[off + 8..off + 12].try_into().unwrap()) as usize;
                let l = u32::from_be_bytes(data[off + 12..off + 16].try_into().unwrap()) as usize;
                if s + l <= data.len() {
                    return Some(&data[s..s + l]);
                }
                return None;
            }
        }
        None
    }

    // ---- Reader / Writer 基础 ----

    #[test]
    fn reader_bounds_and_writer_rollback() {
        let data = [0x12, 0x34, 0xFF, 0xFE, 0x00, 0x00, 0x00, 0x05];
        let r = Reader::new(&data);
        assert_eq!(r.rd16(0), 0x1234);
        assert_eq!(r.rd16s(2), -2);
        assert_eq!(r.rd32(4), 5);
        assert!(!r.error_flag.get());
        assert_eq!(r.rd16(8), 0); // 越界（8+2 > 8）→ 0 + errorFlag
        assert!(r.error_flag.get());
        r.clear_error();
        assert!(!r.error_flag.get());
        assert_eq!(r.raw16(8), 0); // raw 越界 → 0 不置 flag
        assert!(!r.error_flag.get());

        let mut w = Writer::new();
        w.w16(0x0102);
        w.wbytes(&[0xAA, 0xBB]);
        w.w16at(0, 0x0304);
        assert_eq!(&w.list, &[0x03, 0x04, 0xAA, 0xBB]);
        w.rollback(2);
        assert_eq!(w.list, &[0x03, 0x04]);
        assert_eq!(w.len(), 2);
    }

    // ---- Coverage 读写 round-trip / format 选择 ----

    #[test]
    fn emit_coverage_format_choice_and_roundtrip() {
        // [10..=15] 连续 6 个：rangeCount=1，1*6 < 6*2 → format2
        let mut w = Writer::new();
        let off = emit_coverage(&mut w, &[10, 11, 12, 13, 14, 15]);
        assert_eq!(off, 0);
        assert_eq!(be16(&w.list, 0), 2); // format 2
        assert_eq!(be16(&w.list, 2), 1); // rangeCount
        assert_eq!(be16(&w.list, 4), 10);
        assert_eq!(be16(&w.list, 6), 15);
        assert_eq!(be16(&w.list, 8), 0); // startCoverageIndex
        let r = Reader::new(&w.list);
        assert_eq!(read_coverage_gids(&r, 0), vec![10, 11, 12, 13, 14, 15]);

        // [1,2,3] 连续 3 个：1*6 < 3*2 不成立（6<6 假）→ format1（精确字节判据边界）
        let mut w = Writer::new();
        emit_coverage(&mut w, &[1, 2, 3]);
        assert_eq!(be16(&w.list, 0), 1);
        let r = Reader::new(&w.list);
        assert_eq!(read_coverage_gids(&r, 0), vec![1, 2, 3]);

        // 离散数组 → format1
        let mut w = Writer::new();
        emit_coverage(&mut w, &[1, 5, 9]);
        assert_eq!(be16(&w.list, 0), 1);
        let r = Reader::new(&w.list);
        assert_eq!(read_coverage_gids(&r, 0), vec![1, 5, 9]);

        // 空 coverage → format1 + count0
        let mut w = Writer::new();
        emit_coverage(&mut w, &[]);
        assert_eq!(w.list, vec![0, 1, 0, 0]);
    }

    #[test]
    fn coverage_index_of_fmt1_fmt2() {
        // format1
        let mut cov = Vec::new();
        push_coverage1(&mut cov, &[10, 20, 30]);
        let r = Reader::new(&cov);
        assert_eq!(coverage_index_of(&r, 0, 10), 0);
        assert_eq!(coverage_index_of(&r, 0, 20), 1);
        assert_eq!(coverage_index_of(&r, 0, 30), 2);
        assert_eq!(coverage_index_of(&r, 0, 15), -1);
        assert_eq!(coverage_index_of(&r, 0, 5), -1);
        assert_eq!(coverage_index_of(&r, 0, 40), -1);

        // format2：ranges [(5,7),(10,12)]
        let mut cov = Vec::new();
        push_u16(&mut cov, 2);
        push_u16(&mut cov, 2);
        push_u16(&mut cov, 5);
        push_u16(&mut cov, 7);
        push_u16(&mut cov, 0);
        push_u16(&mut cov, 10);
        push_u16(&mut cov, 12);
        push_u16(&mut cov, 3);
        let r = Reader::new(&cov);
        assert_eq!(coverage_index_of(&r, 0, 5), 0);
        assert_eq!(coverage_index_of(&r, 0, 6), 1);
        assert_eq!(coverage_index_of(&r, 0, 7), 2);
        assert_eq!(coverage_index_of(&r, 0, 10), 3);
        assert_eq!(coverage_index_of(&r, 0, 12), 5);
        assert_eq!(coverage_index_of(&r, 0, 8), -1);
        assert_eq!(coverage_index_of(&r, 0, 4), -1);
        assert_eq!(coverage_count(&r, 0), 6);
    }

    // ---- collect_reachable ----

    #[test]
    fn collect_reachable_unsupported_version_returns_empty_vec() {
        // 空 Vec ≠ 错误：版本不支持时退 seed 序
        let mut t = Vec::new();
        push_u16(&mut t, 2); // major=2
        push_u16(&mut t, 0);
        t.extend_from_slice(&[0u8; 16]);
        assert_eq!(collect_reachable(&t, &[1, 2]).unwrap(), Vec::<u16>::new());

        // minor > 1 同样不支持
        let mut t2 = Vec::new();
        push_u16(&mut t2, 1);
        push_u16(&mut t2, 2);
        t2.extend_from_slice(&[0u8; 16]);
        assert_eq!(collect_reachable(&t2, &[1]).unwrap(), Vec::<u16>::new());
    }

    #[test]
    fn collect_reachable_single_subst_chain() {
        // coverage [1,2]，delta +1：1→2→3（3 不在 coverage，闭合）
        let t = build_layout_table(&[0], &[lookup_body(1, &[single_subst_fmt1(&[1, 2], 1)])]);
        assert_eq!(collect_reachable(&t, &[1]).unwrap(), vec![1, 2, 3]);
        // 种子顺序 = 插入序
        assert_eq!(collect_reachable(&t, &[2, 1]).unwrap(), vec![2, 1, 3]);
        // 空种子 → 空 Vec（非错误）
        assert_eq!(collect_reachable(&t, &[]).unwrap(), Vec::<u16>::new());
    }

    // ---- subset_gsub ----

    #[test]
    fn subset_gsub_unsupported_version_passthrough() {
        let mut t = Vec::new();
        push_u16(&mut t, 2);
        push_u16(&mut t, 0);
        t.extend_from_slice(&[0xAB; 16]);
        let out = subset_gsub(&t, &[0, 1]).unwrap();
        assert_eq!(out, t); // 原样返回
    }

    #[test]
    fn subset_gsub_single_subst_identity_keep_is_byte_identical() {
        let t = build_layout_table(&[0], &[lookup_body(1, &[single_subst_fmt1(&[1, 2], 1)])]);
        // keep = [0,1,2,3] 恒等映射：输出应与输入逐字节相同
        let out = subset_gsub(&t, &[0, 1, 2, 3]).unwrap();
        assert_eq!(out, t);
    }

    #[test]
    fn subset_gsub_single_subst_remap_insertion_order() {
        let t = build_layout_table(&[0], &[lookup_body(1, &[single_subst_fmt1(&[1, 2], 1)])]);
        // keep 插入序 [0,5,1,2]：新 gid 5→1, 1→2, 2→3
        // orig1→2 重映射为 2→3（保留）；orig2→3 中 3 不在子集 → 丢弃
        // 剩余 entry (2,3) 统一 delta=1 → format1，coverage [2]
        let mut sub = Vec::new();
        push_u16(&mut sub, 1);
        push_u16(&mut sub, 6);
        push_u16(&mut sub, 1);
        push_coverage1(&mut sub, &[2]);
        let expected = build_layout_table(&[0], &[lookup_body(1, &[sub])]);
        let out = subset_gsub(&t, &[0, 5, 1, 2]).unwrap();
        assert_eq!(out, expected);
    }

    #[test]
    fn subset_gsub_multiple_subst_remap_and_sort() {
        // coverage [1,2]；seq(1)=[3,4]，seq(2)=[5]
        let t = build_layout_table(
            &[0],
            &[lookup_body(2, &[multiple_subst_fmt1(&[1, 2], &[&[3, 4], &[5]])])],
        );
        // keep [0,1,2,3,5]：新 gid 1→1,2→2,3→3,5→4；4 不在子集 → seq(1) 去掉 4
        // entries 排序后：(1,[3]),(2,[4])
        let mut sub = Vec::new();
        push_u16(&mut sub, 1); // format
        push_u16(&mut sub, 10); // coverageOffset（6 + 2*2）
        push_u16(&mut sub, 2); // sequenceCount
        push_u16(&mut sub, 18); // seqOffsets[0]（coverage [1,2] 占 8 字节，seq 紧随其后）
        push_u16(&mut sub, 22); // seqOffsets[1]
        push_coverage1(&mut sub, &[1, 2]); // @10
        push_u16(&mut sub, 1); // seq(1) glyphCount
        push_u16(&mut sub, 3);
        push_u16(&mut sub, 1); // seq(2) glyphCount
        push_u16(&mut sub, 4);
        let expected = build_layout_table(&[0], &[lookup_body(2, &[sub])]);
        let out = subset_gsub(&t, &[0, 1, 2, 3, 5]).unwrap();
        assert_eq!(out, expected);
    }

    #[test]
    fn subset_gsub_all_empty_lookup_folds_to_single_empty_subtable() {
        // coverage [7] 全不在 keep → allEmpty 折叠 subCount=1 空表
        let t = build_layout_table(&[0], &[lookup_body(2, &[multiple_subst_fmt1(&[7], &[&[3, 4]])])]);
        let expected = build_layout_table(&[0], &[lookup_body(2, &[expected_empty_subtable()])]);
        let out = subset_gsub(&t, &[0, 1, 2]).unwrap();
        assert_eq!(out, expected);
    }

    #[test]
    fn subset_gsub_empty_keep_still_valid() {
        let t = build_layout_table(&[0], &[lookup_body(1, &[single_subst_fmt1(&[1, 2], 1)])]);
        let out = subset_gsub(&t, &[]).unwrap();
        // 全空折叠：major=1、lookup 数不变
        assert_eq!(be16(&out, 0), 1);
        let ll = be16(&out, 8) as usize;
        assert_eq!(be16(&out, ll), 1);
    }

    // ---- subset_gpos ----

    #[test]
    fn subset_gpos_unsupported_version_returns_none() {
        let mut t = Vec::new();
        push_u16(&mut t, 2);
        push_u16(&mut t, 0);
        t.extend_from_slice(&[0u8; 16]);
        assert_eq!(subset_gpos(&t, &[0, 1]).unwrap(), None); // None = 透传原始字节
    }

    #[test]
    fn subset_gpos_single_pos_fmt2_remap_and_sort() {
        let t = build_layout_table(&[0], &[lookup_body(1, &[single_pos_fmt2(&[1, 2], &[100, 200])])]);
        // keep 插入序 [0,2,1]：新 gid 2→1, 1→2
        // kept 按 new_gid 升序：new1←orig2(val200@sub+10)、new2←orig1(val100@sub+8)
        let mut sub = Vec::new();
        push_u16(&mut sub, 2); // format
        push_u16(&mut sub, 12); // coverageOffset（8 + 2*2：coverage 跟在 valueRecords 后）
        push_u16(&mut sub, 0x0004); // valueFormat
        push_u16(&mut sub, 2); // valueCount
        push_u16(&mut sub, 200);
        push_u16(&mut sub, 100);
        push_coverage1(&mut sub, &[1, 2]);
        let expected = build_layout_table(&[0], &[lookup_body(1, &[sub])]);
        let out = subset_gpos(&t, &[0, 2, 1]).unwrap().expect("Some");
        assert_eq!(out, expected);
    }

    #[test]
    fn subset_gpos_all_miss_folds_and_none_semantics() {
        // coverage [7] 不在 keep → 全空折叠空 Position subtable
        let t = build_layout_table(&[0], &[lookup_body(1, &[single_pos_fmt2(&[7], &[42])])]);
        let mut sub = Vec::new();
        push_u16(&mut sub, 1); // SinglePos fmt1 形态空表
        push_u16(&mut sub, 6); // coverageOff
        push_u16(&mut sub, 0); // valueFormat = 0
        push_coverage1(&mut sub, &[]);
        let expected = build_layout_table(&[0], &[lookup_body(1, &[sub])]);
        let out = subset_gpos(&t, &[0, 1, 2]).unwrap().expect("Some");
        assert_eq!(out, expected);
    }

    // ---- 真实字体（思源黑体）冒烟 ----

    #[test]
    fn real_font_source_han_gsub_gpos_smoke() {
        // cargo test 工作目录 = rust-spike/（与 ttf::tests 的 TEST_FONT 同一约定）
        let data = std::fs::read("../font/思源黑体.ttf").expect("read font");
        let gsub_tbl = extract_table(&data, b"GSUB").expect("GSUB table");
        // 多组种子（含大 gid）：可达闭包非空且含全部种子（插入序前置）
        for seeds in [&[0u16][..], &[0, 10, 100, 500, 1000][..], &[0, 30000, 60000][..]] {
            let reachable = collect_reachable(gsub_tbl, seeds).unwrap();
            assert!(!reachable.is_empty());
            for &s in seeds {
                assert!(reachable.contains(&s));
            }
            // 种子位于插入序头部（各种子按序出现）
            let mut last = 0usize;
            for &s in seeds {
                let pos = reachable.iter().position(|&g| g == s).unwrap();
                assert!(pos >= last);
                last = pos;
            }
            // 子集化：keep 用可达闭包本身（插入序），输出结构可解析
            let out = subset_gsub(gsub_tbl, &reachable).unwrap();
            assert_eq!(be16(&out, 0), 1); // majorVersion
            assert!(be16(&out, 2) <= 1); // minorVersion
            // ScriptList script 数与原表一致（ScriptList 重建保真）
            assert_eq!(be16(&out, 4) as usize, 10);
            let sl = be16(&out, 4) as usize;
            assert_eq!(be16(&out, sl), be16(gsub_tbl, be16(gsub_tbl, 4) as usize));
            // LookupList lookup 数一致（不删 lookup 红线）
            let ll = be16(&out, 8) as usize;
            let orig_ll = be16(gsub_tbl, 8) as usize;
            assert_eq!(be16(&out, ll), be16(gsub_tbl, orig_ll));

            // 再用小 keep（前 16 个）跑一次小子集路径
            let small = &reachable[..reachable.len().min(16)];
            let out2 = subset_gsub(gsub_tbl, small).unwrap();
            assert_eq!(be16(&out2, 0), 1);
        }

        // GPOS：Ok(Some) 或 Ok(None) 均合法（None = 透传），但不得 Err
        if let Some(gpos_tbl) = extract_table(&data, b"GPOS") {
            let reachable = collect_reachable(gsub_tbl, &[0, 10, 100, 500]).unwrap();
            let keep = if reachable.is_empty() { vec![0u16] } else { reachable };
            let r = subset_gpos(gpos_tbl, &keep);
            assert!(r.is_ok());
            if let Ok(Some(out)) = r {
                assert_eq!(be16(&out, 0), 1);
                assert_eq!(be16(&out, 2), 0); // 版本恒写 1.0
            }
        }
    }
}
