//! CFF 表子集化（自 backend/font_util/cff-subset.ts 语义移植）+ 非 CID（name-keyed 单 Private）路径扩展
//! （对译 zig-spike/src/cff.zig）
//!
//! 移植语义说明：
//! - CID-keyed 路径逐段对应 TS subsetCFF：charset 格式0 重建、FDSelect 按需查询 + 格式0/3 重编码、
//!   FDArray/Top DICT/Private DICT op19 偏移联合迭代收敛、Local Subr 引用闭包 + 重映射 + bias 重算。
//! - 关键语义（历史验证的坑）：Local Subr 的 callsubr operand 是「subr 编号 + bias」的相对值，
//!   subr 子集化重编号后每个 callsubr operand 必须重算（rewrite_charstring 截断重写），不可透传原字节；
//!   Global Subr 不子集化，callgsubr operand 原样保留（bias 不变）。
//! - stemGains：OTS 的 num_stems 跨 callsubr 共享，hintmask/cntrmask 掩码字节数 = (stems+7)/8，
//!   重写时遇 callsubr 必须累加被调 subr 的递归 stem 净增量，否则掩码字节被误读。
//!   引用收集阶段（collectSubrRefs/convergeRefs）与 TS 一致不传 stemGains（收集期掩码偏移
//!   误差不影响引用集正确性，仅重写期需要精确）。
//! - 非 CID 路径（TS 遇到返回 null 降级，本实现补齐）：单 Private DICT 挂在 Top DICT（op 18），
//!   无 FDArray/FDSelect；charset 语义是 SID（缺省 op 时按 ISOAdobe 隐式 charset：编号=gid）；
//!   Encoding 表（op 16）从 Top DICT 删除（子集后其内部 glyph 索引已失效，浏览器消费 cmap 不消费它）。
//! - stripHints/charstringStackOverflows（OTS operand 栈深 >48 时剥 hint）逐字节对应 TS 行为，
//!   包括其 callsubr/callgsubr 操作符丢弃、操作数保留的既有语义。
//! - Zig 版用请求级 arena 分配器统一释放；Rust 版所有权即生命周期，无对应物。
#![allow(dead_code)] // subset_cff 未接线（ttf.rs 移植后调用），落地后移除

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::hash_map::Entry;

/// UnsupportedCff：结构超出支持范围（缺 CharStrings/FDArray 等），调用方降级。
/// （Zig CffError 另有 OutOfMemory；Rust 侧分配失败直接 abort，无对应成员）
#[derive(Debug)]
pub enum CffError {
    UnsupportedCff,
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// Top DICT 操作码（双字节 12,n 存为 (12<<8)|n）
const OP_CHARSET: u32 = 15;
const OP_ENCODING: u32 = 16;
const OP_CHARSTRINGS: u32 = 17;
const OP_PRIVATE: u32 = 18;
/// Private DICT 内：Local Subr INDEX 相对 Private DICT 起始的偏移
const OP_LOCAL_SUBR: u32 = 19;
const OP_FD_ARRAY: u32 = (12 << 8) | 36;
const OP_FD_SELECT: u32 = (12 << 8) | 37;
const OP_ROS: u32 = (12 << 8) | 30;

/// Type 2 charstring 操作码（Adobe Type 2 Charstring Format）
const T2_CALLSUBR: u8 = 10;
const T2_ENDCHAR: u8 = 14;
const T2_HSTEM: u8 = 1;
const T2_VSTEM: u8 = 3;
const T2_HSTEMHM: u8 = 18;
const T2_VSTEMHM: u8 = 23;
const T2_HINTMASK: u8 = 19;
const T2_CNTRMASK: u8 = 20;
const T2_CALLGSUBR: u8 = 29;

/// OTS（Chrome 字体安全校验）允许的最大 operand 栈深；超限字形须 stripHints 剥 hint 区
const T2_MAX_STACK: usize = 48;

/// 无 Private 池的标记值（Private offset 不可能取到）
const NO_PRIV: usize = usize::MAX;

// ---------------------------------------------------------------------------
// 基础读取工具（越界按 0 处理，仅损坏表触达；合法字体两者一致）
// ---------------------------------------------------------------------------

/// 带边界检查的 u8 读取
fn u8_at(b: &[u8], off: usize) -> u8 {
    if off >= b.len() {
        return 0;
    }
    b[off]
}

/// 带边界检查的 u16 大端读取
fn u16_at(b: &[u8], off: usize) -> u16 {
    if off + 2 > b.len() {
        return 0;
    }
    ((b[off] as u16) << 8) | b[off + 1] as u16
}

/// 带边界检查的 u32 大端读取
fn u32_at(b: &[u8], off: usize) -> u32 {
    if off + 4 > b.len() {
        return 0;
    }
    ((b[off] as u32) << 24) | (b[off + 1] as u32) << 16 | (b[off + 2] as u32) << 8 | b[off + 3] as u32
}

/// 带 i16 符号的 int16 大端读取
fn i16_at(b: &[u8], off: usize) -> i16 {
    u16_at(b, off) as i16
}

// ---------------------------------------------------------------------------
// CFF INDEX 结构
// ---------------------------------------------------------------------------

/// INDEX 轻量头部：只解析 count/offSize/dataStart/end，不展开 (count+1) 个偏移量数组
/// （思源 Local Subr INDEX 可达 26550 subr，全量展开占 subsetCFF 一半耗时，按需读单个 offset）
#[derive(Clone, Copy)]
struct IndexHeader {
    /// INDEX 起始偏移
    start: usize,
    /// INDEX 内对象数量
    count: usize,
    /// 偏移量字节宽度（1~4）
    off_size: u8,
    /// 偏移量数组起始（紧接 count/offSize 头；count=0 时无效）
    off_base: usize,
    /// 数据区起始（紧接偏移量数组之后）
    data_start: usize,
    /// INDEX 结束位置（最后一个对象尾，不含）
    end: usize,
}

/// 只读 INDEX 头部。offset 是 1-based：object i 的数据区间 = [data_start + off(i) - 1, data_start + off(i+1) - 1)
fn read_index_header(b: &[u8], pos: usize) -> IndexHeader {
    let count = u16_at(b, pos) as usize;
    if count == 0 {
        return IndexHeader { start: pos, count: 0, off_size: 0, off_base: pos + 2, data_start: pos + 2, end: pos + 2 };
    }
    let off_size = u8_at(b, pos + 2);
    let off_base = pos + 3;
    let data_start = off_base + (count + 1) * off_size as usize;
    let last_off = index_offset_at(b, off_base, off_size, count);
    IndexHeader { start: pos, count, off_size, off_base, data_start, end: data_start + last_off as usize - 1 }
}

/// 读 INDEX 第 i 个偏移量（1-based 大端 off_size 字节）
fn index_offset_at(b: &[u8], off_base: usize, off_size: u8, i: usize) -> u32 {
    let mut v: u32 = 0;
    let mut p = off_base + i * off_size as usize;
    for _ in 0..off_size {
        v = (v << 8) | u8_at(b, p) as u32;
        p += 1;
    }
    v
}

/// 全量 INDEX（含偏移量数组展开），仅用于小 INDEX（Top DICT INDEX / FDArray INDEX）
struct FullIndex {
    count: usize,
    /// (count+1) 个 1-based 偏移量
    offsets: Vec<u32>,
    data_start: usize,
    /// INDEX 结束位置（= data_start + offsets[count] - 1）
    end: usize,
}

fn read_index_full(b: &[u8], pos: usize) -> FullIndex {
    let hdr = read_index_header(b, pos);
    let mut offsets = Vec::with_capacity(hdr.count + 1);
    for i in 0..=hdr.count {
        offsets.push(index_offset_at(b, hdr.off_base, hdr.off_size, i));
    }
    FullIndex { count: hdr.count, offsets, data_start: hdr.data_start, end: hdr.end }
}

// ---------------------------------------------------------------------------
// CFF DICT 解析/编码
// ---------------------------------------------------------------------------

/// 解析 CFF DICT 字节为 操作码 → 操作数数组 的映射（语义对齐 TS Map：同操作码后者覆盖前者）。
/// 操作数编码（CFF 规范 §3.1）：28=int16、29=int32、32~246 单字节、247~250/251~254 双字节、
/// 30=BCD 实数（完整跳过，否则 BCD 内 <=21 字节被误判为操作码致边界错乱）。
fn parse_dict(b: &[u8], start: usize, end: usize) -> HashMap<u32, Vec<i32>> {
    let mut dict: HashMap<u32, Vec<i32>> = HashMap::new();
    let mut operands: Vec<i32> = Vec::new();
    let mut p = start;
    let clamped_end = end.min(b.len());
    while p < clamped_end {
        let b0 = b[p];
        p += 1;
        if b0 <= 21 {
            let op: u32 = if b0 == 12 {
                let o = (12u32 << 8) | u8_at(b, p) as u32;
                p += 1;
                o
            } else {
                b0 as u32
            };
            dict.insert(op, operands.clone());
            operands.clear();
        } else if b0 == 28 {
            operands.push(i16_at(b, p) as i32);
            p += 2;
        } else if b0 == 29 {
            operands.push(u32_at(b, p) as i32);
            p += 4;
        } else if b0 == 30 {
            // BCD 实数：每字节两 nibble，任一 nibble 为 0xf 结束
            while p < clamped_end {
                let byte = b[p];
                p += 1;
                if (byte >> 4) == 0xf || (byte & 0xf) == 0xf {
                    break;
                }
            }
        } else if (32..=246).contains(&b0) {
            operands.push(b0 as i32 - 139);
        } else if (247..=250).contains(&b0) {
            operands.push((b0 as i32 - 247) * 256 + u8_at(b, p) as i32 + 108);
            p += 1;
        } else if (251..=254).contains(&b0) {
            operands.push(-(b0 as i32 - 251) * 256 - u8_at(b, p) as i32 - 108);
            p += 1;
        }
    }
    dict
}

// ---------------------------------------------------------------------------
// 字节写入器
// ---------------------------------------------------------------------------

/// 大端序字节写入器（对应 TS combineBytes/writeIndex/Uint8Array 写指针模式）
struct W {
    buf: Vec<u8>,
}

impl W {
    fn new() -> W {
        W { buf: Vec::new() }
    }

    fn w8(&mut self, v: u8) {
        self.buf.push(v);
    }

    fn w16(&mut self, v: u16) {
        self.buf.push((v >> 8) as u8);
        self.buf.push((v & 0xff) as u8);
    }

    /// 编码一个 DICT 整数操作数（CFF 规范 §3.1 整数编码，选最短形式）
    fn dict_int(&mut self, v: i32) {
        if v >= -107 && v <= 107 {
            self.w8((v + 139) as u8);
        } else if v >= 108 && v <= 1131 {
            let v0 = (v - 108) as u32;
            self.w8((247 + (v0 >> 8)) as u8);
            self.w8((v0 & 0xff) as u8);
        } else if v >= -1131 && v <= -108 {
            let v0 = (-v - 108) as u32;
            self.w8((251 + (v0 >> 8)) as u8);
            self.w8((v0 & 0xff) as u8);
        } else if v >= -32768 && v <= 32767 {
            self.w8(28);
            self.w16(v as i16 as u16);
        } else {
            self.w8(29);
            self.w32(v as u32);
        }
    }

    fn w32(&mut self, v: u32) {
        self.buf.push(((v >> 24) & 0xff) as u8);
        self.buf.push(((v >> 16) & 0xff) as u8);
        self.buf.push(((v >> 8) & 0xff) as u8);
        self.buf.push((v & 0xff) as u8);
    }

    fn w_bytes(&mut self, s: &[u8]) {
        self.buf.extend_from_slice(s);
    }
}

/// 拼接多个字节切片
fn combine(parts: &[&[u8]]) -> Vec<u8> {
    let total: usize = parts.iter().map(|p| p.len()).sum();
    let mut out = Vec::with_capacity(total);
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

/// 计算 subr INDEX 的 bias（CFF 规范：调用编号 = 实际 subr 索引 + bias）
fn subr_bias(n_subrs: usize) -> i32 {
    if n_subrs < 1240 {
        107
    } else if n_subrs < 33900 {
        1131
    } else {
        32768
    }
}

// ---------------------------------------------------------------------------
// Type 2 charstring 扫描 / 重写 / 剥离
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 执行级 charstring 模拟（跨 callsubr 边界共享栈的 stem 精确追踪）
// ---------------------------------------------------------------------------

/// 执行级模拟上下文：原 Local Subr INDEX 与 Global Subr INDEX（均指原字体字节流）。
/// 模拟、重写、剥 hint 三条路径共用同一执行语义，保证掩码字节数与读取方（OTS/FreeType）一致。
#[derive(Clone, Copy)]
struct SimCtx {
    /// 原 Local Subr INDEX（无 Private 时 count=0）
    idx: IndexHeader,
    /// 原 local subr bias
    local_bias: i32,
    gsubr_hdr: IndexHeader,
    gsubr_bias: i32,
}

impl SimCtx {
    /// 无 Private 时的占位上下文（callsubr 必越界 → 模拟按不可分析处理）
    fn empty(gsubr_hdr: IndexHeader) -> SimCtx {
        let empty_idx = IndexHeader { start: 0, count: 0, off_size: 0, off_base: 2, data_start: 2, end: 2 };
        SimCtx { idx: empty_idx, local_bias: 0, gsubr_hdr, gsubr_bias: subr_bias(gsubr_hdr.count) }
    }
}

/// 预模拟记录：subr 的进入/返回时刻精确状态（stems 与栈深跨 callsubr 边界共享）。
/// rewrite/strip_hints 的 callsubr 查此表 O(1) 推进，免去逐次递归展开被调 body。
/// 不同调用点返回状态不一致（或流不可分析）时 consistent=false，该池降级透传。
struct EntryRec {
    /// sn → 进入 body 时的 num_stems（body 内掩码宽度 = 进入 stems + body 内声明数）
    map: HashMap<u32, usize>,
    /// sn → 返回时的 num_stems（调用方 stem_count 增量 = exit - entry，数值精确）
    exit_stems: HashMap<u32, usize>,
    /// sn → 返回时的栈深（==0 时调用方查表直接清栈；>0 需真实栈值，走递归模拟保底）
    exit_len: HashMap<u32, usize>,
    /// gsn → (stems 增量, 返回时栈深)。gsubr 不重写字节，仅需执行效应；
    /// 增量而非累计值：gsubr 调用点的累计 stems 天然不同，增量一致即可查表
    gsubr_exit: HashMap<u32, (usize, usize)>,
    consistent: bool,
    /// entry 不一致的 subr 内是否出现「掩码字节宽度跨调用点不一致」的 hintmask/cntrmask。
    /// 合法性判据是掩码宽度而非 entry stems：同一 body 字节流只写一份掩码，FreeType/OTS
    /// 按执行点 (stems+7)>>3 跳宽，浏览器渲染正常的字体各调用点跳宽必然等于物理宽度；
    /// stems 数不同但落在同一宽度桶（如 13/14 均 2 字节）时 body 仍可安全重写
    /// （rewrite 按首记录 stems 推进跳宽 = 物理宽度 = 各执行点宽度）
    bad_mask: bool,
    /// (gid, mask op 绝对位置) → 掩码字节数（cs 顶层帧记录；rewrite 语法扫描跳宽查表）
    cs_masks: HashMap<(u32, u32), u16>,
    /// (旧 sn, mask op 绝对位置) → 掩码字节数（local subr 帧记录；conflicted subr 各调用点
    /// 宽度桶一致（校验过）故值唯一）
    sn_masks: HashMap<(u32, u32), u16>,
    /// 执行路径上真实调用的 local subr 编号（执行级闭包，含嵌套）。
    /// 语法扫描（collect_subr_refs）的 hintmask 跳宽是静态 stems 推算，callsubr body 内
    /// 声明 hints 时后续 mask 跳宽错位 → 扫描错位漏收集 callsubr（思源 Light 实测命中）；
    /// 执行级收集与路径精确一致，两者取并集
    refs: HashSet<u32>,
}

/// 模拟帧信息（掩码宽度记录归因：cs 顶层帧入 cs_masks；local subr 帧入 sn_masks 并校验
/// conflicted subr 的宽度桶一致性；gsubr 帧透传不重写、掩码字节原样保留，无宽度依赖，
/// callgsubr 递归传 FRAME_GSUBR 不记录；gsubr 帧内 callsubr 触发池级透传）
#[derive(Clone, Copy)]
struct Frame {
    sn: u32,
    conflicted: bool,
    is_cs: bool,
    /// gsubr 体内帧（callsubr 在此帧执行 = gsubr_calls_local，禁用本池重编号）
    is_gsubr: bool,
}

const FRAME_NOT_SUBR: Frame = Frame { sn: u32::MAX, conflicted: false, is_cs: false, is_gsubr: false };
const FRAME_GSUBR: Frame = Frame { sn: u32::MAX, conflicted: false, is_cs: false, is_gsubr: true };

/// 模拟运行状态（模拟器与递归帧共享）
struct SimState<'a> {
    sim: &'a SimCtx,
    /// 峰值 operand 栈深是否超 T2_MAX_STACK（OTS 拒收阈值，触发 strip hint 路径）
    overflow: bool,
    /// 预模拟 entry 记录（仅 analyze_entry_stems 传入）
    rec: Option<&'a mut EntryRec>,
    /// 执行路径上「gsubr 体内 callsubr」：本池 local subr 不可重编号（透传 gsubr 的
    /// operand 仍指旧编号），整池降级透传。执行级判定替代 gsubr INDEX 全扫
    gsubr_calls_local: bool,
    /// cs 顶层帧是否执行过 callsubr（仅 analyze_entry_stems 逐字形传入标志用；
    /// 执行级判定比语法扫描精确——错位扫描会把坐标误判成 callsubr）
    top_has_subr: bool,
}

/// escape 算术/逻辑操作符的栈效应（对译 OTS：pop arity 个、压回 None 占位）。
/// None 占位与 255 fixed 编码一致：作 callsubr 操作数时模拟按不可分析处理（OTS 同样拒收）。
fn escape_stack_effect(b1: u8, stack: &mut Vec<Option<i32>>) {
    match b1 {
        18 => {
            stack.pop(); // drop
        }
        27 => stack.push(None), // dup
        28 => {
            stack.pop();
            stack.pop();
            stack.push(None);
            stack.push(None); // exch
        }
        // 二元算术/逻辑：and or div add sub eq ne lt le gt ge
        3 | 4 | 5 | 10 | 11 | 12 | 24 | 22 => {
            stack.pop();
            stack.pop();
            stack.push(None);
        }
        // 一元：abs neg rsqrt 等
        9 | 14 | 15 => {
            stack.pop();
            stack.push(None);
        }
        // 其余 escape（绘图族/保留）消费全部 operand
        _ => stack.clear(),
    }
}

/// 执行级模拟一段 Type 2 charstring/subr body（直线执行，无控制流）。
/// OTS 的 operand 栈与 num_stems 跨 callsubr 边界共享——「subr 消费调用方压栈操作数」
/// 模式（思源 Bold subr5572：9 字节 body 仅一条空栈 hstem，11 个操作数全部来自调用方）
/// 静态线性扫描原理上无法计数，必须在真栈上执行。掩码字节按执行期 num_stems 跳过。
/// 返回 false = 流不可分析（假 callsubr/越界/gsubr 体内 callsubr/未定义操作符），
/// 调用方（该池）降级透传路径。
#[allow(clippy::too_many_arguments)]
fn sim_exec(
    b: &[u8],
    start: usize,
    end: usize,
    st: &mut SimState,
    stack: &mut Vec<Option<i32>>,
    stems: &mut usize,
    depth: usize,
    // 当前帧所属 subr（掩码宽度归因，见 Frame 注释）
    frame: Frame,
) -> bool {
    if depth > 64 {
        return false;
    }
    let clamped_end = end.min(b.len());
    let mut p = start;
    while p < clamped_end {
        let b0 = b[p];
        p += 1;
        if b0 >= 32 {
            if b0 <= 246 {
                stack.push(Some(b0 as i32 - 139));
            } else if b0 == 255 {
                stack.push(None);
                p += 4;
            } else if b0 <= 250 {
                stack.push(Some((b0 as i32 - 247) * 256 + u8_at(b, p) as i32 + 108));
                p += 1;
            } else {
                stack.push(Some(-(b0 as i32 - 251) * 256 - u8_at(b, p) as i32 - 108));
                p += 1;
            }
            if stack.len() > T2_MAX_STACK {
                st.overflow = true;
            }
        } else if b0 == 28 {
            stack.push(Some(i16_at(b, p) as i32));
            p += 2;
            if stack.len() > T2_MAX_STACK {
                st.overflow = true;
            }
        } else if b0 == 12 {
            escape_stack_effect(u8_at(b, p), stack);
            p += 1;
        } else if b0 == T2_HSTEM || b0 == T2_VSTEM || b0 == T2_HSTEMHM || b0 == T2_VSTEMHM {
            *stems += stack.len() >> 1;
            stack.clear();
        } else if b0 == T2_HINTMASK || b0 == T2_CNTRMASK {
            // hintmask 栈上操作数是 vstem 声明（奇数含 width 时 ss>>1 恰为去 width 后的 stems 数）
            *stems += stack.len() >> 1;
            let skip = ((*stems + 7) >> 3) as u16;
            let op_pos = (p - 1) as u32;
            if let Some(rec) = st.rec.as_deref_mut() {
                if frame.is_cs {
                    // cs 顶层帧：每 (gid, pos) 至多一次，直接记录
                    rec.cs_masks.insert((frame.sn, op_pos), skip);
                } else if !frame.is_gsubr {
                    // local subr 帧：校验各调用点掩码宽度桶一致（一致 = 物理宽度唯一，可重写）
                    // gsubr 帧不记录：body 不重写、掩码原样拷贝，宽度信息无消费者
                    let key = (frame.sn, op_pos);
                    match rec.sn_masks.get(&key) {
                        None => {
                            rec.sn_masks.insert(key, skip);
                        }
                        Some(&prev) => {
                            if prev != skip {
                                rec.bad_mask = true;
                            }
                        }
                    }
                }
            }
            p += skip as usize;
            if p > clamped_end {
                return false;
            }
            stack.clear();
        } else if b0 == T2_CALLSUBR {
            // cs 顶层帧的 callsubr：标记该字形含直接 subr 调用（重写路径判定用）
            if frame.is_cs {
                st.top_has_subr = true;
            }
            // gsubr 体内 callsubr：透传的 gsubr operand 无法重写 → 本池禁重编号
            if frame.is_gsubr {
                st.gsubr_calls_local = true;
            }
            // 操作数可能在栈上（跨边界），栈顶即调用编号
            let top = stack.pop().flatten();
            let Some(sn_v) = top else { return false };
            let sn = sn_v + st.sim.local_bias;
            if sn < 0 {
                return false;
            }
            let snu = sn as usize;
            if snu >= st.sim.idx.count {
                return false;
            }
            // entry 不一致仅保留首记录（rewrite 的 stem_base/跳宽按首记录 = 物理宽度），
            // 冲突是否致命由该 body 内 mask 的宽度桶校验决定（bad_mask）
            let mut conflicted = false;
            if let Some(rec) = st.rec.as_deref_mut() {
                let e = rec.map.entry(snu as u32).or_insert(*stems);
                if *e != *stems {
                    conflicted = true;
                }
                // 执行路径真实可达 subr（嵌套经递归自然覆盖，无需 fixpoint 迭代）
                rec.refs.insert(snu as u32);
            }
            let ss = st.sim.idx.data_start
                + index_offset_at(b, st.sim.idx.off_base, st.sim.idx.off_size, snu) as usize
                - 1;
            let se = st.sim.idx.data_start
                + index_offset_at(b, st.sim.idx.off_base, st.sim.idx.off_size, snu + 1) as usize
                - 1;
            // 被调 body 帧继承 is_gsubr：gsubr → subr → subr 链路全程在透传域内
            if !sim_exec(b, ss, se, st, stack, stems, depth + 1, Frame { sn: snu as u32, conflicted, is_cs: false, is_gsubr: frame.is_gsubr }) {
                return false;
            }
            // 被调 body 返回后的效应（stems 累计/栈深）若跨调用点唯一则记入快路径表；
            // 不唯一（如 callee 留操作数给 caller 且数量依调用点而变）时写哨兵值淘汰出
            // 快路径，rewrite 对该 sn 递归模拟保底（递归对任意调用点均精确），不降级整池
            if let Some(rec) = st.rec.as_deref_mut() {
                let e = rec.exit_stems.entry(snu as u32).or_insert(*stems);
                if *e != *stems {
                    *e = usize::MAX;
                }
                let l = rec.exit_len.entry(snu as u32).or_insert(stack.len());
                if *l != stack.len() {
                    *l = usize::MAX;
                }
            }
        } else if b0 == T2_CALLGSUBR {
            let top = stack.pop().flatten();
            let Some(gn_v) = top else { return false };
            let gn = gn_v + st.sim.gsubr_bias;
            if gn < 0 {
                return false;
            }
            let gnu = gn as usize;
            if gnu >= st.sim.gsubr_hdr.count {
                return false;
            }
            let ss = st.sim.gsubr_hdr.data_start
                + index_offset_at(b, st.sim.gsubr_hdr.off_base, st.sim.gsubr_hdr.off_size, gnu) as usize
                - 1;
            let se = st.sim.gsubr_hdr.data_start
                + index_offset_at(b, st.sim.gsubr_hdr.off_base, st.sim.gsubr_hdr.off_size, gnu + 1) as usize
                - 1;
            // gsubr 不重写字节，仅记录执行效应供 rewrite/strip 查表推进。
            // 记录 stems 增量（非累计值）：gsubr 在不同字形/嵌套深度的调用点累计天然不同，
            // 只要增量与返回栈深一致即可查表
            let entry_stems_at_call = *stems;
            if !sim_exec(b, ss, se, st, stack, stems, depth + 1, FRAME_GSUBR) {
                return false;
            }
            let delta = *stems - entry_stems_at_call;
            if let Some(rec) = st.rec.as_deref_mut() {
                let e = rec.gsubr_exit.entry(gnu as u32).or_insert((delta, stack.len()));
                if *e != (delta, stack.len()) {
                    // 效应不唯一：哨兵淘汰出快路径，rewrite 递归模拟保底
                    *e = (usize::MAX, usize::MAX);
                }
            }
        } else if b0 == T2_ENDCHAR || b0 == 11 {
            // endchar/return：终止当前帧（endchar 经递归逐层传播终止）
            return true;
        } else if matches!(b0, 15 | 16 | 21 | 22 | 4 | 5 | 6 | 7 | 8 | 24 | 25 | 26 | 27 | 30 | 31) {
            // 绘图/flex 操作符消费全部 operand；15/16(vsindex/blend) OTS 在 CFF1 直接拒
            if matches!(b0, 15 | 16) {
                return false;
            }
            stack.clear();
        } else {
            // 未定义操作符：OTS 直接拒收，按不可分析处理
            return false;
        }
    }
    // 字节耗尽（subr body 隐式 return；顶层宽容——合法性由下游 OTS 校验兜底）
    true
}

/// 对引用闭包内全部子集 charstring 做执行级预模拟：
/// 1. 记录每个 subr 进入时的 num_stems（callsubr 编号重写与掩码跳宽推进用）
/// 2. 记录 cs 顶层帧与 local subr 帧各 hintmask 的物理掩码字节数（rewrite 语法扫描跳宽查表）
/// 3. 校验 conflicted subr 的掩码宽度桶跨调用点一致（不一致 → bad_mask → 整池降级透传）
/// 4. per-gid operand 栈深超限标志（执行级真栈峰值，分发期免二次模拟）
/// 5. per-gid cs 顶层 callsubr 标志（执行级精确判定，分发期 rewrite 路径用）
/// 任一 charstring 不可分析（病态流/callsubr 栈顶非字面量）→ consistent=false → 该池降级透传。
fn analyze_entry_stems(
    b: &[u8],
    gids: &[usize],
    cs_ranges: &[[usize; 2]],
    sim: &SimCtx,
) -> (EntryRec, Vec<bool>, Vec<bool>, bool) {
    let mut rec = EntryRec {
        map: HashMap::new(),
        exit_stems: HashMap::new(),
        exit_len: HashMap::new(),
        gsubr_exit: HashMap::new(),
        cs_masks: HashMap::new(),
        sn_masks: HashMap::new(),
        refs: HashSet::new(),
        consistent: true,
        bad_mask: false,
    };
    // per-gid 栈深超限标志（执行级真栈峰值，比线性浅扫精确），分发期免二次模拟
    let mut overflow = vec![false; cs_ranges.len()];
    // per-gid cs 顶层 callsubr 标志（执行级精确判定，分发期 rewrite 路径用）
    let mut has_subr = vec![false; cs_ranges.len()];
    // 本池执行路径上是否「gsubr 体内 callsubr」（禁重编号）
    let mut gcl = false;
    for &gi in gids {
        let r = cs_ranges[gi];
        let mut stack: Vec<Option<i32>> = Vec::new();
        let mut stems: usize = 0;
        let mut st = SimState { sim, overflow: false, rec: Some(&mut rec), gsubr_calls_local: false, top_has_subr: false };
        let frame = Frame { sn: gi as u32, conflicted: false, is_cs: true, is_gsubr: false };
        if !sim_exec(b, r[0], r[1], &mut st, &mut stack, &mut stems, 0, frame) {
            rec.consistent = false;
            break;
        }
        overflow[gi] = st.overflow;
        has_subr[gi] = st.top_has_subr;
        gcl |= st.gsubr_calls_local;
    }
    (rec, overflow, has_subr, gcl)
}

/// 检查 charstring 的 operand 峰值栈深是否超过 OTS 限制（执行级模拟）。
/// 超限字形不可透传，必须 stripHints 剥离 hint 区。
fn charstring_stack_overflows(b: &[u8], start: usize, end: usize, sim: &SimCtx) -> bool {
    let mut stack: Vec<Option<i32>> = Vec::new();
    let mut stems: usize = 0;
    let mut st = SimState { sim, overflow: false, rec: None, gsubr_calls_local: false, top_has_subr: false };
    let _ = sim_exec(b, start, end, &mut st, &mut stack, &mut stems, 0, FRAME_NOT_SUBR);
    st.overflow
}

/// 剥离 charstring 的 hint 区（stem 声明及其 operands、hintmask/cntrmask 及其掩码字节）。
/// 思源等源字体有字形 operand 栈深 >48（Adobe 合法但 OTS 拒收），剥 hint 后栈深必然合规。
/// 逐字节对应 TS 行为（含 callsubr/callgsubr 操作符丢弃、操作数保留的既有语义）。
/// 掩码字节的跳过宽度依赖执行期 num_stems（跨 callsubr 边界共享栈）：
/// 有预模拟记录时查表 O(1) 推进，降级池（rec=None）递归模拟跟进。
fn strip_hints(b: &[u8], start: usize, end: usize, sim: &SimCtx, rec: Option<&EntryRec>) -> Vec<u8> {
    let clamped_end = end.min(b.len());
    let mut out: Vec<u8> = Vec::new();
    let mut p = start;
    let mut stack: Vec<Option<i32>> = Vec::new();
    let mut stems: usize = 0;
    let mut st = SimState { sim, overflow: false, rec: None, gsubr_calls_local: false, top_has_subr: false };
    while p < clamped_end {
        let b0 = b[p];
        p += 1;
        if b0 >= 32 {
            out.push(b0);
            if b0 == 255 {
                stack.push(None);
                for _ in 0..4 {
                    out.push(u8_at(b, p));
                    p += 1;
                }
            } else if b0 >= 247 {
                if b0 <= 250 {
                    stack.push(Some((b0 as i32 - 247) * 256 + u8_at(b, p) as i32 + 108));
                } else {
                    stack.push(Some(-(b0 as i32 - 251) * 256 - u8_at(b, p) as i32 - 108));
                }
                out.push(u8_at(b, p));
                p += 1;
            } else {
                stack.push(Some(b0 as i32 - 139));
            }
            continue;
        }
        if b0 == 28 {
            stack.push(Some(i16_at(b, p) as i32));
            out.push(28);
            out.push(u8_at(b, p));
            out.push(u8_at(b, p + 1));
            p += 2;
            continue;
        }
        if b0 == T2_HSTEM || b0 == T2_VSTEM || b0 == T2_HSTEMHM || b0 == T2_VSTEMHM {
            // 丢弃操作码与栈上 operands：回退输出到本段 operand 起点
            out.truncate(out.len() - stack.len());
            stems += stack.len() >> 1;
            stack.clear();
            continue;
        }
        if b0 == T2_HINTMASK || b0 == T2_CNTRMASK {
            // 丢弃操作码与掩码字节；栈上 operands（若有）一并丢弃。
            // OTS/FreeType 语义：hintmask 栈上操作数是 vstem 声明（奇数含 width 时 ss>>1 恰为去 width 后的 stems 数），
            // 必须计入后掩码字节数才与源编码一致，否则漏跳掩码字节致后续流失步
            out.truncate(out.len() - stack.len());
            stems += stack.len() >> 1;
            p += (stems + 7) >> 3;
            stack.clear();
            continue;
        }
        if b0 == T2_CALLSUBR || b0 == T2_CALLGSUBR {
            // 操作符丢弃、操作数保留（TS 既有语义）；推进 stems/栈使后续原始流掩码字节
            // 的跳过宽度与读取方一致。查表 O(1)（返回栈空时）；否则递归模拟跟进；
            // 跟进成功时保留返回后的栈状态（跨边界输出模式后续 stem 依赖它），未跟进才清栈
            let top = stack.pop().flatten();
            let target = top.and_then(|v| {
                let hdr = if b0 == T2_CALLSUBR { sim.idx } else { sim.gsubr_hdr };
                let bias = if b0 == T2_CALLSUBR { sim.local_bias } else { sim.gsubr_bias };
                let sn = v + bias;
                if sn >= 0 && (sn as usize) < hdr.count { Some(sn as usize) } else { None }
            });
            // 常规快路径：预模拟记录的返回效应（栈空 → 直接赋累计 stems 并清栈）
            let fast: Option<(&EntryRec, usize, usize)> = match (rec, target) {
                (Some(rc), Some(tn)) => {
                    let el = if b0 == T2_CALLSUBR {
                        rc.exit_len.get(&(tn as u32)).copied()
                    } else {
                        rc.gsubr_exit.get(&(tn as u32)).map(|&e| e.1)
                    };
                    el.map(|el| (rc, tn, el))
                }
                _ => None,
            };
            let mut followed = false;
            if let Some((rc, tn, 0)) = fast {
                if b0 == T2_CALLSUBR {
                    stems = rc.exit_stems[&(tn as u32)];
                } else {
                    stems += rc.gsubr_exit[&(tn as u32)].0;
                }
                stack.clear();
                followed = true;
            } else if let Some(tn) = target {
                let hdr = if b0 == T2_CALLSUBR { sim.idx } else { sim.gsubr_hdr };
                let ss = hdr.data_start + index_offset_at(b, hdr.off_base, hdr.off_size, tn) as usize - 1;
                let se = hdr.data_start + index_offset_at(b, hdr.off_base, hdr.off_size, tn + 1) as usize - 1;
                if sim_exec(b, ss, se, &mut st, &mut stack, &mut stems, 1, FRAME_NOT_SUBR) {
                    followed = true;
                }
            }
            if !followed {
                stack.clear();
            }
            continue;
        }
        if b0 == 12 {
            out.push(12);
            out.push(u8_at(b, p));
            escape_stack_effect(u8_at(b, p), &mut stack);
            p += 1;
            continue;
        }
        out.push(b0);
        if b0 == T2_ENDCHAR {
            break;
        }
        stack.clear();
    }
    out
}

/// 在升序 remap 表中二分查找旧 subr 编号，返回新编号（未保留返回 None）
fn remap_lookup(sorted_refs: &[u32], old_sn: u32) -> Option<u32> {
    let mut lo: usize = 0;
    let mut hi: usize = sorted_refs.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if sorted_refs[mid] < old_sn {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo < sorted_refs.len() && sorted_refs[lo] == old_sn {
        return Some(lo as u32);
    }
    None
}

/// 重写 Type 2 charstring/subr（语法级）：把 callsubr 的调用编号 operand 重映射到子集编号
/// （减新 bias），掩码字节与其余内容原样拷贝。global subr 不子集化（callgsubr operand 原样，
/// bias 不变）。
/// 正确性基础（由 analyze_entry_stems→sim_exec 预模拟保证，否则池已降级透传）：
/// 1. callsubr/callgsubr 栈顶必为紧邻字面量（算术/dup/drop 中间操作 → 栈顶非字面量 → 池降级），
///    故 operand 取「最近一次入栈的源流字面量」即可，无需执行栈推进
/// 2. rewrite 只改 callsubr 编号，字形执行点 stems 序列不变 → 掩码物理宽度不变，
///    跳宽查预模拟记录表 masks（key=(帧键, mask op 绝对位置)；帧键 cs=gid、subr=旧 sn）
/// 返回 None：语法扫描遇预模拟未覆盖的形态（防御）→ 调用方整池降级透传。
fn rewrite_charstring(
    b: &[u8],
    start: usize,
    end: usize,
    frame_key: u32,
    sorted_refs: &[u32],
    old_local_bias: i32,
    masks: &HashMap<(u32, u32), u16>,
) -> Option<Vec<u8>> {
    let new_local_bias = subr_bias(sorted_refs.len());
    let clamped_end = end.min(b.len());
    // 容量上界：callsubr 重编码最长 5 字节（原最长 5 字节），少量富余即可
    let mut out: Vec<u8> = Vec::with_capacity(clamped_end.saturating_sub(start) + 16);
    // 最近一次入栈的源流字面量（值 + 输出中起始写位置）；None = 不可作调用编号
    let mut pending: Option<(i32, usize)> = None;
    let mut p = start;
    while p < clamped_end {
        let b0 = b[p];
        p += 1;
        if b0 >= 32 {
            let wp_start = out.len();
            if b0 <= 246 {
                pending = Some((b0 as i32 - 139, wp_start));
                out.push(b0);
            } else if b0 == 255 {
                // fixed point：不可作调用编号
                pending = None;
                out.extend_from_slice(&b[p - 1..p + 4]);
                p += 4;
            } else if b0 <= 250 {
                pending = Some(((b0 as i32 - 247) * 256 + u8_at(b, p) as i32 + 108, wp_start));
                out.push(b0);
                out.push(u8_at(b, p));
                p += 1;
            } else {
                pending = Some((-(b0 as i32 - 251) * 256 - u8_at(b, p) as i32 - 108, wp_start));
                out.push(b0);
                out.push(u8_at(b, p));
                p += 1;
            }
        } else if b0 == 28 {
            pending = Some((i16_at(b, p) as i32, out.len()));
            out.push(28);
            out.push(u8_at(b, p));
            out.push(u8_at(b, p + 1));
            p += 2;
        } else if b0 == 12 {
            // escape 算术/逻辑：消费操作数，结果不可作调用编号
            out.push(12);
            out.push(u8_at(b, p));
            p += 1;
            pending = None;
        } else if b0 == T2_HINTMASK || b0 == T2_CNTRMASK {
            let op_pos = p - 1;
            // 掩码字节原样拷贝，跳宽查预模拟表（物理宽度 = 各执行点宽度，预模拟已校验一致）
            let skip = *masks.get(&(frame_key, op_pos as u32))? as usize;
            out.push(b0);
            for j in 0..skip {
                out.push(u8_at(b, p + j));
            }
            p += skip;
            pending = None;
        } else if b0 == T2_HSTEM || b0 == T2_VSTEM || b0 == T2_HSTEMHM || b0 == T2_VSTEMHM {
            out.push(b0);
            pending = None;
        } else if b0 == T2_CALLSUBR {
            let (lv, wp_start) = pending?;
            let old_sn = lv + old_local_bias;
            let new_sn = if old_sn >= 0 { remap_lookup(sorted_refs, old_sn as u32) } else { None };
            match new_sn {
                None => {
                    // subr 未保留（refs 闭包保证不发生）：保底保留原 operand
                    out.push(T2_CALLSUBR);
                }
                Some(sn) => {
                    // 截断到 operand 起始，重编码新编号（编码长度可能变化）
                    out.truncate(wp_start);
                    let mut ew = W { buf: out };
                    ew.dict_int(sn as i32 - new_local_bias);
                    out = ew.buf;
                    out.push(T2_CALLSUBR);
                }
            }
            pending = None;
        } else if b0 == T2_CALLGSUBR {
            // global subr 不子集化：operand 已随扫描原样复制，bias 不变
            out.push(T2_CALLGSUBR);
            pending = None;
        } else if b0 == T2_ENDCHAR {
            out.push(b0);
            break;
        } else {
            // return/绘图/其它操作码：透传；操作数已被消费
            out.push(b0);
            pending = None;
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// INDEX / charset / FDSelect 编码
// ---------------------------------------------------------------------------

/// 序列化 CFF INDEX：count + offSize + (count+1)*offSize 偏移量 + 数据拼接。
/// offSize 选容纳最大偏移量的最小字节数；偏移量 1-based（首个 offset=1）。
fn write_index(objects: &[&[u8]]) -> Vec<u8> {
    let count = objects.len();
    if count == 0 {
        // count=0 的空 INDEX 仅 2 字节
        return vec![0, 0];
    }
    let total_data: usize = objects.iter().map(|o| o.len()).sum();
    let max_offset = total_data + 1;

    // offSize 选择复刻 TS writeIndex 的既有算法：初始 if/else 后 while 还会再 ++，
    // 故 maxOffset>0xff 时实际 offSize = 2+floor(log256(maxOffset/256))+1（如 9729 得 3 而非 2）。
    // 字节级对拍要求 bug-for-bug 一致（Top DICT INDEX 的 patchedTopDictOffSize 才是普通最小规则）。
    let mut off_size: u8 = 1;
    if max_offset > 0xffff {
        off_size = 4;
    } else if max_offset > 0xff {
        off_size = 2;
    }
    let mut tmp = max_offset;
    while tmp > 0xff && off_size < 4 {
        off_size += 1;
        tmp >>= 8;
    }

    let offsets_size = (count + 1) * off_size as usize;
    let mut out = vec![0u8; 2 + 1 + offsets_size + total_data];
    out[0] = ((count >> 8) & 0xff) as u8;
    out[1] = (count & 0xff) as u8;
    out[2] = off_size;

    // 写偏移量（1-based 大端 offSize 字节）
    let mut op: usize = 3;
    let mut acc: u32 = 1;
    for oi in 0..=count {
        let mut s: i32 = off_size as i32 * 8 - 8;
        while s >= 0 {
            out[op] = ((acc >> s) & 0xff) as u8;
            op += 1;
            s -= 8;
        }
        if oi < count {
            acc += objects[oi].len() as u32;
        }
    }

    // 写数据
    let mut dp: usize = 3 + offsets_size;
    for o in objects {
        out[dp..dp + o.len()].copy_from_slice(o);
        dp += o.len();
    }
    out
}

/// 按需查询单个原始 gid 的 FD index（格式 0 直接取字节；格式 3 二分找最后一个 first<=gid 的 range）
fn lookup_fd_select(b: &[u8], fd_select_off: usize, gid: usize) -> u32 {
    let fmt = u8_at(b, fd_select_off);
    if fmt == 0 {
        return u8_at(b, fd_select_off + 1 + gid) as u32;
    }
    // format 3：ranges 起始 = fdSelectOff + 3，每 range 3 字节 [first(u16), fd(u8)]，尾接 sentinel(u16)
    let n_ranges = u16_at(b, fd_select_off + 1) as usize;
    if n_ranges == 0 {
        return 0;
    }
    let ranges_start = fd_select_off + 3;
    let mut lo: usize = 0;
    let mut hi: usize = n_ranges - 1;
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        let first = u16_at(b, ranges_start + mid * 3) as usize;
        if first <= gid {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    u8_at(b, ranges_start + lo * 3 + 2) as u32
}

/// 编码 FDSelect：单 FD 用格式 0（最省）；多 FD 用格式 3 ranges（连续相同 FD 合并，
/// 与原始 CID 字体结构一致，规避 OTS 严格校验）
struct FdRange {
    first: u16,
    fd: u16,
}

fn encode_fd_select(gid_to_fd: &[u16]) -> Vec<u8> {
    let mut w = W::new();
    // 单 FD 判定（空表 → 非 single，但后续 ranges 循环产出空 ranges + 单 sentinel，与 Zig 一致）
    let is_single = match gid_to_fd.first() {
        None => false,
        Some(&first) => gid_to_fd.iter().all(|&fd| fd == first),
    };
    if is_single {
        w.w8(0);
        for &fd in gid_to_fd {
            // @intCast：fd >255 时 Zig 会 panic，合法字体 FD 编号恒 <256
            w.w8(fd as u8);
        }
        return w.buf;
    }
    // 多 FD：格式 3 ranges
    w.w8(3);
    let mut ranges: Vec<FdRange> = Vec::new();
    let mut cur_first: usize = 0;
    let mut cur_fd: u16 = gid_to_fd.first().copied().unwrap_or(0);
    for (i, &fd) in gid_to_fd.iter().enumerate() {
        if i == 0 {
            continue;
        }
        if fd != cur_fd {
            // @intCast：gid 数 >65535 时 Zig 会 panic，CFF numGlyphs 上限 65535
            ranges.push(FdRange { first: cur_first as u16, fd: cur_fd });
            cur_first = i;
            cur_fd = fd;
        }
    }
    ranges.push(FdRange { first: cur_first as u16, fd: cur_fd });
    w.w16(ranges.len() as u16);
    for r in &ranges {
        w.w16(r.first);
        w.w8(r.fd as u8);
    }
    // sentinel = numGlyphs（最后一个 range 之后的第一个 gid）
    w.w16(gid_to_fd.len() as u16);
    w.buf
}

/// 按需查询单个原始 gid 的 CID/SID。格式 0 直接取（charset 表不含 gid 0）；
/// 格式 1/2 遍历 range 找覆盖 gid 的（range 数远小于 numGlyphs）。
/// charset_off 为 None（Top DICT 无 charset op）时按 ISOAdobe 隐式 charset：编号 = gid。
fn lookup_charset_cid(b: &[u8], charset_off: Option<usize>, gid: u16) -> u32 {
    if gid == 0 {
        return 0;
    }
    let co = match charset_off {
        Some(v) => v,
        None => return gid as u32,
    };
    let fmt = u8_at(b, co);
    if fmt == 0 {
        return u16_at(b, co + 1 + (gid as usize - 1) * 2) as u32;
    }
    let mut p = co + 1;
    let mut range_first_gid: u32 = 1;
    if fmt == 1 {
        while p + 3 <= b.len() {
            let first_cid = u16_at(b, p) as u32;
            let n_left = u8_at(b, p + 2) as u32;
            if gid as u32 >= range_first_gid && gid as u32 <= range_first_gid + n_left {
                return first_cid + (gid as u32 - range_first_gid);
            }
            range_first_gid += n_left + 1;
            p += 3;
        }
        return 0;
    }
    // fmt == 2
    while p + 4 <= b.len() {
        let first_cid = u16_at(b, p) as u32;
        let n_left = u16_at(b, p + 2) as u32;
        if gid as u32 >= range_first_gid && gid as u32 <= range_first_gid + n_left {
            return first_cid + (gid as u32 - range_first_gid);
        }
        range_first_gid += n_left + 1;
        p += 4;
    }
    0
}

/// 编码 charset 格式 0：format(1) + cids×(u16)
fn encode_charset_format0(cids: &[u32]) -> Vec<u8> {
    let mut w = W::new();
    w.w8(0);
    for &cid in cids {
        w.w16((cid & 0xffff) as u16);
    }
    w.buf
}

// ---------------------------------------------------------------------------
// DICT patch
// ---------------------------------------------------------------------------

/// DICT 单操作码替换项
struct DictReplace {
    op: u32,
    val: i32,
}

/// 替换 DICT 中多个操作码的操作数（offset 值）；drops 中的操作码连同其操作数整体删除。
/// 扫描原 DICT：命中替换项→写新编码操作数+操作码；命中 drop→跳过；其余字节原样保留。
/// BCD 实数操作数完整跳过（如 CIDFontVersion）。
fn replace_dict_offsets(dict_bytes: &[u8], replacements: &[DictReplace], drops: &[u32]) -> Vec<u8> {
    let mut w = W::new();
    w.buf.reserve(dict_bytes.len() + replacements.len() * 4 + 16);
    let mut p: usize = 0;
    let mut operand_start: usize = 0;
    let l = dict_bytes.len();
    while p < l {
        let b0 = dict_bytes[p];
        p += 1;
        if b0 <= 21 {
            let op: u32 = if b0 == 12 {
                let o = (12u32 << 8) | u8_at(dict_bytes, p) as u32;
                p += 1;
                o
            } else {
                b0 as u32
            };
            let mut replaced = false;
            let mut dropped = false;
            for r in replacements {
                if r.op == op {
                    w.dict_int(r.val);
                    if op >= 256 {
                        w.w8(12);
                        w.w8((op & 0xff) as u8);
                    } else {
                        w.w8(op as u8);
                    }
                    replaced = true;
                    break;
                }
            }
            if !replaced {
                for &d in drops {
                    if d == op {
                        dropped = true;
                        break;
                    }
                }
            }
            if !replaced && !dropped {
                w.w_bytes(&dict_bytes[operand_start..p]);
            }
            operand_start = p;
        } else if b0 == 28 {
            p += 2;
        } else if b0 == 29 {
            p += 4;
        } else if b0 == 30 {
            while p < l {
                let byte = dict_bytes[p];
                p += 1;
                if (byte >> 4) == 0xf || (byte & 0xf) == 0xf {
                    break;
                }
            }
        } else if (247..=254).contains(&b0) {
            p += 1;
        }
        // 32~246 单字节操作数，无后续
    }
    w.buf
}

/// 替换 DICT 的 Private 操作数 [length, offset]（Top DICT / FD DICT 共用）。
/// 扫描定位操作码 18，将其前两个操作数替换为新编码 [priv_len, new_priv_off]，其余字节原样保留。
fn replace_dict_private_operands(dict_bytes: &[u8], priv_len: i32, new_priv_off: i32) -> Vec<u8> {
    let mut w = W::new();
    let mut p: usize = 0;
    let mut operand_start: usize = 0;
    let l = dict_bytes.len();
    while p < l {
        let b0 = dict_bytes[p];
        p += 1;
        if b0 <= 21 {
            let op: u32 = if b0 == 12 {
                let o = (12u32 << 8) | u8_at(dict_bytes, p) as u32;
                p += 1;
                o
            } else {
                b0 as u32
            };
            if op == OP_PRIVATE {
                w.dict_int(priv_len);
                w.dict_int(new_priv_off);
                w.w8(18);
            } else {
                w.w_bytes(&dict_bytes[operand_start..p]);
            }
            operand_start = p;
        } else if b0 == 28 {
            p += 2;
        } else if b0 == 29 {
            p += 4;
        } else if b0 == 30 {
            while p < l {
                let byte = dict_bytes[p];
                p += 1;
                if (byte >> 4) == 0xf || (byte & 0xf) == 0xf {
                    break;
                }
            }
        } else if (247..=254).contains(&b0) {
            p += 1;
        }
    }
    w.buf
}

/// patch Private DICT 的 Local Subr 操作数（op 19），使其指向新 DICT 长度
/// （Local Subr INDEX 紧跟 Private DICT 字节之后）。op19 编码长度随值变化（影响 DICT 总长），
/// 迭代至稳定。无 Local Subr（has_subr=false）的 Private 原样透传。
fn patch_private_dict(b: &[u8], priv_orig_off: usize, priv_len: usize, has_subr: bool) -> Vec<u8> {
    if !has_subr {
        return b[priv_orig_off..priv_orig_off + priv_len].to_vec();
    }
    let mut cur: Vec<u8> = b[priv_orig_off..priv_orig_off + priv_len].to_vec();
    for _ in 0..4 {
        let patched = replace_dict_offsets(&cur, &[DictReplace { op: OP_LOCAL_SUBR, val: cur.len() as i32 }], &[]);
        if patched.len() == cur.len() {
            return patched;
        }
        cur = patched;
    }
    cur
}

// ---------------------------------------------------------------------------
// Private 池（Local Subr 子集化）
// ---------------------------------------------------------------------------

/// 一个 Private 段（CID 多 FD 共享去重；非 CID 单池）的 Local Subr 子集化上下文
struct PrivPool {
    /// 原 Private DICT 绝对偏移（NO_PRIV = 无 Private）
    orig_off: usize,
    /// 原 Private DICT 字节长度（不含 Local Subr INDEX）
    len: usize,
    /// Local Subr INDEX 头部（None = 无 Local Subr）
    idx: Option<IndexHeader>,
    /// 原 local subr bias
    local_bias: i32,
    /// 收集到的 subr 引用（fixpoint 收敛后为闭包）
    refs: HashSet<u32>,
    /// 引用闭包的升序数组（新编号 = 数组下标）；None = 无 subr
    sorted_refs: Option<Vec<u32>>,
    /// 重建后的 Local Subr INDEX 字节（无 subr 为空 INDEX 2 字节）
    new_local_subr: Vec<u8>,
    /// 执行级预模拟记录（降级透传池为 None）
    rec: Option<EntryRec>,
}

impl PrivPool {
    /// 创建一个无 Private 的占位池（FD 无 Private 时的 FDArray 透传占位，不会被字形引用）
    fn empty_placeholder() -> PrivPool {
        PrivPool {
            orig_off: NO_PRIV,
            len: 0,
            idx: None,
            local_bias: 0,
            refs: HashSet::new(),
            sorted_refs: None,
            new_local_subr: Vec::new(),
            rec: None,
        }
    }
}

/// 解析 Private DICT 的 op19（Local Subr INDEX 相对 Private 起始的偏移）并初始化池
fn init_pool_subrs(b: &[u8], pool: &mut PrivPool) {
    let priv_dict = parse_dict(b, pool.orig_off, pool.orig_off + pool.len);
    let subr_rel = match priv_dict.get(&OP_LOCAL_SUBR) {
        Some(v) => v,
        None => return,
    };
    if subr_rel.is_empty() {
        return;
    }
    // @intCast：负偏移时 Zig 会 panic，合法字体 op19 非负
    let subr_abs = pool.orig_off + subr_rel[0] as usize;
    let idx = read_index_header(b, subr_abs);
    pool.local_bias = subr_bias(idx.count);
    pool.idx = Some(idx);
}

/// 取或创建 Private 池（相同 orig_off 的 Private 共享一份，多 FD 合并引用集）。
/// 返回 pools 数组下标（Zig 版以 *PrivPool 指针共享，Rust 版以下标等价）。
fn get_or_create_pool(
    b: &[u8],
    priv_orig_off: usize,
    priv_len: usize,
    pool_by_orig: &mut HashMap<usize, usize>,
    pools: &mut Vec<PrivPool>,
) -> usize {
    if let Some(&idx) = pool_by_orig.get(&priv_orig_off) {
        return idx;
    }
    let mut pool = PrivPool {
        orig_off: priv_orig_off,
        len: priv_len,
        idx: None,
        local_bias: 0,
        refs: HashSet::new(),
        sorted_refs: None,
        new_local_subr: Vec::new(),
        rec: None,
    };
    init_pool_subrs(b, &mut pool);
    let idx = pools.len();
    pools.push(pool);
    pool_by_orig.insert(priv_orig_off, idx);
    idx
}

// ---------------------------------------------------------------------------
// 子集化主入口
// ---------------------------------------------------------------------------

/// CFF 表子集化（对译 subsetCFF）。
/// * `subset_gids` - 子集字形原始 gid 顺序（含 0 = .notdef，新 gid = 数组索引）
/// * 返回 - 子集 CFF 字节；结构不支持返回 None（调用方降级）
pub fn subset_cff(cff_tbl: &[u8], subset_gids: &[u16]) -> Result<Option<Vec<u8>>, CffError> {
    let b = cff_tbl;
    if b.len() < 4 {
        return Ok(None);
    }
    // Header: major(1) minor(1) hdrSize(1) offSize(1)
    let hdr_size = b[2] as usize;
    if hdr_size >= b.len() {
        return Ok(None);
    }
    // Name INDEX 紧接 Header（仅需字节范围透传）
    let name_hdr = read_index_header(b, hdr_size);
    // Top DICT INDEX 紧接 Name INDEX
    let top_dict_index = read_index_full(b, name_hdr.end);
    if top_dict_index.count < 1 {
        return Ok(None);
    }

    let td_start = top_dict_index.data_start + top_dict_index.offsets[0] as usize - 1;
    let td_end = top_dict_index.data_start + top_dict_index.offsets[1] as usize - 1;
    let top_dict = parse_dict(b, td_start, td_end);

    // 非 CID 字体（无 ROS）走 name-keyed 单 Private 路径；CID 走 FDArray/FDSelect 路径
    let is_cid = top_dict.contains_key(&OP_ROS);
    let ctx = CffContext {
        name_hdr,
        top_dict_index,
        td_start,
        td_end,
        top_dict: &top_dict,
        is_cid,
    };
    Ok(Some(subset_cff_common(b, subset_gids, &ctx)?))
}

/// FD DICT（CID）或占位（无 Private）的记录
struct FdInfo<'a> {
    /// 原 FD DICT 字节
    dict_bytes: &'a [u8],
    /// 关联 Private 池（pools 数组下标）
    pool_idx: usize,
    /// 是否有 Private（无则 FD DICT 原样透传）
    has_priv: bool,
}

/// 共用实现的上下文（CID / 非 CID 两条路径的结构差异集中在 FDArray/FDSelect/Private 来源）
struct CffContext<'a> {
    name_hdr: IndexHeader,
    top_dict_index: FullIndex,
    td_start: usize,
    td_end: usize,
    top_dict: &'a HashMap<u32, Vec<i32>>,
    is_cid: bool,
}

/// 共用实现（CID / 非 CID 两条路径的结构差异集中在 FDArray/FDSelect/Private 来源）
fn subset_cff_common(b: &[u8], subset_gids: &[u16], ctx: &CffContext) -> Result<Vec<u8>, CffError> {
    let td = ctx.top_dict;
    let is_cid = ctx.is_cid;

    let charset_op = td.get(&OP_CHARSET);
    // @intCast：负 offset 时 Zig 会 panic，合法字体 DICT offset 非负
    let charset_off: Option<usize> = charset_op.map(|o| o[0] as usize);
    let fd_array_op = td.get(&OP_FD_ARRAY);
    let fd_select_op = td.get(&OP_FD_SELECT);
    // 非 CID：Private 挂 Top DICT；CID：FDArray/FDSelect 必需
    let plain_priv_op = if !is_cid { td.get(&OP_PRIVATE) } else { None };

    let char_strings_op = match td.get(&OP_CHARSTRINGS) {
        Some(v) => v,
        None => return Err(CffError::UnsupportedCff),
    };
    if is_cid && (charset_op.is_none() || fd_array_op.is_none() || fd_select_op.is_none()) {
        return Err(CffError::UnsupportedCff);
    }

    // String INDEX / Global Subr INDEX（字节范围透传）
    let string_hdr = read_index_header(b, ctx.top_dict_index.end);
    let gsubr_hdr = read_index_header(b, string_hdr.end);

    // CharStrings INDEX 头部（count + offSize），不全量解析 offset（思源 65535 glyph），按 gid 随机读
    let cs_off = char_strings_op[0] as usize;
    let cs_off_size = u8_at(b, cs_off + 2);
    let cs_off_arr_start = cs_off + 3;
    let cs_data_start = cs_off_arr_start + (u16_at(b, cs_off) as usize + 1) * cs_off_size as usize;
    if subset_gids.is_empty() {
        return Err(CffError::UnsupportedCff);
    }

    // .notdef（gid 0）必须保留且在首位
    let new_gids: Vec<u16> = if subset_gids[0] != 0 {
        let mut arr = Vec::with_capacity(subset_gids.len() + 1);
        arr.push(0);
        arr.extend_from_slice(subset_gids);
        arr
    } else {
        subset_gids.to_vec()
    };
    let n_glyphs = new_gids.len();

    // 每个子集字形在原 CharStrings 的字节区间 [start, end)
    let mut cs_ranges: Vec<[usize; 2]> = Vec::with_capacity(n_glyphs);
    for &gid in &new_gids {
        let o0 = index_offset_at(b, cs_off_arr_start, cs_off_size, gid as usize);
        let o1 = index_offset_at(b, cs_off_arr_start, cs_off_size, gid as usize + 1);
        cs_ranges.push([cs_data_start + o0 as usize - 1, cs_data_start + o1 as usize - 1]);
    }

    // 每个子集字形的 charstring 是否含 CALLSUBR（决定是否需 rewrite）
    let mut gid_has_subr = vec![false; n_glyphs];

    // 重建 charset：格式 0，gid 1..n-1 的 CID/SID（gid 0 隐式为 0 不入表）
    let mut charset_cids: Vec<u32> = Vec::with_capacity(n_glyphs - 1);
    for i in 1..n_glyphs {
        charset_cids.push(lookup_charset_cid(b, charset_off, new_gids[i]));
    }
    let charset_seg = encode_charset_format0(&charset_cids);

    // ---- FD/Private 池 ----
    // CID：原FD→新FD 映射 + 每 gid 的原 FD；非 CID：单池（Top DICT op 18）
    let mut pools: Vec<PrivPool> = Vec::new();
    let mut fd_remap: HashMap<u32, usize> = HashMap::new();
    let mut gid_orig_fds: Vec<u32> = Vec::new();
    let mut fd_infos: Vec<FdInfo> = Vec::new();
    let mut pool_by_orig: HashMap<usize, usize> = HashMap::new();

    if is_cid {
        let fd_select_off = fd_select_op.unwrap()[0] as usize;
        let mut used_fds: Vec<u32> = Vec::new();
        for &gid in &new_gids {
            let fd = lookup_fd_select(b, fd_select_off, gid as usize);
            gid_orig_fds.push(fd);
            if let Entry::Vacant(e) = fd_remap.entry(fd) {
                e.insert(used_fds.len());
                used_fds.push(fd);
            }
        }

        let fd_array_index = read_index_full(b, fd_array_op.unwrap()[0] as usize);
        for &fd in &used_fds {
            let fdu = fd as usize;
            let s = fd_array_index.data_start + fd_array_index.offsets[fdu] as usize - 1;
            let e = fd_array_index.data_start + fd_array_index.offsets[fdu + 1] as usize - 1;
            let dict_bytes = &b[s..e];
            let fd_dict = parse_dict(b, s, e);
            let priv_op = match fd_dict.get(&OP_PRIVATE) {
                Some(v) if v.len() >= 2 => v,
                _ => {
                    // 无 Private 的 FD（极罕见）：FD DICT 原样透传
                    pools.push(PrivPool::empty_placeholder());
                    fd_infos.push(FdInfo { dict_bytes, pool_idx: pools.len() - 1, has_priv: false });
                    continue;
                }
            };
            let priv_len = priv_op[0] as usize;
            let priv_orig_off = priv_op[1] as usize;
            let pool_idx = get_or_create_pool(b, priv_orig_off, priv_len, &mut pool_by_orig, &mut pools);
            fd_infos.push(FdInfo { dict_bytes, pool_idx, has_priv: true });
        }
    } else {
        // 非 CID：单 Private 池（来自 Top DICT op 18）
        let pool = if plain_priv_op.map_or(false, |v| v.len() >= 2) {
            let v = plain_priv_op.unwrap();
            let mut p = PrivPool {
                // @intCast：负 len/offset 时 Zig 会 panic，合法字体非负
                orig_off: v[1] as usize,
                len: v[0] as usize,
                idx: None,
                local_bias: 0,
                refs: HashSet::new(),
                sorted_refs: None,
                new_local_subr: Vec::new(),
                rec: None,
            };
            init_pool_subrs(b, &mut p);
            p
        } else {
            PrivPool::empty_placeholder()
        };
        pools.push(pool);
    }

    // 引用闭包收敛 + 执行级 stem 预模拟 + 旧→新映射 + 重建 Local Subr INDEX
    let gsubr_bias = subr_bias(gsubr_hdr.count);
    // 每 pool 负责的子集 gid 列表（执行级预模拟范围）
    let mut pool_gids: Vec<Vec<usize>> = vec![Vec::new(); pools.len()];
    if is_cid {
        for i in 0..n_glyphs {
            if let Some(&fd_idx) = fd_remap.get(&gid_orig_fds[i]) {
                if fd_infos[fd_idx].has_priv {
                    pool_gids[fd_infos[fd_idx].pool_idx].push(i);
                }
            }
        }
    } else {
        pool_gids[0] = (0..n_glyphs).collect();
    }
    // per-gid 栈深超限标志（预模拟执行级真栈峰值，分发期免二次模拟）
    let mut gid_overflow = vec![false; n_glyphs];
    // per-pool 预重写好的 charstring 字节（gi → bytes），dispatch 直接取用
    let mut pool_cs_rewritten: Vec<Option<HashMap<usize, Vec<u8>>>> = vec![None; pools.len()];
    for pi in 0..pools.len() {
        if pools[pi].idx.is_none() {
            continue;
        }
        // 注：引用闭包不再做语法扫描 fixpoint（hintmask 跳宽错位会漏收集），执行级
        // analyze 的 rec.refs 即精确闭包（递归覆盖嵌套），见 EntryRec.refs 注释
        let sim = SimCtx {
            idx: pools[pi].idx.unwrap(),
            local_bias: pools[pi].local_bias,
            gsubr_hdr,
            gsubr_bias,
        };
        // 执行级预模拟：OTS 的 operand 栈与 num_stems 跨 callsubr 边界共享，
        // 「subr 消费调用方压栈操作数」模式（思源 Bold subr5572）静态线性扫描原理上无法计数；
        // 记录各 subr 进入/返回时刻的精确状态（rewrite/strip 查表 O(1) 推进）与 per-gid 栈深超限标志。
        // 不可分析（病态流/调用点效应不一致）或 gsubr 体内 callsubr 时该池降级透传
        let (rec, ovf, has_subr, gcl) = analyze_entry_stems(b, &pool_gids[pi], &cs_ranges, &sim);
        // gsubr 体内含 callsubr：local subr 不可重编号（透传 gsubr 的 operand 仍指旧编号），
        // Local Subr INDEX 原样保留（仅 patch op19 偏移），charstring 走透传/剥 hint 路径。
        // 执行级 per-pool 判定：仅本池字形执行路径可达的 gsubr 命中才算，替代全 INDEX 扫描
        if gcl || !rec.consistent || rec.bad_mask {
            let idx = pools[pi].idx.as_ref().unwrap();
            pools[pi].new_local_subr = b[idx.start..idx.end].to_vec();
            continue;
        }
        for &gi in &pool_gids[pi] {
            gid_overflow[gi] = ovf[gi];
            gid_has_subr[gi] = has_subr[gi];
        }
        // 执行级 refs 并入（语法扫描可能因 mask 跳宽错位漏收集，见 EntryRec.refs 注释）
        pools[pi].refs.extend(rec.refs.iter().copied());
        let mut sorted: Vec<u32> = pools[pi].refs.iter().copied().collect();
        sorted.sort_unstable();
        // 语法级重写池内含 CALLSUBR 的字形与被引用 subr body（任一遇预模拟未覆盖的形态
        // → 整池降级透传：cs 重写必须在 INDEX 重写前完成，否则降级无法回滚已改编号的 INDEX）
        let idx = pools[pi].idx.as_ref().unwrap();
        let mut cs_rewritten: HashMap<usize, Vec<u8>> = HashMap::new();
        let mut deg = false;
        for &gi in &pool_gids[pi] {
            if !gid_has_subr[gi] {
                continue;
            }
            let r = &cs_ranges[gi];
            match rewrite_charstring(b, r[0].min(b.len()), r[1].min(b.len()), gi as u32, &sorted, pools[pi].local_bias, &rec.cs_masks) {
                Some(obj) => {
                    cs_rewritten.insert(gi, obj);
                }
                None => {
                    deg = true;
                    break;
                }
            }
        }
        let mut objects_owned: Vec<Vec<u8>> = Vec::new();
        if !deg && !sorted.is_empty() {
            // 重建 INDEX：按新顺序写出被引用 subr 的重写字节（subr 内部 callsubr 也需重映射）
            for &old_sn in &sorted {
                let ss = idx.data_start + index_offset_at(b, idx.off_base, idx.off_size, old_sn as usize) as usize - 1;
                let se = idx.data_start + index_offset_at(b, idx.off_base, idx.off_size, old_sn as usize + 1) as usize - 1;
                match rewrite_charstring(b, ss, se, old_sn, &sorted, pools[pi].local_bias, &rec.sn_masks) {
                    Some(obj) => objects_owned.push(obj),
                    None => {
                        deg = true;
                        break;
                    }
                }
            }
        }
        if deg {
            for &gi in &pool_gids[pi] {
                gid_overflow[gi] = false;
            }
            pools[pi].new_local_subr = b[idx.start..idx.end].to_vec();
            continue;
        }
        pools[pi].rec = Some(rec);
        pools[pi].sorted_refs = Some(sorted);
        pool_cs_rewritten[pi] = Some(cs_rewritten);
        if objects_owned.is_empty() {
            // 无引用：输出空 INDEX（count=0，2 字节）
            pools[pi].new_local_subr = write_index(&[]);
        } else {
            let objects: Vec<&[u8]> = objects_owned.iter().map(|v| v.as_slice()).collect();
            pools[pi].new_local_subr = write_index(&objects);
        }
    }

    // 重建 CharStrings INDEX：含 CALLSUBR 的字形 rewrite（重映射 local subr 编号）；
    // OTS 栈深超限的剥 hint；否则透传原字节。global subr 不子集化，callgsubr operand 原样保留。
    let mut cs_objects_owned: Vec<Vec<u8>> = Vec::with_capacity(n_glyphs);
    for (gi, r) in cs_ranges.iter().enumerate() {
        let pool_idx: Option<usize> = if is_cid {
            match fd_remap.get(&gid_orig_fds[gi]) {
                Some(&fd_idx) if fd_infos[fd_idx].has_priv => Some(fd_infos[fd_idx].pool_idx),
                _ => None,
            }
        } else {
            Some(0)
        };
        let has_remap = match pool_idx {
            Some(pi) => pools[pi].sorted_refs.as_ref().is_some_and(|s| !s.is_empty()),
            None => false,
        };
        // 本字形所属池的模拟上下文（无 Private 时用空占位，callsubr 按不可分析处理）
        let sim = match pool_idx {
            Some(pi) => {
                let pl = &pools[pi];
                SimCtx {
                    idx: pl.idx.unwrap_or_else(|| SimCtx::empty(gsubr_hdr).idx),
                    local_bias: pl.local_bias,
                    gsubr_hdr,
                    gsubr_bias,
                }
            }
            None => SimCtx::empty(gsubr_hdr),
        };
        // 池级预模拟记录（降级透传池 / 无 Private 池为 None）
        let pool_rec = pool_idx.and_then(|pi| pools[pi].rec.as_ref());
        let obj: Vec<u8> = if pool_idx.is_some() && has_remap && gid_has_subr[gi] {
            // pool 循环已预重写并校验过（任一失败整池降级），此处直接取用
            pool_cs_rewritten[pool_idx.unwrap()].as_mut().unwrap().remove(&gi).unwrap()
        } else if pool_rec.is_some() && gid_overflow[gi] {
            // 思源等源字体有字形 operand 栈深 >48（Adobe 合规但 OTS 拒收），剥 hint 区
            strip_hints(b, r[0], r[1], &sim, pool_rec)
        } else if pool_rec.is_none() && charstring_stack_overflows(b, r[0], r[1], &sim) {
            // 降级池（无预模拟记录）：逐字形模拟判定栈深
            strip_hints(b, r[0], r[1], &sim, None)
        } else {
            let s = r[0].min(b.len());
            let e = r[1].min(b.len());
            b[s..e].to_vec()
        };
        cs_objects_owned.push(obj);
    }
    let cs_objects: Vec<&[u8]> = cs_objects_owned.iter().map(|v| v.as_slice()).collect();
    let charstrings_seg = write_index(&cs_objects);

    // 新 FDSelect（CID）：单 FD 格式 0（最省）/ 多 FD 格式 3 ranges
    let mut fdselect_seg: Vec<u8> = Vec::new();
    if is_cid {
        let mut new_gid_to_fd: Vec<u16> = Vec::with_capacity(n_glyphs);
        for i in 0..n_glyphs {
            new_gid_to_fd.push(fd_remap.get(&gid_orig_fds[i]).copied().unwrap_or(0) as u16);
        }
        fdselect_seg = encode_fd_select(&new_gid_to_fd);
    }

    // ---- 组装：Header+Name + TopDICT INDEX + String + GlobalSubr + charset + CharStrings
    //      + [FDArray + FDSelect] + Private 段；Top DICT / FD DICT / Private op19 偏移联合迭代收敛
    //      （三者 patch 后长度互相影响后续偏移，用长度不变做收敛判定）----
    let header_name = &b[0..ctx.name_hdr.end];
    let string_seg = &b[string_hdr.start..string_hdr.end];
    let gsubr_seg = &b[gsubr_hdr.start..gsubr_hdr.end];
    let top_dict_bytes = &b[ctx.td_start..ctx.td_end];

    // 去重后的唯一 Private 池（按 fd_infos 首现序；非 CID 单池），存 pools 下标（Zig 版为指针去重）
    let mut unique_pools: Vec<usize> = Vec::new();
    if is_cid {
        for fi in &fd_infos {
            if !fi.has_priv {
                continue;
            }
            if !unique_pools.contains(&fi.pool_idx) {
                unique_pools.push(fi.pool_idx);
            }
        }
    } else {
        unique_pools.push(0);
    }

    let mut top_dict_len = top_dict_bytes.len();
    let mut fd_array_total_len: usize = 0;
    let mut priv_segs_total: usize = 0;
    let mut patched_top_dict: Vec<u8> = top_dict_bytes.to_vec();
    let mut new_fd_array: Vec<u8> = Vec::new();
    let mut patched_priv_segs: Vec<Vec<u8>> = Vec::new();

    for _iter in 0..8 {
        // patch 各唯一 Private DICT：op19 = 新 DICT 长度（Local Subr INDEX 紧跟其后）
        let mut priv_segs: Vec<Vec<u8>> = Vec::with_capacity(unique_pools.len());
        let mut cur_priv_total: usize = 0;
        for &pi in &unique_pools {
            let seg = if pools[pi].orig_off == NO_PRIV {
                Vec::new()
            } else {
                patch_private_dict(b, pools[pi].orig_off, pools[pi].len, pools[pi].idx.is_some())
            };
            cur_priv_total += seg.len() + pools[pi].new_local_subr.len();
            priv_segs.push(seg);
        }

        // 各段偏移（Top DICT INDEX 总长 = count(2)+offSize(1)+(1+1)*offSize + topDictLen，count=1）
        let td_off_size = top_dict_off_size(top_dict_len + 1);
        let td_idx_total_len = 2 + 1 + 2 * td_off_size as usize + top_dict_len;
        let string_off = header_name.len() + td_idx_total_len;
        let gsubr_off = string_off + string_seg.len();
        let charset_off2 = gsubr_off + gsubr_seg.len();
        let char_strings_off2 = charset_off2 + charset_seg.len();
        let fd_array_off = char_strings_off2 + charstrings_seg.len();
        let fd_select_off = fd_array_off + fd_array_total_len;
        let private_off = fd_select_off + fdselect_seg.len();

        // 各唯一 Private 段的新绝对偏移（顺序拼接，起始 privateOff）
        let mut p_acc = private_off;
        let mut pool_new_offs: Vec<usize> = Vec::with_capacity(unique_pools.len());
        for (i, &pi) in unique_pools.iter().enumerate() {
            pool_new_offs.push(p_acc);
            p_acc += priv_segs[i].len() + pools[pi].new_local_subr.len();
        }

        let candidate_top_dict: Vec<u8>;
        let mut fd_converged = true;
        if is_cid {
            // patch FD DICT 的 Private [len, offset]：len = patched DICT 长度（不含 Local Subr），
            // offset = 新 Private 绝对偏移（CFF 规范 Private len 是 DICT 字节长度，Local Subr 在其外）
            let mut fd_objects_owned: Vec<Vec<u8>> = Vec::with_capacity(fd_infos.len());
            for fi in &fd_infos {
                if !fi.has_priv {
                    fd_objects_owned.push(fi.dict_bytes.to_vec());
                } else {
                    let uid = unique_pools.iter().position(|&up| up == fi.pool_idx).unwrap();
                    fd_objects_owned.push(replace_dict_private_operands(
                        fi.dict_bytes,
                        priv_segs[uid].len() as i32,
                        pool_new_offs[uid] as i32,
                    ));
                }
            }
            let fd_objects: Vec<&[u8]> = fd_objects_owned.iter().map(|v| v.as_slice()).collect();
            let candidate_fd_array = write_index(&fd_objects);
            fd_converged = candidate_fd_array.len() == fd_array_total_len;
            new_fd_array = candidate_fd_array;
            fd_array_total_len = new_fd_array.len();
            // patch Top DICT：charset/CharStrings/FDArray/FDSelect
            candidate_top_dict = replace_dict_offsets(
                top_dict_bytes,
                &[
                    DictReplace { op: OP_CHARSET, val: charset_off2 as i32 },
                    DictReplace { op: OP_CHARSTRINGS, val: char_strings_off2 as i32 },
                    DictReplace { op: OP_FD_ARRAY, val: fd_array_off as i32 },
                    DictReplace { op: OP_FD_SELECT, val: fd_select_off as i32 },
                ],
                &[],
            );
        } else {
            // 非 CID：patch charset/CharStrings，删除 Encoding（子集后其内部 glyph 索引已失效，
            // 浏览器消费 cmap 不消费 CFF encoding），再替换 Private [len, offset]（仅当有 Private）
            let mut td1 = replace_dict_offsets(
                top_dict_bytes,
                &[
                    DictReplace { op: OP_CHARSET, val: charset_off2 as i32 },
                    DictReplace { op: OP_CHARSTRINGS, val: char_strings_off2 as i32 },
                ],
                &[OP_ENCODING],
            );
            if pools[unique_pools[0]].orig_off != NO_PRIV {
                td1 = replace_dict_private_operands(&td1, priv_segs[0].len() as i32, pool_new_offs[0] as i32);
            }
            candidate_top_dict = td1;
        }

        // 收敛判定：Top DICT / FDArray（CID）/ Private 段总长都不变
        let td_converged = candidate_top_dict.len() == top_dict_len;
        let priv_converged = cur_priv_total == priv_segs_total;
        patched_top_dict = candidate_top_dict;
        patched_priv_segs = priv_segs;
        top_dict_len = patched_top_dict.len();
        priv_segs_total = cur_priv_total;
        if td_converged && priv_converged && fd_converged {
            break;
        }
    }

    let new_top_dict_index = write_index(&[&patched_top_dict]);

    // 拼接 Private 段（每段 = patched DICT + Local Subr INDEX）
    let mut parts: Vec<&[u8]> = Vec::new();
    parts.push(header_name);
    parts.push(&new_top_dict_index);
    parts.push(string_seg);
    parts.push(gsubr_seg);
    parts.push(&charset_seg);
    parts.push(&charstrings_seg);
    if is_cid {
        parts.push(&new_fd_array);
        parts.push(&fdselect_seg);
    }
    for (i, &pi) in unique_pools.iter().enumerate() {
        parts.push(&patched_priv_segs[i]);
        parts.push(&pools[pi].new_local_subr);
    }
    Ok(combine(&parts))
}

/// 计算 Top DICT INDEX 的 offSize（容纳 max_offset 的最小字节数，1~4）
fn top_dict_off_size(max_offset: usize) -> u8 {
    if max_offset > 0xffff {
        return 4;
    }
    if max_offset > 0xff {
        return 2;
    }
    1
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// fixture 目录（生成脚本见测试注释；缺失则跳过相关用例）
    const FIXTURE_DIR: &str = "/tmp/cff_fixtures";
    /// zig oracle 二进制（/tmp/cff_parity/oracle.zig 编译产物，调用 zig-spike cff.zig）
    const ORACLE: &str = "/tmp/cff_parity/oracle";

    fn have(path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    /// 读 fixture 字节
    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{FIXTURE_DIR}/{name}")).expect("fixture read")
    }

    /// 跑 zig oracle 得同输入输出字节（写入 /tmp 后读回）
    fn run_oracle(tag: &str, input: &str, gids: &str) -> Vec<u8> {
        let out = format!("{FIXTURE_DIR}/oracle_{tag}.bin");
        let st = std::process::Command::new(ORACLE)
            .args([format!("{FIXTURE_DIR}/{input}").as_str(), out.as_str(), gids])
            .output()
            .expect("oracle spawn");
        assert!(st.status.success(), "oracle failed: {}", String::from_utf8_lossy(&st.stderr));
        std::fs::read(&out).expect("oracle output read")
    }

    /// 结构自检：重建的输出必须能按 CFF 结构走通，且 CharStrings 数量 = 子集字形数
    /// （完整合法性由 fontTools 往返验证，见 /tmp 验证脚本）
    fn check_structure(out: &[u8], n_expect: usize) {
        assert!(out.len() >= 4);
        let hdr_size = out[2] as usize;
        let name_hdr = read_index_header(out, hdr_size);
        let top_index = read_index_full(out, name_hdr.end);
        assert_eq!(top_index.count, 1);
        let td_start = top_index.data_start + top_index.offsets[0] as usize - 1;
        let td_end = top_index.data_start + top_index.offsets[1] as usize - 1;
        let td = parse_dict(out, td_start, td_end);
        let cs_op = td.get(&OP_CHARSTRINGS).expect("charstrings op");
        let cs_off = cs_op[0] as usize;
        let cs_count = u16_at(out, cs_off) as usize;
        assert_eq!(cs_count, n_expect, "charstrings count");
        // charset 段存在且格式 0
        let charset_off = td.get(&OP_CHARSET).expect("charset op")[0] as usize;
        assert_eq!(u8_at(out, charset_off), 0);
        // 每个 charstring 的字节区间可读（offset 单调、数据不越界）
        let cs_off_size = u8_at(out, cs_off + 2);
        let cs_off_arr = cs_off + 3;
        let cs_data_start = cs_off_arr + (cs_count + 1) * cs_off_size as usize;
        let mut prev: usize = 0;
        for i in 0..=cs_count {
            let o = index_offset_at(out, cs_off_arr, cs_off_size, i) as usize;
            assert!(o >= prev, "charstring offset monotonic");
            prev = o;
        }
        let last = index_offset_at(out, cs_off_arr, cs_off_size, cs_count) as usize;
        assert!(cs_data_start + last - 1 <= out.len(), "charstrings data in bounds");
    }

    #[test]
    fn invalid_inputs() {
        // len < 4 → None（降级路径）
        assert!(matches!(subset_cff(&[1, 0, 4], &[0]), Ok(None)));
        // hdrSize 越界 → None
        assert!(matches!(subset_cff(&[1, 0, 200, 4, 0, 0], &[0]), Ok(None)));
    }

    /// 手工最小 CFF：Top DICT 为空（无 CharStrings op）→ UnsupportedCff
    #[test]
    fn missing_charstrings_unsupported() {
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(&[1, 0, 4, 4]); // Header hdrSize=4
        // Name INDEX: count=1 offSize=1 offsets=[1,7] data="RustTF"
        b.extend_from_slice(&[0x00, 0x01, 0x01, 0x00, 0x01, 0x07]);
        b.extend_from_slice(b"RustTF");
        // Top DICT INDEX: count=1 offSize=1 offsets=[1,1] data 空
        b.extend_from_slice(&[0x00, 0x01, 0x01, 0x00, 0x01, 0x01]);
        assert!(matches!(subset_cff(&b, &[0, 1]), Err(CffError::UnsupportedCff)));
    }

    /// CID（多 FD，FDSelect）与 name-keyed（单 Private + Local Subr）全链路：
    /// 结构合法性 + 与 zig oracle 字节对拍
    #[test]
    fn parity_cid_and_name() {
        if !have(ORACLE) || !have(&format!("{FIXTURE_DIR}/cid_small.bin")) {
            eprintln!("skip: oracle/fixture 不存在（见模块头注释生成方式）");
            return;
        }
        let cases: [(&str, &str, &[&str]); 8] = [
            // cid_small：Noto CID（gsubr 体内含 callsubr → local subr 透传路径）
            ("cid_small.bin", "c1", &["0", "1", "2", "5", "9", "20"]),
            ("cid_small.bin", "c2", &["0"]),
            ("cid_small.bin", "c3", &["3", "7", "11"]), // 无 0 → 注入 .notdef
            // cid_nogsubr：gsubr body 置换为 endchar → CID local subr 重写路径（FD 重映射+闭包收敛+重编号）
            ("cid_nogsubr.bin", "n1", &["0", "1", "2", "5", "9", "20"]),
            ("cid_nogsubr.bin", "n2", &["3", "7", "11"]), // 无 0 → 注入 .notdef
            // name_fa：name-keyed 单 Private + 492 local subr 重写路径
            ("name_fa.bin", "f1", &["0", "1", "2", "3", "10", "100"]),
            ("name_fa.bin", "f2", &["0", "700"]),
            ("name_fa.bin", "f3", &["5", "42", "500"]), // 无 0 → 注入 .notdef
        ];
        for (input, tag, gids) in cases {
            let fixture_bytes = fixture(input);
            let gid_str = gids.join(",");
            let gid_list: Vec<u16> = gids.iter().map(|s| s.parse().unwrap()).collect();
            let rust_out = subset_cff(&fixture_bytes, &gid_list).expect("subset ok").expect("some");
            let n_expect = if gid_list[0] == 0 { gid_list.len() } else { gid_list.len() + 1 };
            check_structure(&rust_out, n_expect);
            let zig_out = run_oracle(tag, input, &gid_str);
            assert_eq!(rust_out, zig_out, "byte parity {input} gids={gid_str}");
        }
    }

    /// 大 CID 字体（思源 NotoSansCJK SC 全量 65535 glyph、18 FD）对拍
    ///
    /// 2026-11-03 正确性修复后与 Zig oracle 有意分歧：hintmask/cntrmask 栈上操作数是
    /// vstem 声明（OTS/FreeType 语义 num_stems += ss>>1），TS/Zig 三个版本的
    /// hintmask 掩码跳字节数均漏计这部分 stems，掩码漏跳 1 字节后把掩码字节误读成
    /// callsubr，流失步产生 OTS 拒收的损坏 charstring（Chrome: "Failed validating
    /// CharStrings INDEX"，浏览器拒收不渲染）。Rust 版修复后产物通过 OTS 校验
    /// （ots_sim.py 全字形 + Chrome 实测 LOADED），Zig 版产物仍为损坏形态。
    /// 此处断言的不再是字节一致，而是「分歧存在且 Rust 侧结构合法」。
    #[test]
    fn parity_cid_full_noto() {
        if !have(ORACLE) || !have(&format!("{FIXTURE_DIR}/cid_noto.bin")) {
            eprintln!("skip: oracle/fixture 不存在");
            return;
        }
        let fixture_bytes = fixture("cid_noto.bin");
        // 3606：栈深峰值 49 > 48，覆盖 OTS 超限 → stripHints 剥 hint 分支
        let gids = ["0", "1", "5", "100", "2000", "30000", "3606", "65534"];
        let gid_list: Vec<u16> = gids.iter().map(|s| s.parse().unwrap()).collect();
        let rust_out = subset_cff(&fixture_bytes, &gid_list).expect("subset ok").expect("some");
        check_structure(&rust_out, gid_list.len());
        let zig_out = run_oracle("noto", "cid_noto.bin", &gids.join(","));
        assert_ne!(rust_out, zig_out, "hintmask stems 修复后应与损坏的 Zig 产物分歧");
    }
}
