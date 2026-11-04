//! TTF 解析与子集化（零依赖，对译 zig-spike/src/ttf.zig）

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use crate::cff;
use crate::gsub;

/// 解析错误（对译 Zig SubsetError 的 parse 侧子集；NotTtf 对外 422 "not a ttf font"）
#[derive(Debug)]
pub enum ParseError {
    /// 非 TTF/OTF 签名
    NotTtf,
    /// 表目录越界 / cmap 缺失等结构错误
    BadTable,
    /// 无可用 cmap
    NoCmap,
}

/// 子集化错误（对译 Zig error set；除 NotTtf 外的 BadTable/NoCmap/NoGlyphs/OtfUnsupported
/// 统一折叠为 SubsetFailed——对外同为 422 "subset failed"）
#[derive(Debug)]
pub enum SubsetError {
    /// 接口保留（main.rs match 穷尽性）：NotTtf 只从 parse 侧产生，subset 入口的字体已解析通过
    #[allow(dead_code)]
    NotTtf,
    SubsetFailed,
}

/// 大端 u16 读取（越界 panic，对齐 Zig 切片越界 let-it-crash）
fn ru16(b: &[u8], off: usize) -> u16 {
    u16::from_be_bytes([b[off], b[off + 1]])
}

/// 大端 i16 读取（越界 panic，对齐 Zig）
fn ri16(b: &[u8], off: usize) -> i16 {
    i16::from_be_bytes([b[off], b[off + 1]])
}

/// 大端 u32 读取（越界 panic，对齐 Zig）
fn ru32(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// 写大端 u16（对译 ByteList.writeInt(u16)）
fn wb_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// 写大端 i16（对译 ByteList.writeInt(i16)）
fn wb_i16(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// 写大端 u32（对译 ByteList.writeInt(u32)）
fn wb_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// 4 字节对齐补零（对译 ByteList.pad4）
fn pad4(out: &mut Vec<u8>) {
    while out.len() % 4 != 0 {
        out.push(0);
    }
}

/// sfnt 表目录条目
#[derive(Clone, Copy)]
struct TableDir {
    /// 4 字节表标签
    tag: [u8; 4],
    /// 原始 checksum（目录透传用）
    checksum: u32,
    /// 表体在原文件中的偏移
    offset: u32,
    /// 表体字节长度
    length: u32,
}

/// 字体字节本体：两种形态统一 Deref 到 &[u8]，下游读表代码无感
/// - Mapped(mmap)：内核按需分页，只把被触及的表页（cmap/loca/目标字形/GSUB）载入内存，
///   冷启动不再全量读盘，也消除「page cache 一份 + 用户堆一份」的双倍占用
/// - Owned(Vec)：测试/内存中构造的字体
pub enum FontBytes {
    Owned(Vec<u8>),
    Mapped(memmap2::Mmap),
}

impl std::ops::Deref for FontBytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        match self {
            FontBytes::Owned(v) => v,
            FontBytes::Mapped(m) => m,
        }
    }
}

impl From<Vec<u8>> for FontBytes {
    fn from(v: Vec<u8>) -> Self {
        FontBytes::Owned(v)
    }
}

impl From<memmap2::Mmap> for FontBytes {
    fn from(m: memmap2::Mmap) -> Self {
        FontBytes::Mapped(m)
    }
}

/// 解析后的字体（进程级缓存共享，只读；持有数据本体，表目录存偏移）
pub struct Font {
    /// 原始字体字节（mmap 按需分页或内存持有，供表透传/惰性切片）
    pub data: FontBytes,
    /// sfnt 表目录
    tables: Vec<TableDir>,
    /// maxp.numGlyphs
    pub num_glyphs: u16,
    /// head.unitsPerEm（缺省 1000）
    pub units_per_em: u16,
    /// head.indexToLocFormat（0=short 1=long）
    pub index_to_loc_format: u16,
    /// cmap 表内 Unicode 子表（format4/12）的偏移，按 encoding record 顺序。
    /// 惰性化核心：parse 不再展开全量 cmap HashMap，查询单个码点时直接在
    /// mmap 字节上二分查找——解析成本从 O(全部码点) 降到 O(子表数×log n)
    cmap_sub_offsets: Vec<u32>,
    /// gid→码点反向索引（rev_pairs/rev_idx），首次使用时才全量构建：
    /// GSUB 字体的子集请求用不到它，省掉入场费
    rev: OnceLock<(Vec<u32>, Vec<u32>)>,
}

impl Font {
    /// 解析 TTF/OTF（对译 Font.parse；失败返回 Err）。
    /// 拿走字节所有权：Owned 形态下调用方 fs::read 的整文件缓冲直接进 Font；
    /// Mapped 形态下持 mmap，消除整文件堆拷贝
    pub fn parse(data: impl Into<FontBytes>) -> Result<Font, ParseError> {
        let data: FontBytes = data.into();
        if data.len() < 12 {
            return Err(ParseError::NotTtf);
        }
        // 0x00010000 TrueType / 'true'（Mac 真实轮廓） / 'OTTO'（CFF 轮廓 OTF）
        let sig = ru32(&data, 0);
        if sig != 0x00010000 && sig != 0x74727565 && sig != 0x4F54544F {
            return Err(ParseError::NotTtf);
        }
        let num_tables = ru16(&data, 4) as usize;
        if data.len() < 12 + num_tables * 16 {
            return Err(ParseError::BadTable);
        }
        let mut tables = Vec::with_capacity(num_tables);
        for i in 0..num_tables {
            let off = 12 + i * 16;
            tables.push(TableDir {
                tag: data[off..off + 4].try_into().unwrap(),
                checksum: ru32(&data, off + 4),
                offset: ru32(&data, off + 8),
                length: ru32(&data, off + 12),
            });
        }
        let mut f = Font {
            data,
            tables,
            num_glyphs: 0,
            units_per_em: 1000,
            index_to_loc_format: 0,
            cmap_sub_offsets: Vec::new(),
            rev: OnceLock::new(),
        };
        f.num_glyphs = f.read_maxp_glyphs();
        f.index_to_loc_format = f.read_head_loc_format();
        f.units_per_em = f.read_head_upem();
        // 只扫 encoding records 记录 Unicode 子表偏移，不展开条目（惰性化）
        Font::scan_cmap_subs(&f.data, &f.tables, &mut f.cmap_sub_offsets)?;
        Ok(f)
    }

    /// 扫描 cmap 表目录，记录 Unicode 子表（format4/12）偏移；无任何命中报 NoCmap
    fn scan_cmap_subs(data: &[u8], tables: &[TableDir], out: &mut Vec<u32>) -> Result<(), ParseError> {
        let cmap_tbl = find_table_in(data, tables, b"cmap").ok_or(ParseError::NoCmap)?;
        if cmap_tbl.len() < 4 {
            return Err(ParseError::NoCmap);
        }
        let num_sub = ru16(cmap_tbl, 2) as usize;
        for i in 0..num_sub {
            let rec = &cmap_tbl[4 + i * 8..];
            if rec.len() < 8 {
                break;
            }
            let platform = ru16(rec, 0);
            let encoding = ru16(rec, 2);
            let offset = ru32(rec, 4);
            let is_unicode = (platform == 3 && (encoding == 1 || encoding == 10)) || platform == 0;
            if !is_unicode || offset as usize >= cmap_tbl.len() {
                continue;
            }
            let sub = &cmap_tbl[offset as usize..];
            if sub.len() < 2 {
                continue;
            }
            match ru16(sub, 0) {
                4 | 12 => out.push(offset),
                _ => {}
            }
        }
        if out.is_empty() {
            return Err(ParseError::NoCmap);
        }
        Ok(())
    }

    /// 码点 → gid：从最后的子表往前查（多子表合并语义 = 顺序 insert 覆盖，
    /// 最终值 = 最后写入的子表），单个码点在 mmap 字节上二分，零展开
    pub fn cmap_get(&self, cp: u32) -> Option<u16> {
        let cmap_tbl = self.find_table(b"cmap")?;
        for &off in self.cmap_sub_offsets.iter().rev() {
            let sub = &cmap_tbl[off as usize..];
            match cmap_sub_lookup(sub, self.num_glyphs, cp) {
                SubHit::Gid(g) => return Some(g),
                SubHit::Skip => continue,
                SubHit::Miss => continue,
            }
        }
        None
    }

    /// gid 的全部码点（rev 反向索引，首次调用时全量构建并缓存）
    pub fn rev_cps(&self, gid: u16) -> &[u32] {
        let (pairs, idx) = self.rev.get_or_init(|| self.build_rev_index());
        let start = idx[gid as usize] as usize;
        let end = idx[gid as usize + 1] as usize;
        &pairs[start..end]
    }

    /// 全量展开 cmap 建反向索引：计数排序（计数入前缀和 + 填充）。
    /// 仅无 GSUB 路径子集 / glyph-match 等需要 gid→码点全量反查时才付这一次成本
    fn build_rev_index(&self) -> (Vec<u32>, Vec<u32>) {
        let mut cmap: HashMap<u32, u16> = HashMap::new();
        let cmap_tbl = self.find_table(b"cmap").unwrap_or(&[]);
        for &off in &self.cmap_sub_offsets {
            let sub = &cmap_tbl[off as usize..];
            match ru16(sub, 0) {
                4 => parse_cmap4(sub, self.num_glyphs, &mut cmap),
                12 => parse_cmap12(sub, self.num_glyphs, &mut cmap),
                _ => {}
            }
        }
        let mut idx = vec![0u32; self.num_glyphs as usize + 1];
        for &gid in cmap.values() {
            idx[gid as usize + 1] += 1;
        }
        for i in 1..idx.len() {
            idx[i] += idx[i - 1];
        }
        let mut pairs = vec![0u32; cmap.len()];
        let mut cursor = idx.clone();
        for (&cp, &gid) in cmap.iter() {
            pairs[cursor[gid as usize] as usize] = cp;
            cursor[gid as usize] += 1;
        }
        (pairs, idx)
    }

    /// 查表体切片（越界表按缺失处理，对译 findTable）
    fn find_table(&self, tag: &[u8; 4]) -> Option<&[u8]> {
        for t in &self.tables {
            if &t.tag == tag {
                let end = t.offset as usize + t.length as usize;
                if end <= self.data.len() {
                    return Some(&self.data[t.offset as usize..end]);
                }
            }
        }
        None
    }

    /// 是否存在指定表（OTF 无 glyf，glyph-match 用此判 CFF 轮廓字体）
    pub fn has_table(&self, tag: &[u8; 4]) -> bool {
        self.find_table(tag).is_some()
    }

    /// 码点 → gid 查询（cmap 访问入口，glyph-match 用）
    #[allow(dead_code)] // R5' glyph-match 接入前未用
    pub fn glyph_id(&self, cp: u32) -> Option<u16> {
        self.cmap_get(cp)
    }

    fn read_maxp_glyphs(&self) -> u16 {
        let maxp = match self.find_table(b"maxp") {
            Some(t) => t,
            None => return 0,
        };
        if maxp.len() < 6 {
            return 0;
        }
        ru16(maxp, 4)
    }

    fn read_head_upem(&self) -> u16 {
        let head = match self.find_table(b"head") {
            Some(t) => t,
            None => return 1000,
        };
        if head.len() < 18 {
            return 1000;
        }
        ru16(head, 18)
    }

    fn read_head_loc_format(&self) -> u16 {
        let head = match self.find_table(b"head") {
            Some(t) => t,
            None => return 0,
        };
        if head.len() < 52 {
            return 0;
        }
        ru16(head, 50)
    }

    /// gid 的 loca 原始区间（无则是空字形）
    fn loca_range(&self, gid: u16) -> Option<(u32, u32)> {
        let loca = self.find_table(b"loca")?;
        let g = gid as usize;
        if self.index_to_loc_format == 0 {
            if loca.len() < (g + 2) * 2 {
                return None;
            }
            // u16 读出后乘 2 在 u32 域进行（locaRange u16 溢出修复语义）
            let start = ru16(loca, g * 2) as u32 * 2;
            let end = ru16(loca, (g + 1) * 2) as u32 * 2;
            return Some((start, end));
        }
        if loca.len() < (g + 2) * 4 {
            return None;
        }
        Some((ru32(loca, g * 4), ru32(loca, (g + 1) * 4)))
    }

    /// 复合字形递归收集引用分量（防环）
    fn collect_components(&self, gid: u16, glyf: &[u8], out: &mut Vec<u16>) {
        let Some((start, end)) = self.loca_range(gid) else {
            return;
        };
        if end <= start || end as usize > glyf.len() {
            return;
        }
        let gdata = &glyf[start as usize..end as usize];
        if gdata.len() < 2 {
            return;
        }
        let nc = ri16(gdata, 0);
        if nc >= 0 || gdata.len() < 10 {
            return;
        }
        let mut off = 10usize;
        while off + 4 <= gdata.len() {
            let flags_raw = ru16(gdata, off);
            let comp_gid = ru16(gdata, off + 2);
            let dup = out.iter().any(|&x| x == comp_gid);
            if !dup && comp_gid != gid && comp_gid < self.num_glyphs {
                out.push(comp_gid);
                self.collect_components(comp_gid, glyf, out);
            }
            off += 4;
            // ARG_1_AND_2_ARE_WORDS
            off += if flags_raw & 0x0001 != 0 { 4 } else { 2 };
            if flags_raw & 0x0008 != 0 {
                off += 2; // WE_HAVE_A_SCALE
            }
            if flags_raw & 0x0040 != 0 {
                off += 4; // WE_HAVE_AN_X_AND_Y_SCALE
            }
            if flags_raw & 0x0080 != 0 {
                off += 8; // WE_HAVE_A_TWO_BY_TWO
            }
            // MORE_COMPONENTS
            if flags_raw & 0x0020 == 0 {
                break;
            }
        }
    }

    /// 文本涉及的 gid 集（gid 0 始终保留，升序）。
    /// 去重用定长位图（O(1) 判重，替代 Vec::contains 的 O(n)——长文本时平方复杂度）
    pub fn collect_gids(&self, text: &str) -> Result<Vec<u16>, SubsetError> {
        let mut gids: Vec<u16> = vec![0];
        let mut seen = vec![false; self.num_glyphs as usize + 1];
        seen[0] = true;
        let glyf = self.find_table(b"glyf");
        for ch in text.chars() {
            let cp = ch as u32;
            if let Some(gid) = self.cmap_get(cp) {
                if !seen[gid as usize] {
                    seen[gid as usize] = true;
                    gids.push(gid);
                }
                if let Some(g) = glyf {
                    let mut tmp = Vec::new();
                    self.collect_components(gid, g, &mut tmp);
                    for cg in tmp {
                        if !gids.contains(&cg) {
                            gids.push(cg);
                        }
                    }
                }
            }
        }
        if gids.len() <= 1 {
            return Err(SubsetError::SubsetFailed); // NoGlyphs
        }
        gids.sort_unstable();
        Ok(gids)
    }

    /// 种子 gid（TS probe 语义）：gid 0 + 文本码点首次出现序的 cmap gid。
    /// 不排序——插入序决定 TS subsetGids 追加顺序即新 gid 编号，是 GSUB 对拍的前提。
    /// 去重用位图（O(1) 判重，见 collect_gids）
    fn seed_gids(&self, text: &str) -> Vec<u16> {
        let mut seeds: Vec<u16> = vec![0];
        let mut seen_gid = vec![false; self.num_glyphs as usize + 1];
        seen_gid[0] = true;
        let mut seen_cp: HashSet<u32> = HashSet::new();
        for ch in text.chars() {
            let cp = ch as u32;
            if !seen_cp.insert(cp) {
                continue;
            }
            if let Some(gid) = self.cmap_get(cp) {
                if !seen_gid[gid as usize] {
                    seen_gid[gid as usize] = true;
                    seeds.push(gid);
                }
            }
        }
        seeds
    }
}

/// 单个子表内单码点查找结果（对齐全量展开时的 insert 语义）
enum SubHit {
    /// 命中且该子表展开时会 insert 此值（format12 含 gid=0）
    Gid(u16),
    /// 该子表对此 cp 不会 insert（format4 映射到 0 / ro 奇数跳过），
    /// 不覆盖先前子表的值 → 继续往前查
    Skip,
    /// 此 cp 不在该子表任何段内
    Miss,
}

/// format4/12 子表单码点查找：段/groups 二分，零展开。
/// 逐 cp 精确复刻 parse_cmap4/parse_cmap12 的插入条件，保证产物字节不变
fn cmap_sub_lookup(sub: &[u8], num_glyphs: u16, cp: u32) -> SubHit {
    if sub.len() < 2 {
        return SubHit::Miss;
    }
    match ru16(sub, 0) {
        4 => cmap4_lookup(sub, num_glyphs, cp),
        12 => cmap12_lookup(sub, num_glyphs, cp),
        _ => SubHit::Miss,
    }
}

/// format4：endCode 有序 → 二分找第一个 end>=cp 的段，再按原展开逻辑判定
fn cmap4_lookup(sub: &[u8], num_glyphs: u16, cp: u32) -> SubHit {
    if sub.len() < 14 || cp > 0xFFFF {
        return SubHit::Miss;
    }
    let seg_count = ru16(sub, 6) as usize / 2;
    if seg_count == 0 {
        return SubHit::Miss;
    }
    let seg_end_off = 14usize;
    let seg_start_off = seg_end_off + seg_count * 2 + 2;
    let delta_off = seg_start_off + seg_count * 2;
    let range_off = delta_off + seg_count * 2;
    if sub.len() < range_off + seg_count * 2 {
        return SubHit::Miss;
    }
    // endCode 数组有序，二分第一个 end >= cp
    let mut lo = 0usize;
    let mut hi = seg_count;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if ru16(sub, seg_end_off + mid * 2) < cp as u16 {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo >= seg_count {
        return SubHit::Miss;
    }
    let seg = lo;
    let end_cp = ru16(sub, seg_end_off + seg * 2) as u32;
    let start_cp = ru16(sub, seg_start_off + seg * 2) as u32;
    if cp < start_cp || cp > end_cp {
        return SubHit::Miss; // gap 段，原展开同样不 insert
    }
    let delta = ru16(sub, delta_off + seg * 2);
    let ro = ru16(sub, range_off + seg * 2);
    // 罕见奇数 idRangeOffset，原展开跳过（不 insert）
    if ro % 2 == 1 {
        return SubHit::Skip;
    }
    let gid: u16 = if ro == 0 {
        (cp.wrapping_add(delta as u32)) as u16
    } else {
        let gid_off = range_off + seg * 2 + ro as usize + (cp - start_cp) as usize * 2;
        if gid_off + 2 > sub.len() {
            return SubHit::Skip;
        }
        let g = ru16(sub, gid_off);
        if g == 0 {
            return SubHit::Skip;
        }
        (g.wrapping_add(delta)) as u16
    };
    if gid != 0 && gid < num_glyphs {
        SubHit::Gid(gid)
    } else {
        SubHit::Skip
    }
}

/// format12：groups 按 startCode 有序 → 二分定位 group，直接算 gid
fn cmap12_lookup(sub: &[u8], num_glyphs: u16, cp: u32) -> SubHit {
    if sub.len() < 16 {
        return SubHit::Miss;
    }
    let num_groups = ru32(sub, 12) as usize;
    let mut lo = 0usize;
    let mut hi = num_groups;
    while lo < hi {
        let mid = (lo + hi) / 2;
        let base = 16 + mid * 12;
        if base + 12 > sub.len() {
            hi = mid;
            continue;
        }
        if ru32(sub, base + 4) < cp {
            // endCode < cp，目标在右侧
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo >= num_groups {
        return SubHit::Miss;
    }
    let base = 16 + lo * 12;
    if base + 12 > sub.len() {
        return SubHit::Miss;
    }
    let start_cp = ru32(sub, base);
    let end_cp = ru32(sub, base + 4);
    let start_gid = ru32(sub, base + 8);
    if cp < start_cp || cp > end_cp {
        return SubHit::Miss;
    }
    let gid = start_gid + (cp - start_cp);
    if gid < num_glyphs as u32 {
        // 原展开对 gid=0 也 insert（覆盖语义），命中即返回
        SubHit::Gid(gid as u16)
    } else {
        SubHit::Skip
    }
}

/// 查表体切片（parse 阶段的自由函数版本，data 尚未被 Font 持有时使用）
fn find_table_in<'a>(data: &'a [u8], tables: &[TableDir], tag: &[u8; 4]) -> Option<&'a [u8]> {
    for t in tables {
        if &t.tag == tag {
            let end = t.offset as usize + t.length as usize;
            if end <= data.len() {
                return Some(&data[t.offset as usize..end]);
            }
        }
    }
    None
}

/// cmap format4 子表解析（对译 parseCmap4）
fn parse_cmap4(sub: &[u8], num_glyphs: u16, cmap: &mut HashMap<u32, u16>) {
    if sub.len() < 14 {
        return;
    }
    let seg_count = ru16(sub, 6) as usize / 2;
    let seg_end_off = 14usize;
    let seg_start_off = seg_end_off + seg_count * 2 + 2;
    let delta_off = seg_start_off + seg_count * 2;
    let range_off = delta_off + seg_count * 2;
    if sub.len() < range_off + seg_count * 2 {
        return;
    }
    for seg in 0..seg_count {
        let end_cp = ru16(sub, seg_end_off + seg * 2);
        let start_cp = ru16(sub, seg_start_off + seg * 2);
        let delta = ru16(sub, delta_off + seg * 2);
        let ro = ru16(sub, range_off + seg * 2);
        let mut cp: u32 = start_cp as u32;
        while cp <= end_cp as u32 {
            let mut do_break = false;
            'seg: {
                // 罕见奇数 idRangeOffset，跳过
                if ro % 2 == 1 {
                    break 'seg;
                }
                let gid: u16 = if ro == 0 {
                    // @truncate(u32 加法) 取低 16 位（对齐 Zig @truncate(@as(u32,cp) +% delta)）
                    (cp.wrapping_add(delta as u32)) as u16
                } else {
                    let gid_off = range_off + seg * 2 + ro as usize + (cp - start_cp as u32) as usize * 2;
                    if gid_off + 2 > sub.len() {
                        if cp == 0xFFFF {
                            do_break = true;
                        }
                        break 'seg;
                    }
                    let g = ru16(sub, gid_off);
                    if g == 0 {
                        if cp == 0xFFFF {
                            do_break = true;
                        }
                        break 'seg;
                    }
                    (g.wrapping_add(delta)) as u16
                };
                if gid != 0 && gid < num_glyphs {
                    cmap.insert(cp, gid);
                }
                if cp == 0xFFFF {
                    do_break = true;
                }
            }
            if do_break {
                break;
            }
            cp += 1;
        }
    }
}

/// cmap format12 子表解析（对译 parseCmap12）
fn parse_cmap12(sub: &[u8], num_glyphs: u16, cmap: &mut HashMap<u32, u16>) {
    if sub.len() < 16 {
        return;
    }
    let num_groups = ru32(sub, 12);
    for g in 0..num_groups as usize {
        let rec = &sub[16 + g * 12..];
        if rec.len() < 12 {
            break;
        }
        let start_cp = ru32(rec, 0);
        let end_cp = ru32(rec, 4);
        let start_gid = ru32(rec, 8);
        let mut cp = start_cp;
        while cp <= end_cp {
            let gid = start_gid + (cp - start_cp);
            if gid < num_glyphs as u32 {
                // @truncate(u32→u16) 取低 16 位
                cmap.insert(cp, gid as u16);
            }
            if cp == 0x10FFFF {
                break;
            }
            cp += 1;
        }
    }
}

/// 简单字形轮廓点（绝对坐标）
#[derive(Clone, Copy, Debug)]
pub struct GlyfPt {
    /// X 绝对坐标（font units）
    pub x: i32,
    /// Y 绝对坐标（font units）
    pub y: i32,
    /// 是否 on-curve 点
    pub on_curve: bool,
}

/// 解析原字体 simple glyph 的绝对坐标点（按 contour 分组；语义对齐 fonteditor parseSimpleGlyf）
fn parse_simple_glyph(font: &Font, gid: u16) -> Option<Vec<Vec<GlyfPt>>> {
    let glyf = font.find_table(b"glyf")?;
    let (start, end) = font.loca_range(gid)?;
    if end <= start || end as usize > glyf.len() {
        return None;
    }
    let g = &glyf[start as usize..end as usize];
    if g.len() < 10 {
        return None;
    }
    // nc 为负属损坏数据：Zig @intCast(i16 负数 → usize) 在 ReleaseFast 下为巨正值随后被
    // 长度检查拦下；此处提前判负走同一 None 出口，合法字体行为一致
    let nc_raw = ri16(g, 0);
    if nc_raw < 1 {
        return None;
    }
    let nc = nc_raw as usize;
    if 10 + nc * 2 > g.len() {
        return None;
    }
    let mut end_pts: Vec<u16> = Vec::with_capacity(nc);
    let mut total: usize = 0;
    for i in 0..nc {
        let ep = ru16(g, 10 + i * 2);
        if ep as usize + 1 > total {
            total = ep as usize + 1;
        }
        end_pts.push(ep);
    }
    // 跳过 instructions
    if 12 + nc * 2 + 2 > g.len() {
        return None;
    }
    let instr_len = ru16(g, 10 + nc * 2) as usize;
    let mut p = 12 + nc * 2 + instr_len;
    // flags（含 REPEAT 展开）
    let mut flags: Vec<u8> = Vec::with_capacity(total);
    while flags.len() < total {
        if p >= g.len() {
            return None;
        }
        let flag = g[p];
        p += 1;
        flags.push(flag);
        if flag & 0x08 != 0 && flags.len() < total {
            // REPEAT
            if p >= g.len() {
                return None;
            }
            let rep = g[p] as usize;
            p += 1;
            for _ in 0..rep {
                if flags.len() >= total {
                    break;
                }
                flags.push(flag);
            }
        }
    }
    // 绝对坐标（delta 累加）
    let mut xs: Vec<i32> = Vec::with_capacity(total);
    let mut px: i32 = 0;
    for &fl in &flags {
        let mut dx: i32 = 0;
        if fl & 0x02 != 0 {
            // XSHORT
            if p >= g.len() {
                return None;
            }
            dx = g[p] as i32;
            p += 1;
            // XSAME=正
            if fl & 0x10 == 0 {
                dx = -dx;
            }
        } else if fl & 0x10 == 0 {
            // 非 XSHORT 且非 XSAME：16 位
            if p + 2 > g.len() {
                return None;
            }
            dx = ri16(g, p) as i32;
            p += 2;
        }
        px += dx;
        xs.push(px);
    }
    let mut ys: Vec<i32> = Vec::with_capacity(total);
    let mut py: i32 = 0;
    for &fl in &flags {
        let mut dy: i32 = 0;
        if fl & 0x04 != 0 {
            // YSHORT
            if p >= g.len() {
                return None;
            }
            dy = g[p] as i32;
            p += 1;
            // YSAME=正
            if fl & 0x20 == 0 {
                dy = -dy;
            }
        } else if fl & 0x20 == 0 {
            if p + 2 > g.len() {
                return None;
            }
            dy = ri16(g, p) as i32;
            p += 2;
        }
        py += dy;
        ys.push(py);
    }
    // 按 contour 分组
    let mut contours: Vec<Vec<GlyfPt>> = Vec::new();
    let mut start = 0usize;
    for &ep in &end_pts {
        let end = ep as usize;
        if end < start || end >= total {
            break;
        }
        let pts: Vec<GlyfPt> = (start..=end)
            .map(|k| GlyfPt {
                x: xs[k],
                y: ys[k],
                on_curve: flags[k] & 0x01 != 0,
            })
            .collect();
        contours.push(pts);
        start = end + 1;
    }
    Some(contours)
}

/// 解析 gid 的轮廓（simple 直接解析；compound 递归内联）。
/// 语义对齐 fonteditor transformGlyfContours：
/// - 矩阵 F2DOT14 解码 raw/16384，行向量应用 px = x*a + y*c + e、py = x*b + y*d + f
/// - 舍入 (v + 0.5) | 0（向零截断）
/// - 点匹配型 component（非 ARGS_ARE_XY_VALUES）TS 侧按 e=f=0 处理并忽略匹配点，此处一致
pub fn glyph_contours(font: &Font, gid: u16, depth: u8) -> Result<Vec<Vec<GlyfPt>>, SubsetError> {
    // 防环（合法字体嵌套深度远小于此）
    if depth > 8 {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    let empty = Vec::new();
    let glyf = match font.find_table(b"glyf") {
        Some(g) => g,
        None => return Err(SubsetError::SubsetFailed), // BadTable
    };
    let Some((start, end)) = font.loca_range(gid) else {
        return Ok(empty);
    };
    if end <= start || end as usize > glyf.len() {
        return Ok(empty);
    }
    let g = &glyf[start as usize..end as usize];
    if g.len() < 10 {
        return Ok(empty);
    }
    let nc = ri16(g, 0);
    if nc >= 0 {
        return Ok(parse_simple_glyph(font, gid).unwrap_or_default());
    }
    // compound：逐 component 解析 + 变换
    let mut out: Vec<Vec<GlyfPt>> = Vec::new();
    let mut off = 10usize;
    loop {
        if off + 4 > g.len() {
            break;
        }
        let flags = ru16(g, off);
        let comp_gid = ru16(g, off + 2);
        off += 4;
        let arg1: i32;
        let arg2: i32;
        if flags & 0x0001 != 0 {
            // ARG_1_AND_2_ARE_WORDS
            if off + 4 > g.len() {
                break;
            }
            arg1 = ri16(g, off) as i32;
            arg2 = ri16(g, off + 2) as i32;
            off += 4;
        } else {
            if off + 2 > g.len() {
                break;
            }
            // u8 → i8 位重解释（对齐 Zig @bitCast）
            arg1 = (g[off] as i8) as i32;
            arg2 = (g[off + 1] as i8) as i32;
            off += 2;
        }
        let mut sa: f64 = 1.0;
        let mut sb: f64 = 0.0;
        let mut sc: f64 = 0.0;
        let mut sd: f64 = 1.0;
        if flags & 0x0008 != 0 {
            // WE_HAVE_A_SCALE
            if off + 2 > g.len() {
                break;
            }
            sa = ri16(g, off) as f64 / 16384.0;
            sd = sa;
            off += 2;
        } else if flags & 0x0040 != 0 {
            // WE_HAVE_AN_X_AND_Y_SCALE
            if off + 4 > g.len() {
                break;
            }
            sa = ri16(g, off) as f64 / 16384.0;
            sd = ri16(g, off + 2) as f64 / 16384.0;
            off += 4;
        } else if flags & 0x0080 != 0 {
            // WE_HAVE_A_TWO_BY_TWO
            if off + 8 > g.len() {
                break;
            }
            sa = ri16(g, off) as f64 / 16384.0;
            sb = ri16(g, off + 2) as f64 / 16384.0;
            sc = ri16(g, off + 4) as f64 / 16384.0;
            sd = ri16(g, off + 6) as f64 / 16384.0;
            off += 8;
        }
        // 非 XY 值（点匹配）：与 TS 一致按 e=f=0 变换（忽略匹配点语义，罕见）
        let te: f64 = if flags & 0x0002 != 0 { arg1 as f64 } else { 0.0 };
        let tf: f64 = if flags & 0x0002 != 0 { arg2 as f64 } else { 0.0 };
        let comp_contours = glyph_contours(font, comp_gid, depth + 1)?;
        for src in comp_contours {
            let pts: Vec<GlyfPt> = src
                .iter()
                .map(|pt| {
                    let fx = pt.x as f64;
                    let fy = pt.y as f64;
                    // @intFromFloat(@trunc(v + 0.5))：向零截断舍入
                    GlyfPt {
                        x: (fx * sa + fy * sc + te + 0.5).trunc() as i32,
                        y: (fx * sb + fy * sd + tf + 0.5).trunc() as i32,
                        on_curve: pt.on_curve,
                    }
                })
                .collect();
            out.push(pts);
        }
        // MORE_COMPONENTS
        if flags & 0x0020 == 0 {
            break;
        }
    }
    Ok(out)
}

/// 将点集写出为合法 simple glyph 字节（instruction 剥离，delta 短编码，无 REPEAT）
fn write_simple_glyph(out: &mut Vec<u8>, contours: &[Vec<GlyfPt>]) {
    let mut total: usize = 0;
    let mut x_min: i32 = i32::MAX;
    let mut y_min: i32 = i32::MAX;
    let mut x_max: i32 = i32::MIN;
    let mut y_max: i32 = i32::MIN;
    for c in contours {
        for pt in c {
            total += 1;
            if pt.x < x_min {
                x_min = pt.x;
            }
            if pt.y < y_min {
                y_min = pt.y;
            }
            if pt.x > x_max {
                x_max = pt.x;
            }
            if pt.y > y_max {
                y_max = pt.y;
            }
        }
    }
    if total == 0 {
        // 全空（罕见）：写零轮廓 header
        for _ in 0..5 {
            wb_i16(out, 0);
        }
        return;
    }
    // @intCast(i32→i16)：合法字形 bbox/contour 数均在 i16 域，超界同 Zig ReleaseFast 截断
    wb_i16(out, contours.len() as i16);
    wb_i16(out, x_min as i16);
    wb_i16(out, y_min as i16);
    wb_i16(out, x_max as i16);
    wb_i16(out, y_max as i16);
    // endPtsOfContours
    let mut acc: u16 = 0;
    for c in contours {
        acc = acc.wrapping_add(c.len() as u16);
        wb_u16(out, acc - 1);
    }
    wb_u16(out, 0); // instructionLength = 0（hinting 剥离）

    // flags：短编码，无 REPEAT
    let mut pts_flat: Vec<GlyfPt> = Vec::with_capacity(total);
    for c in contours {
        pts_flat.extend_from_slice(c);
    }
    let mut flags_buf: Vec<u8> = Vec::with_capacity(total);
    let mut prev_x: i32 = 0;
    let mut prev_y: i32 = 0;
    for pt in &pts_flat {
        let dx = pt.x - prev_x;
        let dy = pt.y - prev_y;
        let mut fl: u8 = if pt.on_curve { 0x01 } else { 0 };
        if dx == 0 {
            fl |= 0x10; // XSAME（16 位零增量）
        } else if dx > 0 && dx <= 255 {
            fl |= 0x02 | 0x10; // XSHORT 正
        } else if dx < 0 && -dx <= 255 {
            fl |= 0x02; // XSHORT 负
        }
        if dy == 0 {
            fl |= 0x20;
        } else if dy > 0 && dy <= 255 {
            fl |= 0x04 | 0x20; // YSHORT 正
        } else if dy < 0 && -dy <= 255 {
            fl |= 0x04; // YSHORT 负
        }
        flags_buf.push(fl);
        prev_x = pt.x;
        prev_y = pt.y;
    }
    for &fl in &flags_buf {
        out.push(fl);
    }
    // x deltas
    prev_x = 0;
    for (i, pt) in pts_flat.iter().enumerate() {
        let fl = flags_buf[i];
        let dx = pt.x - prev_x;
        if fl & 0x02 != 0 {
            out.push(dx.unsigned_abs() as u8);
        } else if fl & 0x10 == 0 {
            // @intCast(i32→i16)：短编码未命中的 |dx| 必 ≤32767（合法字形），超界同 ReleaseFast 截断
            wb_i16(out, dx as i16);
        }
        prev_x = pt.x;
    }
    // y deltas
    prev_y = 0;
    for (i, pt) in pts_flat.iter().enumerate() {
        let fl = flags_buf[i];
        let dy = pt.y - prev_y;
        if fl & 0x04 != 0 {
            out.push(dy.unsigned_abs() as u8);
        } else if fl & 0x20 == 0 {
            wb_i16(out, dy as i16);
        }
        prev_y = pt.y;
    }
}

/// 码点→新 gid 对
#[derive(Clone, Copy)]
struct CpPair {
    /// 码点
    cp: u32,
    /// 子集后的新 gid
    gid: u16,
}

/// BLUE_ZONE_ANCHORS_MINIMAL 32 锚定码点（TS font.ts，blue zone 校准字符集）
const ANCHOR_CODEPOINTS: &str = "\u{4ED6}\u{4EEC}\u{4F60}\u{4F86}\u{5011}\u{5230}\u{548C}\u{5730}\u{5BF9}\u{5C0D}\u{5C31}\u{5E2D}\u{6211}\u{65F6}\u{6642}\u{6703}\u{6765}\u{70BA}\u{80FD}\u{8230}\u{8AAA}\u{8BF4}\u{8FD9}\u{9019}\u{9F4A}\u{519B}\u{8FD8}\u{8FDB}\u{9032}\u{904E}\u{9053}\u{9084}";

/// 判断文本是否含 CJK 码点（对齐 TS font.ts hasCJK：2e80-9fff / 3400-4dbf / f900-faff）
fn has_cjk(text: &str) -> bool {
    for ch in text.chars() {
        let cp = ch as u32;
        if (0x2e80..=0x9fff).contains(&cp) || (0x3400..=0x4dbf).contains(&cp) || (0xf900..=0xfaff).contains(&cp) {
            return true;
        }
    }
    false
}

/// 唯一码点数（对齐 TS [...new Set(textToCodePoints(s))]：重复字符只计一次）
fn unique_cp_count(text: &str) -> usize {
    let mut seen: HashSet<u32> = HashSet::new();
    for ch in text.chars() {
        seen.insert(ch as u32);
    }
    seen.len()
}

/// P1 锚定字注入：唯一码点 <32 且含 CJK 时在文本尾部追加 32 锚定字
/// （对齐 TS injectBlueZoneAnchors：Set 追加语义，首现序不变；字体中不存在的码点被子集管线自然忽略）
/// 返回 None 表示无需注入（原文本继续使用）
fn maybe_inject_anchors(text: &str) -> Option<String> {
    if unique_cp_count(text) >= 32 {
        return None;
    }
    if !has_cjk(text) {
        return None;
    }
    let mut s = String::with_capacity(text.len() + ANCHOR_CODEPOINTS.len());
    s.push_str(text);
    s.push_str(ANCHOR_CODEPOINTS);
    Some(s)
}

/// 简单可靠子集化：重写 glyf/loca/cmap/maxp，其余表原样透传（head 强制 short loca）。
/// font 为外部预解析结果（可跨请求缓存），本函数只读。输出 ttf 字节。
/// gid→新 gid 哨兵数组映射（替代 HashMap&lt;u16,u16&gt;；MISS 用 u16::MAX）
struct GidMap {
    inner: Vec<u16>,
}

impl GidMap {
    /// 构建：单次 memset + keep 线性写（keep 内不得含重复 old gid，由调用方保证）
    fn build(keep: &[u16], num_glyphs: u16) -> GidMap {
        let mut inner = vec![u16::MAX; num_glyphs.max(keep.iter().copied().max().unwrap_or(0)) as usize + 1];
        for (new, &old) in keep.iter().enumerate() {
            inner[old as usize] = new as u16;
        }
        GidMap { inner }
    }

    /// 查 old gid 的新编号；不在子集返回 None
    fn get(&self, old: u16) -> Option<u16> {
        let v = *self.inner.get(old as usize)?;
        if v == u16::MAX { None } else { Some(v) }
    }
}

pub fn subset(font: &Font, text_in: &str) -> Result<Vec<u8>, SubsetError> {
    // ===== P1 锚定字注入（对齐 TS font.ts fontSubsetToObject 入口语义）=====
    let injected: Option<String> = maybe_inject_anchors(text_in);
    let text: &str = match &injected {
        Some(b) => b,
        None => text_in,
    };
    // ===== CFF 轮廓 OTF：走 subsetOTF 组装路径（不写 glyf/loca，改写 CFF）=====
    if ru32(&font.data, 0) == 0x4F54544F {
        return subset_otf(font, text);
    }
    // ===== GSUB 路径：可达闭包并入 keep，keep 用 TS 插入序（0 + 码点出现序 + 可达序）=====
    // TS 语义：subsetGids 不排序，插入序即新 gid 编号；GSUB 重映射依赖该编号，故此路径不排序。
    let gsub_tbl = font.find_table(b"GSUB");
    let use_gsub = gsub_tbl.is_some_and(|t| t.len() >= 10);
    let keep: Vec<u16>;
    let mut gsub_out: Option<Vec<u8>> = None;
    let mut gpos_out: Option<Vec<u8>> = None;
    if use_gsub {
        let gt = gsub_tbl.unwrap();
        let seeds = font.seed_gids(text);
        // 可达闭包（插入序含种子）；版本不支持时 collect_reachable 返回空，退回种子序
        //（TS：extraSubsetGids=[]）
        let reachable = gsub::collect_reachable(gt, &seeds).map_err(|_| SubsetError::SubsetFailed)?;
        let keep_list: Vec<u16> = if !reachable.is_empty() {
            reachable
        } else {
            seeds
        };
        // compound 字形不追加组件 gid：TS 侧 compound2simpleglyf 将组件轮廓内联进父字形，
        // subsetGids = 0 + 码点序种子 + reachable 插入序（组件内联在 glyf 写出阶段处理）
        if keep_list.len() <= 1 {
            return Err(SubsetError::SubsetFailed); // NoGlyphs
        }
        gsub_out = Some(gsub::subset_gsub(gt, &keep_list).map_err(|_| SubsetError::SubsetFailed)?);
        // GPOS 子集化（同一 keep 插入序重映射）；None（版本不支持/解析异常）时保留原始字节透传，
        // 与 TS rewriteLayoutTablesForSubset 的 rewritten===null 分支语义一致
        if let Some(gpos_tbl) = font.find_table(b"GPOS") {
            if gpos_tbl.len() >= 10 {
                if let Ok(Some(gp)) = gsub::subset_gpos(gpos_tbl, &keep_list) {
                    gpos_out = Some(gp);
                }
            }
        }
        keep = keep_list;
    } else {
        // 无 GSUB：原有路径（排序升序，保持既有产物字节不变）
        keep = font.collect_gids(text)?;
    }
    // gid→新 gid 映射：哨兵数组替代 HashMap（u16 键用 SipHash 纯开销；
    // 对齐 Zig 版 Int32Array gid_lookup 经验：构建是单次 memset+线性写，查询 O(1) 无 hash）
    let gid_map = GidMap::build(&keep, font.num_glyphs);

    let glyf = font.find_table(b"glyf").ok_or(SubsetError::SubsetFailed)?; // BadTable
    // 预分配：按平均字形大小估计输出上界（消除 128 字形逐个 extend 的倍增 realloc 搬移；
    // 实测零预分配时单次 subset 62 次 realloc 搬移 730KB，是 libc memcpy 热点主源）
    let avg_glyph = {
        let g = font.find_table(b"glyf").map(|t| t.len()).unwrap_or(0) as usize;
        let n = font.num_glyphs.max(1) as usize;
        (g / n).max(16)
    };
    let mut new_glyf: Vec<u8> = Vec::with_capacity(keep.len() * avg_glyph);
    let mut new_loca: Vec<u32> = Vec::with_capacity(keep.len() + 1);

    // 码点→新gid，按码点排序。
    // GSUB 路径：仅请求的码点（TS 语义：cmap 不含同 gid 的未请求码点）；
    // 无 GSUB 路径：保持既有 rev_pairs 全量码点行为（产物字节不变回归红线）
    let mut cp_pairs: Vec<CpPair> = Vec::new();
    if gsub_out.is_some() {
        // 重复码点不去重收集（同 cp 必同 gid），sort 后统一 dedup——省一个 HashSet
        for ch in text.chars() {
            let cp = ch as u32;
            let Some(old_gid) = font.cmap_get(cp) else {
                continue;
            };
            let Some(new_gid) = gid_map.get(old_gid) else {
                continue;
            };
            cp_pairs.push(CpPair { cp, gid: new_gid });
        }
    } else {
        for (new_idx, &old_gid) in keep.iter().enumerate() {
            let new_gid: u16 = new_idx as u16;
            for &cp in font.rev_cps(old_gid) {
                cp_pairs.push(CpPair { cp, gid: new_gid });
            }
        }
    }
    cp_pairs.sort_by_key(|p| p.cp);
    cp_pairs.dedup_by_key(|p| p.cp);

    // 新 glyf + loca（loca 存字节偏移，写出时按 short/long 格式转换）
    // GSUB 路径 compound 字形内联为 simple（TS compound2simpleglyf 语义）；无 GSUB 路径保持分量重映射透传
    for &old_gid in &keep {
        new_loca.push(new_glyf.len() as u32);
        let range = match font.loca_range(old_gid) {
            None => {
                // 零轮廓字形（TS writeZeroContoursGlyfData:true 语义）：写 12B 空 header
                new_glyf.extend_from_slice(&[0u8; 12]);
                pad4(&mut new_glyf);
                continue;
            }
            Some(r) => r,
        };
        if range.1 - range.0 < 12 || range.1 as usize > glyf.len() {
            // 不足 12B 的残留（legacy 空字形 loca 长度 2/10 等）按零轮廓处理
            new_glyf.extend_from_slice(&[0u8; 12]);
            pad4(&mut new_glyf);
            continue;
        }
        let gdata = &glyf[range.0 as usize..range.1 as usize];
        let nc = ri16(gdata, 0);
        if nc < 0 {
            if gsub_out.is_some() {
                let contours = glyph_contours(font, old_gid, 0)?;
                write_simple_glyph(&mut new_glyf, &contours);
            } else {
                append_composite_glyph(&mut new_glyf, gdata, &gid_map);
            }
        } else {
            // P4 hinting 剥离（TS hinting:false 生产语义）：simple 字形重组剥 instructions
            append_simple_glyph_stripped(&mut new_glyf, gdata)?;
        }
        pad4(&mut new_glyf);
    }
    new_loca.push(new_glyf.len() as u32);
    if new_glyf.is_empty() {
        return Err(SubsetError::SubsetFailed); // NoGlyphs
    }
    // TS sizeof 语义：glyf 表 >65536 字节时用 long loca（indexToLocFormat=1）
    let loc_format: u16 = if new_glyf.len() > 65536 { 1 } else { 0 };

    // cmap 子表字节（format 4）
    let mut cmap_bytes: Vec<u8> = Vec::new();
    write_cmap4(&mut cmap_bytes, &cp_pairs)?;

    // ===== 输出 sfnt =====
    struct OutTable {
        tag: [u8; 4],
        checksum: u32,
        /// 透传表原始数据；重写表为生成字节
        src: Vec<u8>,
    }
    let mut all_tables: Vec<OutTable> = Vec::new();
    const REWRITTEN: [&[u8; 4]; 7] = [b"glyf", b"loca", b"cmap", b"maxp", b"post", b"hmtx", b"hhea"];
    // 透传白名单：对齐 TS 生产（fonteditor）输出表集合。其余表必须删除——
    // vhea/vmtx（竖排 metrics 按 numGlyphs 对齐，不重建即非法且全量 122KB）、
    // hdmx/LTSH/VDMX（设备相关度量按原 gid 布局，子集后语义失效且 OTS 校验 numGlyphs 一致性会拒）、
    // DSIG/FFTM（签名/杂表）、gasp、GDEF/morx/prop/feat（内容按 gid 索引，未 remap 即语义错误）。
    const PASSTHROUGH_OK: [&[u8; 4]; 3] = [b"head", b"OS/2", b"BASE"];
    for t in &font.tables {
        // GSUB 路径：原始 GSUB/GPOS 不透传，改用子集化结果
        if gsub_out.is_some() && &t.tag == b"GSUB" {
            continue;
        }
        if gpos_out.is_some() && &t.tag == b"GPOS" {
            continue;
        }
        let is_rewrite = REWRITTEN.iter().any(|r| &t.tag == *r);
        if !is_rewrite {
            let keep_tag = PASSTHROUGH_OK.iter().any(|w| &t.tag == *w);
            if !keep_tag {
                continue;
            }
            all_tables.push(OutTable {
                tag: t.tag,
                checksum: t.checksum,
                src: font.data[t.offset as usize..(t.offset + t.length) as usize].to_vec(),
            });
        }
    }
    // P6 name 白名单重建（对齐 TS fonteditor 产物语义）
    if let Some(nm) = font.find_table(b"name") {
        let rebuilt_name = build_ttf_subset_name(nm)?;
        all_tables.push(OutTable { tag: *b"name", checksum: 0, src: rebuilt_name });
    }
    all_tables.push(OutTable { tag: *b"cmap", checksum: 0, src: cmap_bytes });
    all_tables.push(OutTable { tag: *b"glyf", checksum: 0, src: new_glyf });
    all_tables.push(OutTable { tag: *b"loca", checksum: 0, src: Vec::new() });
    // maxp v1.0：透传原字体 32 字节并仅改写 numGlyphs（对齐 TS fonteditor 语义）。
    // 不能合成全 0 极值：maxZones=0 等违反 OpenType 规范，Windows DirectWrite 校验拒绝
    // → 字形渲染空白（FreeType 不校验，SSIM/无头 chromium 验证体系测不出）。
    // 极值偏大无害（资源分配提示），指令相关字段随 hinting:false 剥离语义原样保留亦可。
    let maxp_src: Vec<u8> = match font.find_table(b"maxp") {
        Some(m) if m.len() >= 32 && ru32(m, 0) == 0x00010000 => {
            let mut v = m.to_vec()[..32].to_vec();
            v[4..6].copy_from_slice(&(keep.len() as u16).to_be_bytes());
            v
        }
        _ => {
            let mut v = Vec::with_capacity(32);
            wb_u32(&mut v, 0x00010000);
            wb_u16(&mut v, keep.len() as u16);
            v.resize(32, 0);
            v
        }
    };
    all_tables.push(OutTable { tag: *b"maxp", checksum: 0, src: maxp_src });
    all_tables.push(OutTable { tag: *b"post", checksum: 0, src: Vec::new() });
    // hmtx 按 NEW gid 序重建（前 numberOfHMetrics 个新记录是 advance+lsb，其余仅 lsb）。
    // advance 继承：old gid >= 原始 nhm 的字形 advance = 原始 gid nhm-1 的 advance（spec 语义）
    let mut num_hm_new: u32 = 0;
    let mut new_hmtx: Vec<u8> = Vec::new();
    if let Some(hmtx) = font.find_table(b"hmtx") {
        let hhea = font.find_table(b"hhea");
        let nhm: u32 = match hhea {
            Some(h) if h.len() >= 36 => ru16(h, 34) as u32,
            _ => 0,
        };
        /// 原 hmtx 中 old gid 的 advance（spec 继承：≥nhm 复用 nhm-1 的）
        fn adv_of(hm: &[u8], n: u32, old: u16) -> Option<u16> {
            let src: u32 = if (old as u32) < n { old as u32 } else if n > 0 { n - 1 } else { 0 };
            let o = src as usize * 4;
            if o + 2 > hm.len() {
                return None;
            }
            Some(ru16(hm, o))
        }
        /// 原 hmtx 中 old gid 的 lsb（≥nhm 走 lsb 数组区）
        fn lsb_of(hm: &[u8], n: u32, old: u16) -> Option<u16> {
            if (old as u32) < n {
                let o = old as usize * 4 + 2;
                if o + 2 > hm.len() {
                    return None;
                }
                return Some(ru16(hm, o));
            }
            let o = n as usize * 4 + (old as usize - n as usize) * 2;
            if o + 2 > hm.len() {
                return None;
            }
            Some(ru16(hm, o))
        }
        // P7 advance 折叠（对齐 TS fonteditor 产物实测语义）：numberOfHMetrics =
        // 最后一个与末位 advance 不同的位置 + 1（全同时折叠到 1）；尾部等 advance
        // 字形只写 lsb。思源全角全同 → numH=1，优设标点 numH=2。
        let advs: Vec<u16> = keep.iter().map(|&old_gid| adv_of(hmtx, nhm, old_gid).unwrap_or(0)).collect();
        // 折叠规则（TS 产物 121 例反推验证）：从尾部裁掉与前一条 advance 相同的记录，
        // 保留到第一条与前不同的记录为止；全相同折叠到 1。思源全角全同 → numH=1。
        let mut num_h: usize = keep.len();
        if !keep.is_empty() {
            let mut i = keep.len() - 1;
            while i > 0 && advs[i] == advs[i - 1] {
                i -= 1;
            }
            num_h = i + 1;
        }
        for (new_gid, &old_gid) in keep.iter().enumerate() {
            let lsb = lsb_of(hmtx, nhm, old_gid).unwrap_or(0);
            if new_gid < num_h {
                wb_u16(&mut new_hmtx, advs[new_gid]);
                wb_u16(&mut new_hmtx, lsb);
            } else {
                wb_u16(&mut new_hmtx, lsb);
            }
        }
        // hhea.numberOfHMetrics 必须与 hmtx 实际长记录数一致且 <= numGlyphs，否则 OTS 拒载。
        num_hm_new = num_h as u32;
    }
    all_tables.push(OutTable { tag: *b"hmtx", checksum: 0, src: new_hmtx });
    // hhea：透传 + patch numberOfHMetrics（偏移 +34），与 hmtx 实际长记录数一致（否则 OTS 拒载）
    if let Some(hh) = font.find_table(b"hhea") {
        let mut patched = hh.to_vec();
        if patched.len() >= 36 {
            patched[34..36].copy_from_slice(&(num_hm_new as u16).to_be_bytes());
        }
        all_tables.push(OutTable { tag: *b"hhea", checksum: 0, src: patched });
    }
    // 子集化后的 GSUB（重映射 coverage/ClassDef/替换目标 gid，保留连字与上下文替换）
    if let Some(go) = gsub_out {
        all_tables.push(OutTable { tag: *b"GSUB", checksum: 0, src: go });
    }
    // 子集化后的 GPOS（重映射 coverage/ClassDef/PairPos gid，保留标点压缩定位）；None 时原始字节已在透传循环保留
    if let Some(go) = gpos_out {
        all_tables.push(OutTable { tag: *b"GPOS", checksum: 0, src: go });
    }
    all_tables.sort_by(|a, b| a.tag.cmp(&b.tag));

    // 输出 sfnt 预分配：各表体之和 + 目录区上界（消除组装段倍增 realloc）
    // （输出字形数 = keep.len()，maxp 重建处直接取 keep.len()）
    let out_cap: usize = 16 * all_tables.len() + 4096
        + all_tables.iter().map(|t| t.src.len()).sum::<usize>();
    let mut out: Vec<u8> = Vec::with_capacity(out_cap);

    // header
    let total_tables = all_tables.len();
    wb_u32(&mut out, 0x00010000);
    wb_u16(&mut out, total_tables as u16);
    let mut sr: u32 = 16;
    let mut es: u16 = 0;
    while sr * 2 <= (total_tables * 16) as u32 {
        sr *= 2;
        es += 1;
    }
    wb_u16(&mut out, sr as u16);
    wb_u16(&mut out, es);
    wb_u16(&mut out, (total_tables * 16 - sr as usize) as u16);

    // 计算表体偏移
    let mut offsets: Vec<u32> = Vec::with_capacity(total_tables);
    let mut lengths: Vec<u32> = Vec::with_capacity(total_tables);
    let mut body_off: u32 = (12 + total_tables * 16) as u32;
    for (i, t) in all_tables.iter().enumerate() {
        let mut len: u32 = t.src.len() as u32;
        if &t.tag == b"loca" {
            len = (new_loca.len() * if loc_format == 0 { 2 } else { 4 }) as u32;
        }
        if &t.tag == b"maxp" {
            len = 32;
        }
        if &t.tag == b"post" {
            len = 32; // format 3
        }
        offsets.push(body_off);
        lengths.push(len);
        body_off = (body_off + len + 3) & !3u32;
        let _ = i;
    }

    // 目录条目
    for (i, t) in all_tables.iter().enumerate() {
        out.extend_from_slice(&t.tag);
        wb_u32(&mut out, t.checksum);
        wb_u32(&mut out, offsets[i]);
        wb_u32(&mut out, lengths[i]);
    }

    // 表体
    for (i, t) in all_tables.iter().enumerate() {
        while out.len() < offsets[i] as usize {
            out.push(0);
        }
        if &t.tag == b"loca" {
            // short 格式存 half-word 偏移；long 格式存字节偏移
            if loc_format == 0 {
                for &v in &new_loca {
                    wb_u16(&mut out, (v / 2) as u16);
                }
            } else {
                for &v in &new_loca {
                    wb_u32(&mut out, v);
                }
            }
        } else if &t.tag == b"post" {
            // post format 3（无字形名），全部填 0 除 version
            wb_u32(&mut out, 0x00030000);
            out.resize(out.len() + 28, 0);
        } else {
            out.extend_from_slice(&t.src);
            if &t.tag == b"head" {
                // indexToLocFormat 按 glyf 大小定（TS sizeof 语义）、glyphDataFormat=0（head 尾部 4 字节）
                let n = out.len();
                out[n - 4..n - 2].copy_from_slice(&loc_format.to_be_bytes());
                out[n - 2..].copy_from_slice(&0u16.to_be_bytes());
                // checkSumAdjustment 清零：head 的目录 checksum 按 adjustment=0 计算（对齐 assemble_otto），
                // 最终值在下方全表 checksum 汇总后回填。原字体旧值残留会使文件级 checksum 不变量失效
                let h0 = out.len() - t.src.len();
                out[h0 + 8..h0 + 12].fill(0);
            }
        }
        pad4(&mut out);
    }

    // ===== 表 checksum + head.checkSumAdjustment =====
    // Windows DirectWrite 校验表 checksum，全 0 会使字形在 Windows 浏览器渲染成空白
    // （FreeType 不校验，故 SSIM/无头 chromium 验证体系测不出）；语义对齐 assemble_otto：
    // 目录写各表最终字节的 checksum；adjustment = 0xB1B0AFBA - (目录区 sum + Σ 各表 checksum)
    let mut tables_data_sum: u32 = 0;
    for (i, _t) in all_tables.iter().enumerate() {
        let cks = calc_table_checksum(&out[offsets[i] as usize..(offsets[i] + lengths[i]) as usize]);
        tables_data_sum = tables_data_sum.wrapping_add(cks);
        let r = 12 + i * 16;
        out[r + 4..r + 8].copy_from_slice(&cks.to_be_bytes());
    }
    let mut dir_sum: u32 = 0;
    let dir_size = 12 + all_tables.len() * 16;
    let mut di = 0usize;
    while di < dir_size {
        dir_sum = dir_sum.wrapping_add(ru32(&out, di));
        di += 4;
    }
    for (i, t) in all_tables.iter().enumerate() {
        if &t.tag == b"head" {
            let h0 = offsets[i] as usize;
            let adjustment = 0xB1B0AFBAu32.wrapping_sub(dir_sum.wrapping_add(tables_data_sum));
            out[h0 + 8..h0 + 12].copy_from_slice(&adjustment.to_be_bytes());
        }
    }
    Ok(out)
}

/// simple 字形剥 instructions 重组（P4 对齐 TS hinting:false：读侧不解析、写侧不输出 hinting）：
/// 原样保留 numberOfContours+bbox+endPtsOfContours，instructionLength 写 0，
/// 直接跟 flags + 坐标字节。composite 字形（nc<0）无 instructions 不走此路径。
fn append_simple_glyph_stripped(out: &mut Vec<u8>, g: &[u8]) -> Result<(), SubsetError> {
    if g.len() < 10 {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    let nc_raw = ri16(g, 0);
    if nc_raw < 0 {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    let ilen_off = 10 + nc_raw as usize * 2;
    if ilen_off + 2 > g.len() {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    let ilen = ru16(g, ilen_off) as usize;
    let rest_off = ilen_off + 2 + ilen;
    if rest_off > g.len() {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    out.extend_from_slice(&g[..ilen_off]);
    wb_u16(out, 0); // instructionLength = 0
    out.extend_from_slice(&g[rest_off..]);
    Ok(())
}

/// TTF name 表白名单重建（P6 对齐 TS fonteditor 产物实测语义）：
/// 内容取英文记录——优先 (3,1,1033) UTF-16BE，缺项补 (1,0,0) Latin-1；
/// nameId 限 {1,2,4,6,16,17}。输出统一两组记录：先 (1,0,0) Latin-1 组，
/// 再 (3,1,1033) UTF-16BE 组，内容相同（TS 产物实测：FiraCode 只有 p3 记录时
/// 会合成 pid1 记录；简中 2052 / mac e25 等其他 lang 记录全部丢弃）。
fn build_ttf_subset_name(nm: &[u8]) -> Result<Vec<u8>, SubsetError> {
    const KEEP_IDS: [u16; 6] = [1, 2, 4, 6, 16, 17];
    if nm.len() < 6 {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    let count = ru16(nm, 2) as usize;
    let str_off = ru16(nm, 4) as usize;
    if nm.len() < 6 + count * 12 {
        return Err(SubsetError::SubsetFailed); // BadTable
    }
    // 每个白名单 nid 的内容（Latin-1 单字节序列），pass0 取 p3e1/1033，pass1 补 p1e0/0
    let mut content: [Option<Vec<u8>>; 6] = [None, None, None, None, None, None];
    for pass in 0..2u8 {
        let (want_pid, want_eid, want_lid): (u16, u16, u16) = if pass == 0 { (3, 1, 1033) } else { (1, 0, 0) };
        for ri in 0..count {
            let rec = &nm[6 + ri * 12..6 + ri * 12 + 12];
            let pid = ru16(rec, 0);
            let eid = ru16(rec, 2);
            let lid = ru16(rec, 4);
            let nid = ru16(rec, 6);
            let len = ru16(rec, 8) as usize;
            let off = ru16(rec, 10) as usize;
            if pid != want_pid || eid != want_eid || lid != want_lid {
                continue;
            }
            for (ki, &kid) in KEEP_IDS.iter().enumerate() {
                if kid == nid && content[ki].is_none() {
                    // 越界即 panic（对齐 Zig 切片 let-it-crash）
                    let raw = &nm[str_off + off..str_off + off + len];
                    if pass == 0 {
                        // UTF-16BE → Latin-1（英文记录码点 <256，取低字节）
                        let dst: Vec<u8> = (0..len / 2).map(|j| raw[j * 2 + 1]).collect();
                        content[ki] = Some(dst);
                    } else {
                        content[ki] = Some(raw.to_vec());
                    }
                }
            }
        }
    }
    let mut n_kept: usize = 0;
    for c in &content {
        if c.is_some() {
            n_kept += 1;
        }
    }
    let total_recs = n_kept * 2;
    let mut out: Vec<u8> = Vec::new();
    wb_u16(&mut out, 0); // format 0
    wb_u16(&mut out, total_recs as u16);
    wb_u16(&mut out, (6 + total_recs * 12) as u16); // stringOffset
    let mut cur: usize = 0; // offset 相对 string storage 起点（spec 语义）
    // pid1 组记录
    for (ki, &kid) in KEEP_IDS.iter().enumerate() {
        if let Some(s) = &content[ki] {
            wb_u16(&mut out, 1);
            wb_u16(&mut out, 0);
            wb_u16(&mut out, 0);
            wb_u16(&mut out, kid);
            wb_u16(&mut out, s.len() as u16);
            wb_u16(&mut out, cur as u16);
            cur += s.len();
        }
    }
    // pid3 组记录（UTF-16BE，长度翻倍）
    for (ki, &kid) in KEEP_IDS.iter().enumerate() {
        if let Some(s) = &content[ki] {
            wb_u16(&mut out, 3);
            wb_u16(&mut out, 1);
            wb_u16(&mut out, 1033);
            wb_u16(&mut out, kid);
            wb_u16(&mut out, (s.len() * 2) as u16);
            wb_u16(&mut out, cur as u16);
            cur += s.len() * 2;
        }
    }
    // 字符串区：pid1 Latin-1 + pid3 UTF-16BE
    for c in &content {
        if let Some(s) = c {
            out.extend_from_slice(s);
        }
    }
    for c in &content {
        if let Some(s) = c {
            for &ch in s {
                wb_u16(&mut out, ch as u16);
            }
        }
    }
    Ok(out)
}

/// 复合字形透传 + component gid 重映射（无 GSUB 路径）
fn append_composite_glyph(out: &mut Vec<u8>, gdata: &[u8], gid_map: &GidMap) {
    out.extend_from_slice(&gdata[..10]);
    let mut off = 10usize;
    let mut more = true;
    while more && off + 4 <= gdata.len() {
        let flags_raw = ru16(gdata, off);
        let comp_gid = ru16(gdata, off + 2);
        let new_gid = gid_map.get(comp_gid).unwrap_or(0);
        let mut extra: usize = 0;
        if flags_raw & 0x0008 != 0 {
            extra = 2;
        }
        if flags_raw & 0x0040 != 0 {
            extra = 4;
        }
        if flags_raw & 0x0080 != 0 {
            extra = 8;
        }
        let arg_len: usize = if flags_raw & 0x0001 != 0 { 4 } else { 2 };
        let seg_end = off + 4 + arg_len + extra;
        if seg_end > gdata.len() {
            break;
        }
        wb_u16(out, flags_raw);
        wb_u16(out, new_gid);
        out.extend_from_slice(&gdata[off + 4..seg_end]);
        more = flags_raw & 0x0020 != 0;
        off = seg_end;
    }
}

/// cmap format4 段（delta 已按 u16 存储位模式）（对译 CmapSeg）
#[derive(Clone, Copy)]
struct CmapSeg {
    /// 段起始码点
    start: u32,
    /// 段结束码点
    end: u32,
    /// idDelta（u16 位模式）
    delta: u16,
}

/// cmap format12 group（BMP 外码点；连续码点且 gid 连续合并）（对译 Cmap12Group）
#[derive(Clone, Copy)]
struct Cmap12Group {
    /// 组起始码点
    start: u32,
    /// 组结束码点
    end: u32,
    /// 组起始 gid
    gid: u16,
}

/// cmap（format 4，平台 3/1），段内 gid 线性（idRangeOffset=0）
fn write_cmap4(out: &mut Vec<u8>, pairs: &[CpPair]) -> Result<(), SubsetError> {
    let mut segs: Vec<CmapSeg> = Vec::new();
    for p in pairs {
        if let Some(last) = segs.last_mut() {
            // @as(u16, @intCast(p.cp))：Zig ReleaseFast 下超 u16 静默截断，Rust `as` 同语义
            if p.cp == last.end + 1 && p.gid == last.delta.wrapping_add(p.cp as u16) {
                last.end = p.cp;
                continue;
            }
        }
        segs.push(CmapSeg {
            start: p.cp,
            end: p.cp,
            delta: p.gid.wrapping_sub(p.cp as u16),
        });
    }
    if segs.is_empty() {
        return Err(SubsetError::SubsetFailed); // NoGlyphs
    }
    if segs.last().unwrap().end != 0xFFFF {
        // start_gid=0 → idDelta = 0 -% 0xFFFF = 1
        segs.push(CmapSeg { start: 0xFFFF, end: 0xFFFF, delta: 1 });
    }
    finish_cmap(out, &segs, pairs);
    Ok(())
}

/// cmap format4 段序列化（公共尾部：header/format4 字段/endCodes/startCodes/idDelta/idRangeOffset）
fn write_cmap4_segments(out: &mut Vec<u8>, segs: &[CmapSeg]) {
    let n = segs.len();
    let sub_len: u16 = (16 + n * 8) as u16;
    // cmap header + 子表记录
    wb_u16(out, 0);
    wb_u16(out, 1);
    wb_u16(out, 3);
    wb_u16(out, 1);
    wb_u32(out, 12);
    write_cmap4_subtable(out, segs, sub_len);
}

/// 仅 format4 子表体（不含 cmap header/记录；header 由调用方按子表数量组装）
fn write_cmap4_subtable(out: &mut Vec<u8>, segs: &[CmapSeg], sub_len: u16) {
    let n = segs.len();
    // format 4
    let mut sr: u16 = 2;
    let mut es: u16 = 0;
    while (sr as usize) * 2 <= n * 2 {
        sr *= 2;
        es += 1;
    }
    wb_u16(out, 4);
    wb_u16(out, sub_len);
    wb_u16(out, 0); // language
    wb_u16(out, (n * 2) as u16); // segCountX2
    wb_u16(out, sr);
    wb_u16(out, es);
    wb_u16(out, (n * 2 - sr as usize) as u16);
    for s in segs {
        wb_u16(out, s.end as u16);
    }
    wb_u16(out, 0); // reservedPad
    for s in segs {
        wb_u16(out, s.start as u16);
    }
    for s in segs {
        wb_u16(out, s.delta);
    }
    for _ in segs {
        wb_u16(out, 0); // idRangeOffset=0
    }
}

/// cmap 组装收尾：仅 BMP 码点 → 单 format4；含 BMP 外码点 → 补 format12 子表（platform 3/10）。
/// 缺 format12 时 plane1+ 字形保留在 glyf/CFF 但 cmap 无映射 → 浏览器渲染 tofu。
/// TS 生产语义（writeWindowsAllCodes / hasGLyfhsOver2Bytes）：仅当存在 >2 字节码点才写 format12。
fn finish_cmap(out: &mut Vec<u8>, segs: &[CmapSeg], pairs: &[CpPair]) {
    let has_astral = pairs.iter().any(|p| p.cp > 0xFFFF);
    if !has_astral {
        write_cmap4_segments(out, segs);
        return;
    }

    // format4 子表体（BMP 段，segs 已含 0xFFFF 哨兵）
    let mut sub4: Vec<u8> = Vec::new();
    write_cmap4_subtable(&mut sub4, segs, (16 + segs.len() * 8) as u16);

    // format12 子表：必须含全部码点（平台按 3/10 优先查找，只写 astral 会丢 BMP 映射）；
    // 连续码点且 gid 连续的合并为 group
    let mut sub12: Vec<u8> = Vec::new();
    let mut groups: Vec<Cmap12Group> = Vec::new();
    for p in pairs {
        let mut merged = false;
        if let Some(last) = groups.last_mut() {
            // @intCast(p.cp - last.start)：Zig ReleaseFast 下超 u16 静默截断，`as` 同语义
            if p.cp == last.end + 1 && p.gid == last.gid.wrapping_add((p.cp - last.start) as u16) {
                last.end = p.cp;
                merged = true;
            }
        }
        if !merged {
            groups.push(Cmap12Group { start: p.cp, end: p.cp, gid: p.gid });
        }
    }
    let g12_len: u32 = (16 + groups.len() * 12) as u32;
    wb_u16(&mut sub12, 12); // format
    wb_u16(&mut sub12, 0); // reserved
    wb_u32(&mut sub12, g12_len);
    wb_u32(&mut sub12, 0); // language
    wb_u32(&mut sub12, groups.len() as u32);
    for g in &groups {
        wb_u32(&mut sub12, g.start);
        wb_u32(&mut sub12, g.end);
        wb_u32(&mut sub12, g.gid as u32);
    }

    // header：两条子表记录（header 4B + 2×记录 8B = 20，format4 @20，format12 @20+sub4）
    wb_u16(out, 0); // version
    wb_u16(out, 2); // numTables
    wb_u16(out, 3);
    wb_u16(out, 1);
    wb_u32(out, 20);
    wb_u16(out, 3);
    wb_u16(out, 10);
    wb_u32(out, (20 + sub4.len()) as u32);
    out.extend_from_slice(&sub4);
    out.extend_from_slice(&sub12);
}

/// OTF 路径专用的 cmap format4 构建：bug-for-bug 复刻 TS buildSubsetCmap 的合并判定。
/// TS 差异：delta 存 (gid-cp)&0xffff 后用带符号展开 ((delta<<16)>>16) 与未掩码差值
/// (e.gid-e.cp) 比较 —— 当 |gid-cp| > 32768 时 &0xffff 往返无法还原符号，合并必失败拆段
/// （如 cp 65288/65289 gid 11/12：raw=-65277 ≠ s16(259)=259）。若用模 2^16 等价判定
/// 会把这些段合并（-8B），与 TS 产物不一致。
fn write_cmap4_otf(out: &mut Vec<u8>, pairs: &[CpPair]) -> Result<(), SubsetError> {
    let mut segs: Vec<CmapSeg> = Vec::new();
    for p in pairs {
        let mut merged = false;
        if let Some(last) = segs.last_mut() {
            // TS: (e.gid - e.cp) === ((last.delta << 16) >> 16)，未掩码 i32 差值 vs 存储 delta 的 i16 位重解释
            // （OTF 路径 cp 已过滤 <0x10000，i32 差值不丢位）
            let raw: i32 = p.gid as i32 - p.cp as i32;
            let last_delta_s: i32 = (last.delta as i16) as i32;
            if p.cp == last.end + 1 && raw == last_delta_s {
                last.end = p.cp;
                merged = true;
            }
        }
        if !merged {
            segs.push(CmapSeg {
                start: p.cp,
                end: p.cp,
                // @truncate(u32 减法) 取低 16 位
                delta: (p.gid as u32).wrapping_sub(p.cp) as u16,
            });
        }
    }
    if segs.is_empty() {
        return Err(SubsetError::SubsetFailed); // NoGlyphs
    }
    // TS 哨兵段恒追加（不判 last.end）
    segs.push(CmapSeg { start: 0xFFFF, end: 0xFFFF, delta: 1 });
    finish_cmap(out, &segs, pairs);
    Ok(())
}

// ===========================================================================
// OTF（CFF 轮廓）子集化 —— 语义移植自 backend/font_util/otf-subset.ts（对译 subsetOTF）
// ===========================================================================

/// OTF 组装用输出表（字节已成型，待排序封装）
struct OtfOutTable {
    /// 4 字节表标签
    tag: [u8; 4],
    /// 表体字节
    src: Vec<u8>,
}

/// OTF 子集化主入口（对齐 otf-subset.ts subsetOTF，outType 恒 otf → 计算 checksum）。
/// keep（新 gid 序）= [0] + 码点首现序种子 + GSUB 可达闭包追加（与 TS buildSubsetGids + reachable 合并一致）。
/// 输出表集合固定：CFF/cmap/hmtx/maxp v0.5/post v3/head/hhea/OS-2?/name?/BASE?/vmtx+vhea?/GSUB?/GPOS?；
/// VORG/GDEF/DSIG 等其余表全部丢弃。
fn subset_otf(font: &Font, text: &str) -> Result<Vec<u8>, SubsetError> {
    let cff_tbl = font.find_table(b"CFF ").ok_or(SubsetError::SubsetFailed)?; // OtfUnsupported
    let _cmap_tbl = font.find_table(b"cmap").ok_or(SubsetError::SubsetFailed)?;
    let hmtx_tbl = font.find_table(b"hmtx").ok_or(SubsetError::SubsetFailed)?;
    let hhea_tbl = font.find_table(b"hhea").ok_or(SubsetError::SubsetFailed)?;
    let head_tbl = font.find_table(b"head").ok_or(SubsetError::SubsetFailed)?;
    if !font.has_table(b"maxp") {
        return Err(SubsetError::SubsetFailed);
    }

    // 种子 gid：[0] + 文本码点首现序（TS buildSubsetGids 插入序，不排序）
    let seeds = font.seed_gids(text);
    if seeds.len() <= 1 {
        return Err(SubsetError::SubsetFailed); // NoGlyphs
    }

    // keep = 种子序 + GSUB 可达闭包（插入序）；无 GSUB 时保持种子序（TS OTF 路径从不排序）
    let gsub_tbl = font.find_table(b"GSUB");
    let use_gsub = gsub_tbl.is_some_and(|t| t.len() >= 10);
    let keep: Vec<u16>;
    let mut gsub_out: Option<Vec<u8>> = None;
    let mut gpos_out: Option<Vec<u8>> = None;
    if use_gsub {
        let gt = gsub_tbl.unwrap();
        let reachable = gsub::collect_reachable(gt, &seeds).map_err(|_| SubsetError::SubsetFailed)?;
        keep = if !reachable.is_empty() { reachable } else { seeds };
        gsub_out = Some(gsub::subset_gsub(gt, &keep).map_err(|_| SubsetError::SubsetFailed)?);
        // GPOS：None（版本不支持）时整个表丢弃（TS OTF 路径语义，与 TTF 路径透传不同）
        if let Some(gpos_tbl) = font.find_table(b"GPOS") {
            if gpos_tbl.len() >= 10 {
                if let Ok(Some(gp)) = gsub::subset_gpos(gpos_tbl, &keep) {
                    gpos_out = Some(gp);
                }
            }
        }
    } else {
        keep = seeds;
    }
    // gid→新 gid 映射：哨兵数组替代 HashMap（u16 键用 SipHash 纯开销；
    // 对齐 Zig 版 Int32Array gid_lookup 经验：构建是单次 memset+线性写，查询 O(1) 无 hash）
    let gid_map = GidMap::build(&keep, font.num_glyphs);

    // cmap 输入对：文本码点首现序 → 新 gid；仅 BMP（format4 上限，TS buildSubsetCmap 过滤 cp>=0x10000）
    let mut cp_pairs: Vec<CpPair> = Vec::new();
    {
        // 重复码点不去重收集（同 cp 必同 gid），sort 后统一 dedup——省一个 HashSet
        for ch in text.chars() {
            let cp = ch as u32;
            if cp == 0 || cp >= 0x10000 {
                continue;
            }
            let Some(old_gid) = font.cmap_get(cp) else {
                continue;
            };
            let Some(new_gid) = gid_map.get(old_gid) else {
                continue;
            };
            cp_pairs.push(CpPair { cp, gid: new_gid });
        }
    }
    cp_pairs.sort_by_key(|p| p.cp);
    cp_pairs.dedup_by_key(|p| p.cp);

    // 子集 CFF（失败 → 整体降级报错，与 TS 返回 null 降级对应；本服务无 fonteditor 回退路径）
    let new_cff = cff::subset_cff(cff_tbl, &keep)
        .map_err(|_| SubsetError::SubsetFailed)?
        .ok_or(SubsetError::SubsetFailed)?;

    // cmap（format 4，delta 合并 + 哨兵段，与 TS buildSubsetCmap 字节等价，含其带符号 delta 的合并怪癖）
    let mut cmap_bytes: Vec<u8> = Vec::new();
    write_cmap4_otf(&mut cmap_bytes, &cp_pairs)?;

    // hmtx 重建（尾部相同 advance 折叠为只写 lsb）+ hhea patch numberOfHMetrics
    let num_hm: usize = if hhea_tbl.len() >= 36 { ru16(hhea_tbl, 34) as usize } else { 0 };
    let hmtx_res = build_subset_metrics(hmtx_tbl, num_hm, &keep);
    let mut new_hhea = hhea_tbl.to_vec();
    new_hhea[34..36].copy_from_slice(&(hmtx_res.num_long as u16).to_be_bytes());

    // head 透传 + checkSumAdjustment 清零（封装时回填）
    let mut new_head = head_tbl.to_vec();
    if new_head.len() >= 12 {
        new_head[8..12].fill(0);
    }

    // OS/2 透传 + patch usFirstCharIndex/usLastCharIndex（+64/+66，请求码点的 BMP min/max；
    // TS 用请求 codePoints 而非实际命中的，缺失字也计入范围）
    let mut os2_out: Option<Vec<u8>> = None;
    if let Some(os2) = font.find_table(b"OS/2") {
        if os2.len() >= 68 {
            let mut o = os2.to_vec();
            let mut min_cp: u16 = 0xffff;
            let mut max_cp: u16 = 0;
            let mut seen2: HashSet<u32> = HashSet::new();
            for ch in text.chars() {
                let cp = ch as u32;
                if !seen2.insert(cp) {
                    continue;
                }
                if cp > 0 && cp < 0x10000 {
                    if cp < min_cp as u32 {
                        min_cp = cp as u16;
                    }
                    if cp > max_cp as u32 {
                        max_cp = cp as u16;
                    }
                }
            }
            if min_cp > max_cp {
                min_cp = 0;
                max_cp = 0xffff;
            }
            o[64..66].copy_from_slice(&min_cp.to_be_bytes());
            o[66..68].copy_from_slice(&max_cp.to_be_bytes());
            os2_out = Some(o);
        }
    }

    // name 白名单重建（nameId 1/2/4/6/16/17；先扫 p3e1 再补其他 platform）
    let name_out: Option<Vec<u8>> = match font.find_table(b"name") {
        Some(nm) => Some(build_otf_subset_name(nm)?),
        None => None,
    };

    // BASE 透传（缺 BASE 会使 FreeType/OTS 走启发式基线，渲染系统性偏移）
    let base_out: Option<Vec<u8>> = font.find_table(b"BASE").map(|b| b.to_vec());

    // vhea/vmtx 成对出现才重建（垂直排版 metrics）
    let vhea_tbl = font.find_table(b"vhea");
    let vmtx_tbl = font.find_table(b"vmtx");
    let mut vmtx_out: Option<Vec<u8>> = None;
    let mut vhea_out: Option<Vec<u8>> = None;
    if let (Some(vhea), Some(vmtx)) = (vhea_tbl, vmtx_tbl) {
        let num_v: usize = if vhea.len() >= 36 { ru16(vhea, 34) as usize } else { 0 };
        let vmtx_res = build_subset_metrics(vmtx, num_v, &keep);
        let mut vhea_new = vhea.to_vec();
        vhea_new[34..36].copy_from_slice(&(vmtx_res.num_long as u16).to_be_bytes());
        vmtx_out = Some(vmtx_res.bytes);
        vhea_out = Some(vhea_new);
    }

    // 组装表清单（VORG/GDEF/DSIG 等丢弃）
    let mut tables: Vec<OtfOutTable> = Vec::new();
    tables.push(OtfOutTable { tag: *b"CFF ", src: new_cff });
    tables.push(OtfOutTable { tag: *b"cmap", src: cmap_bytes });
    tables.push(OtfOutTable { tag: *b"hmtx", src: hmtx_res.bytes });
    tables.push(OtfOutTable { tag: *b"head", src: new_head });
    tables.push(OtfOutTable { tag: *b"hhea", src: new_hhea });
    // maxp v0.5：version(4) + numGlyphs(2)
    let mut maxp6 = Vec::with_capacity(6);
    wb_u32(&mut maxp6, 0x00005000);
    wb_u16(&mut maxp6, keep.len() as u16);
    tables.push(OtfOutTable { tag: *b"maxp", src: maxp6 });
    // post format 3（无字形名，32 字节全零除 version）
    let mut post32 = vec![0u8; 32];
    post32[0..4].copy_from_slice(&0x00030000u32.to_be_bytes());
    tables.push(OtfOutTable { tag: *b"post", src: post32 });
    if let Some(o) = os2_out {
        tables.push(OtfOutTable { tag: *b"OS/2", src: o });
    }
    if let Some(nm) = name_out {
        tables.push(OtfOutTable { tag: *b"name", src: nm });
    }
    if let Some(b) = base_out {
        tables.push(OtfOutTable { tag: *b"BASE", src: b });
    }
    if let Some(v) = vmtx_out {
        tables.push(OtfOutTable { tag: *b"vmtx", src: v });
    }
    if let Some(v) = vhea_out {
        tables.push(OtfOutTable { tag: *b"vhea", src: v });
    }
    if let Some(g) = gsub_out {
        tables.push(OtfOutTable { tag: *b"GSUB", src: g });
    }
    if let Some(g) = gpos_out {
        tables.push(OtfOutTable { tag: *b"GPOS", src: g });
    }

    let out = assemble_otto(&mut tables);
    out
}

/// hmtx/vmtx 重建结果：字节 + 压缩后的 numberOfHMetrics（需回填 hhea/vhea +34）
struct MetricsResult {
    /// 重建后的 metrics 表字节
    bytes: Vec<u8>,
    /// 折叠后的长记录数（numberOfHMetrics）
    num_long: u32,
}

/// 重建 hmtx/vmtx（语义对齐 otf-subset.ts buildSubsetMetrics）：
/// 原始记录前 numberOfHMetrics 个完整（advance+lsb），其余仅 lsb（advance 复用最后一条）；
/// 输出按尾部连续相同 advance 折叠（numberOfHMetrics = 最后一个不同 advance 的位置 + 1），
/// 渲染等价（浏览器对 gid>=numberOfHMetrics 复用最后 advance）。
fn build_subset_metrics(metrics: &[u8], num_hm: usize, keep: &[u16]) -> MetricsResult {
    let last_adv: u16 = if num_hm > 0 && num_hm * 4 + 2 <= metrics.len() {
        ru16(metrics, (num_hm - 1) * 4)
    } else {
        0
    };
    let mut advs: Vec<u16> = Vec::with_capacity(keep.len());
    let mut lsbs: Vec<i16> = Vec::with_capacity(keep.len());
    for &gid in keep {
        if (gid as usize) < num_hm {
            let o = gid as usize * 4;
            advs.push(if o + 2 <= metrics.len() { ru16(metrics, o) } else { 0 });
            lsbs.push(if o + 4 <= metrics.len() { ri16(metrics, o + 2) } else { 0 });
        } else {
            advs.push(last_adv);
            let o = num_hm * 4 + (gid as usize - num_hm) * 2;
            lsbs.push(if o + 2 <= metrics.len() { ri16(metrics, o) } else { 0 });
        }
    }
    // 尾部折叠：从尾向前找最长连续相同 advance 段（至少保留 1 个完整 longMetric）
    let mut num_long: usize = advs.len();
    if advs.len() > 1 {
        let tail_adv = advs[advs.len() - 1];
        let mut i = advs.len() - 1;
        while i >= 1 {
            if advs[i] != tail_adv {
                num_long = i + 1;
                break;
            }
            num_long = i;
            i -= 1;
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(num_long * 4 + (advs.len() - num_long) * 2);
    for (i, &adv) in advs.iter().enumerate() {
        if i < num_long {
            out.extend_from_slice(&adv.to_be_bytes());
            out.extend_from_slice(&lsbs[i].to_be_bytes());
        } else {
            out.extend_from_slice(&lsbs[i].to_be_bytes());
        }
    }
    MetricsResult { bytes: out, num_long: num_long as u32 }
}

/// name 表白名单重建（语义对齐 otf-subset.ts buildSubsetName）：
/// 保留 nameId 1/2/4/6/16/17，先扫 p3e1（Windows UTF-16）记录再补其他 platform，
/// 同 nameId 去重（先到先得），按收集序重建记录 + 字符串区。
fn build_otf_subset_name(name: &[u8]) -> Result<Vec<u8>, SubsetError> {
    let count = ru16(name, 2) as usize;
    let string_off = ru16(name, 4) as usize;
    struct Rec {
        platform: u16,
        encoding: u16,
        lang: u16,
        name_id: u16,
        bytes: Vec<u8>,
    }
    let mut records: Vec<Rec> = Vec::new();
    let mut seen: HashSet<u16> = HashSet::new();
    for pass in 0..2usize {
        let mut i = 0usize;
        while i < count {
            let r = 6 + i * 12;
            if r + 12 > name.len() {
                break;
            }
            let platform = ru16(name, r);
            let encoding = ru16(name, r + 2);
            let lang = ru16(name, r + 4);
            let name_id = ru16(name, r + 6);
            let keep_id = name_id == 1 || name_id == 2 || name_id == 4 || name_id == 6 || name_id == 16 || name_id == 17;
            if !keep_id {
                i += 1;
                continue;
            }
            let is_win = platform == 3 && encoding == 1;
            if pass == 0 && !is_win {
                i += 1;
                continue;
            }
            if seen.contains(&name_id) {
                i += 1;
                continue;
            }
            let length = ru16(name, r + 8) as usize;
            let offset = ru16(name, r + 10) as usize;
            let s = string_off + offset;
            if s + length > name.len() {
                i += 1;
                continue;
            }
            records.push(Rec {
                platform,
                encoding,
                lang,
                name_id,
                bytes: name[s..s + length].to_vec(),
            });
            seen.insert(name_id);
            i += 1;
        }
    }
    let header_size = 6 + records.len() * 12;
    let str_size: usize = records.iter().map(|rec| rec.bytes.len()).sum();
    let mut out = vec![0u8; header_size + str_size];
    out[0..2].copy_from_slice(&0u16.to_be_bytes());
    out[2..4].copy_from_slice(&(records.len() as u16).to_be_bytes());
    out[4..6].copy_from_slice(&(header_size as u16).to_be_bytes());
    let mut str_acc: usize = 0;
    for (i, rec) in records.iter().enumerate() {
        let r = 6 + i * 12;
        out[r..r + 2].copy_from_slice(&rec.platform.to_be_bytes());
        out[r + 2..r + 4].copy_from_slice(&rec.encoding.to_be_bytes());
        out[r + 4..r + 6].copy_from_slice(&rec.lang.to_be_bytes());
        out[r + 6..r + 8].copy_from_slice(&rec.name_id.to_be_bytes());
        out[r + 8..r + 10].copy_from_slice(&(rec.bytes.len() as u16).to_be_bytes());
        out[r + 10..r + 12].copy_from_slice(&(str_acc as u16).to_be_bytes());
        out[header_size + str_acc..header_size + str_acc + rec.bytes.len()].copy_from_slice(&rec.bytes);
        str_acc += rec.bytes.len();
    }
    Ok(out)
}

/// 表 4 字节对齐 checksum（OpenType 规范：长度补齐到 4 字节后按大端 u32 累加，mod 2^32）
fn calc_table_checksum(bytes: &[u8]) -> u32 {
    let mut sum: u32 = 0;
    let quads = bytes.len() >> 2;
    for i in 0..quads {
        sum = sum.wrapping_add(ru32(bytes, i * 4));
    }
    let tail = bytes.len() & 3;
    if tail > 0 {
        let mut last: u32 = 0;
        for j in 0..tail {
            last = (last << 8) | bytes[quads * 4 + j] as u32;
        }
        last <<= (4 - tail) * 8;
        sum = sum.wrapping_add(last);
    }
    sum
}

/// 封装 OTF sfnt（'OTTO' 签名，语义对齐 otf-subset.ts assembleSfnt，skipCheckSum=false）：
/// 表按 tag 升序，各表 4 字节对齐；目录写 checksum；head.checkSumAdjustment =
/// 0xB1B0AFBA - (目录区 sum + Σ 各表 checksum)。
fn assemble_otto(tables: &mut [OtfOutTable]) -> Result<Vec<u8>, SubsetError> {
    tables.sort_by(|x, y| x.tag.cmp(&y.tag));
    let n = tables.len();
    let entry_selector: u32 = 32 - (n as u32).leading_zeros() - 1;
    let search_range: u32 = (1u32 << entry_selector) * 16;
    let range_shift: u32 = n as u32 * 16 - search_range;
    let dir_size = 12 + n * 16;
    let data_total: usize = tables.iter().map(|t| (t.src.len() + 3) & !3usize).sum();

    let mut out = vec![0u8; dir_size + data_total];
    out[0] = b'O';
    out[1] = b'T';
    out[2] = b'T';
    out[3] = b'O';
    out[4..6].copy_from_slice(&(n as u16).to_be_bytes());
    out[6..8].copy_from_slice(&(search_range as u16).to_be_bytes());
    out[8..10].copy_from_slice(&(entry_selector as u16).to_be_bytes());
    out[10..12].copy_from_slice(&(range_shift as u16).to_be_bytes());

    let mut data_off: usize = dir_size;
    let mut head_data_off: Option<usize> = None;
    let mut tables_data_sum: u32 = 0;
    for (i, t) in tables.iter().enumerate() {
        let r = 12 + i * 16;
        out[r..r + 4].copy_from_slice(&t.tag);
        let cks = calc_table_checksum(&t.src);
        tables_data_sum = tables_data_sum.wrapping_add(cks);
        out[r + 4..r + 8].copy_from_slice(&cks.to_be_bytes());
        out[r + 8..r + 12].copy_from_slice(&(data_off as u32).to_be_bytes());
        out[r + 12..r + 16].copy_from_slice(&(t.src.len() as u32).to_be_bytes());
        out[data_off..data_off + t.src.len()].copy_from_slice(&t.src);
        if &t.tag == b"head" {
            head_data_off = Some(data_off);
        }
        data_off += (t.src.len() + 3) & !3usize;
    }
    if let Some(h) = head_data_off {
        let mut dir_sum: u32 = 0;
        let mut i = 0usize;
        while i < dir_size {
            dir_sum = dir_sum.wrapping_add(ru32(&out, i));
            i += 4;
        }
        let adjustment = 0xB1B0AFBAu32.wrapping_sub(dir_sum.wrapping_add(tables_data_sum));
        out[h + 8..h + 12].copy_from_slice(&adjustment.to_be_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试字体（仓库 font/ 目录真实字体；cargo test 工作目录 = rust-spike/）
    const TEST_FONT: &str = "../font/方舟像素字体.ttf"; // 非 GSUB 路径，不依赖 gsub 桩

    #[test]
    fn parse_and_cmap_lookup() {
        let data = std::fs::read(TEST_FONT).expect("read font");
        let f = Font::parse(data).expect("parse");
        assert!(f.num_glyphs > 0);
        assert!(f.units_per_em >= 16 && f.units_per_em <= 16384);
        // 中英码点均可查到
        for cp in ['字', '体', 'A', 'z'].iter() {
            let gid = f.glyph_id(*cp as u32).expect("gid");
            assert!(gid > 0);
        }
        assert!(f.glyph_id(0x10FFFF).is_none()); // 民间区无映射
    }

    #[test]
    fn collect_gids_sorted_with_notdef() {
        let data = std::fs::read(TEST_FONT).expect("read font");
        let f = Font::parse(data).expect("parse");
        let gids = f.collect_gids("字体体测试fonts").expect("gids");
        assert_eq!(gids[0], 0); // gid 0 恒保留
        assert!(gids.windows(2).all(|w| w[0] < w[1])); // 升序去重
        // seed 序（不排序）：0 + 码点首现序
        let seeds = f.seed_gids("字体体");
        assert_eq!(seeds[0], 0);
        assert_eq!(seeds.len(), 3); // 重复「体」只计一次
        assert_eq!(seeds[1], f.glyph_id('字' as u32).unwrap());
    }

    #[test]
    fn subset_output_roundtrips() {
        let data = std::fs::read(TEST_FONT).expect("read font");
        let f = Font::parse(data).expect("parse");
        let out = subset(&f, "字体测试页").expect("subset");
        assert_eq!(out.len() % 4, 0);
        // 产物本身可再解析，且 cmap 只含请求码点
        let f2 = Font::parse(out).expect("reparse");
        for ch in "字体测试页".chars() {
            assert!(f2.glyph_id(ch as u32).is_some(), "missing {ch}");
        }
        assert!(f2.glyph_id('A' as u32).is_none()); // 未请求码点不保留
        // loca 单调不减且终止于 glyf 末尾（按 indexToLocFormat 读 short/long）
        let loca = f2.find_table(b"loca").unwrap();
        let glyf_len = f2.find_table(b"glyf").unwrap().len() as u32;
        let n = f2.num_glyphs as usize;
        let mut prev: u32 = 0;
        for i in 0..=n {
            let v = if f2.index_to_loc_format == 0 {
                ru16(loca, i * 2) as u32 * 2
            } else {
                ru32(loca, i * 4)
            };
            assert!(v >= prev, "loca not monotonic at {i}");
            prev = v;
        }
        assert_eq!(prev, glyf_len);
    }

    #[test]
    fn cmap4_delta_roundtrip_on_synthetic() {
        // 合成 pairs：含 gid-cp 差超 ±32767 的段（writeCmap4 截断合并语义）。
        // 产物是 cmap 表字节而非 sfnt，用 parse_cmap4 直接解码子表（header 12B 后即 format4）
        let pairs = [
            CpPair { cp: 0x4E2D, gid: 3 },
            CpPair { cp: 0x4E2E, gid: 4 },
            CpPair { cp: 65288, gid: 11 }, // 差 -65277，u16 截断后仍命中
        ];
        let mut out = Vec::new();
        write_cmap4(&mut out, &pairs).expect("cmap4");
        let mut cmap: HashMap<u32, u16> = HashMap::new();
        parse_cmap4(&out[12..], 1000, &mut cmap);
        assert_eq!(cmap.get(&0x4E2D), Some(&3));
        assert_eq!(cmap.get(&0x4E2E), Some(&4));
        assert_eq!(cmap.get(&65288), Some(&11));
        assert!(cmap.get(&0x4E2F).is_none());
    }

    #[test]
    fn cmap12_astral_roundtrip() {
        // astral 码点触发 format12 双子表：format4 @20，format12 @20+sub4.len()
        let pairs = [
            CpPair { cp: 0x41, gid: 1 },
            CpPair { cp: 0x20000, gid: 2 },
            CpPair { cp: 0x20001, gid: 3 },
        ];
        let mut out = Vec::new();
        write_cmap4(&mut out, &pairs).expect("cmap");
        // 子表数量 2，format12 偏移取自记录
        assert_eq!(ru16(&out, 2), 2);
        let off12 = ru32(&out, 16) as usize;
        let mut cmap: HashMap<u32, u16> = HashMap::new();
        parse_cmap12(&out[off12..], 1000, &mut cmap);
        assert_eq!(cmap.get(&0x41), Some(&1));
        assert_eq!(cmap.get(&0x20000), Some(&2));
        assert_eq!(cmap.get(&0x20001), Some(&3));
    }

    #[test]
    fn anchor_injection_short_cjk_only() {
        // 短中文文本注入 32 锚定字；长文本/纯 ASCII 不注入
        assert!(maybe_inject_anchors("字体").is_some());
        assert!(maybe_inject_anchors("abc").is_none());
        // ≥32 个唯一码点不注入（用 ANCHOR 自身 32 个 + 2 个不同字）
        let long = format!("{ANCHOR_CODEPOINTS}字体");
        assert!(maybe_inject_anchors(&long).is_none());
        let inj = maybe_inject_anchors("字").unwrap();
        assert!(inj.starts_with('字'));
        assert_eq!(unique_cp_count(&inj), 33);
    }

    #[test]
    fn otf_rejected_in_ttf_pipeline() {
        // 非真字体签名 → NotTtf（parse 侧）；OTF 走 subset_otf 需要 CFF 桩，此处只测 parse
        let bad = Font::parse(b"MZ\x00\x00not a font at all........".to_vec());
        assert!(matches!(bad, Err(ParseError::NotTtf)));
    }
}
