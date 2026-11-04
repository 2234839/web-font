//! 杂项路由与常驻设施（对译 zig-spike/src/misc.zig）—— 语义对齐 backend/ 的其余功能面：
//! - 路由：/api/fonts、/api/config、/api/stats、/api/stats/event、/api/upload、/api/font-meta
//! - 静态资源 + 字体详情页 SSR（backend/app.ts staticFileMiddleware + routes/font_detail.ts）
//! - 统计累计与 30s 防抖落盘（stats_store.ts）、临时字体清理器（temp_cleaner.ts）
//! - 内存闸门/并发排队 503（subset_queue.ts）、multipart 解析（multipart.ts）、上传（upload.ts）
//! - CORS 中间件语义：所有响应追加三个 Access-Control 头；OPTIONS 直接 204 不带 CORS
//! - glyph-match HTTP handler（原属 zig main.zig，Rust 侧归入本模块以收拢路由依赖）

use std::collections::HashMap;
use std::io;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::cache::FontCache;
use crate::http;
use crate::glyph_match as gm;

// ===== 配置（对齐 backend/config.ts，启动时从环境变量加载）=====

/// 进程级配置（init 后只读）
pub struct Config {
    /// 临时上传开关
    pub enable_temp_upload: bool,
    /// 管理员 API Key，空则管理员上传不可用
    pub admin_api_key: String,
    /// 临时上传目录最大文件数
    pub temp_max_files: usize,
    /// 临时上传目录总体积上限（字节）
    pub temp_max_total_size: usize,
    /// 临时字体保留时限（秒）
    pub temp_retention_seconds: u64,
    /// 字体裁剪最大并发数
    pub subset_concurrency: usize,
    /// 队列等待超时（秒）
    pub subset_queue_timeout_seconds: u64,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

fn config() -> &'static Config {
    CONFIG.get().expect("misc::init 未调用")
}

/// 环境整数解析（非法回退默认值）
fn env_int(name: &str, default: i64) -> i64 {
    std::env::var(name).ok().and_then(|s| s.parse::<i64>().ok()).unwrap_or(default)
}

/// 环境正整数解析（<1 回退默认值）
fn env_usize(name: &str, default: usize) -> usize {
    let v = env_int(name, default as i64);
    if v < 1 {
        default
    } else {
        v as usize
    }
}

// ===== 统计（对齐 backend/shared.ts stats + stats_store.ts）=====

/// 持久化文件位置（与 TS 同一文件，切换运行时可无缝衔接）
const STATS_FILE: &str = "font/.stats.json";
/// 落盘防抖间隔
const STATS_FLUSH_MS: u64 = 30_000;

#[derive(Clone, Copy, Default)]
struct Counters {
    total_requests: u64,
    subset_requests: u64,
    subset_cache_hits: u64,
    total_chars: u64,
    temp_uploads: u64,
    offline_subsets: u64,
    offline_downloads: u64,
}

struct StatsInner {
    dirty: bool,
    c: Counters,
}

static STATS: Mutex<StatsInner> = Mutex::new(StatsInner {
    dirty: false,
    c: Counters {
        total_requests: 0,
        subset_requests: 0,
        subset_cache_hits: 0,
        total_chars: 0,
        temp_uploads: 0,
        offline_subsets: 0,
        offline_downloads: 0,
    },
});

/// 子集请求总耗时直方图：固定容量环形缓冲，只保留最近 LATENCY_RING 个样本
/// （进程级观测，不持久化——重启重新采样即可）
const LATENCY_RING: usize = 1024;
static LATENCIES: Mutex<(Vec<u32>, usize)> = Mutex::new((Vec::new(), 0));

/// 记录一次子集请求总耗时（毫秒，含缓存命中路径）
pub fn stats_record_latency(total_ms: u64) {
    let mut g = LATENCIES.lock().unwrap();
    let (ring, next) = &mut *g;
    if ring.len() < LATENCY_RING {
        // 未满时只 push，保证 ring.len() == 真实样本数，分位不掺零值
        ring.push(total_ms as u32);
    } else {
        ring[*next] = total_ms as u32;
    }
    *next = (*next + 1) % LATENCY_RING;
}

/// 最近样本的分位数（percentile 0~100）；无样本返回 None
fn latency_percentile(p: f64) -> Option<u64> {
    let g = LATENCIES.lock().unwrap();
    let (ring, _next) = &*g;
    if ring.is_empty() {
        return None;
    }
    let mut sorted: Vec<u32> = ring.to_vec();
    sorted.sort_unstable();
    let idx = ((sorted.len() as f64 - 1.0) * p / 100.0).round() as usize;
    Some(sorted[idx.min(sorted.len() - 1)] as u64)
}
/// 启动时刻（uptime 只算本次进程）
static STATS_START_MS: OnceLock<i64> = OnceLock::new();

/// 墙钟毫秒（Date.now 等价）
pub fn wall_now_ms() -> i64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("系统时钟早于 1970");
    now.as_millis() as i64
}

/// 初始化：解析配置、建目录、恢复统计、启动后台线程
pub fn init() {
    let cfg = Config {
        enable_temp_upload: std::env::var("ENABLE_TEMP_UPLOAD").map(|v| v == "true").unwrap_or(false),
        admin_api_key: std::env::var("ADMIN_API_KEY").unwrap_or_default(),
        temp_max_files: env_usize("TEMP_MAX_FILES", 10),
        temp_max_total_size: env_int("TEMP_MAX_TOTAL_SIZE", 200 * 1024 * 1024) as usize,
        temp_retention_seconds: env_int("TEMP_RETENTION_SECONDS", 10800) as u64,
        subset_concurrency: env_usize("SUBSET_CONCURRENCY", 4),
        subset_queue_timeout_seconds: 5u64.max(env_int("SUBSET_QUEUE_TIMEOUT", 30) as u64),
    };
    if CONFIG.set(cfg).is_err() {
        panic!("misc::init 重复调用");
    }

    ensure_directories();
    load_stats();
    STATS_START_MS.set(wall_now_ms()).ok();

    eprintln!("[config] temp upload: {}", config().enable_temp_upload);
    eprintln!("[config] admin upload: {}", !config().admin_api_key.is_empty());

    init_gate();

    let _ = std::thread::Builder::new().name("stats-flush".into()).spawn(stats_flush_thread);
    let _ = std::thread::Builder::new().name("temp-cleaner".into()).spawn(temp_cleaner_thread);
}

fn ensure_directories() {
    for dir in ["font/temp", "font/admin"] {
        if std::fs::metadata(dir).is_err() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
}

/// 从 font/.stats.json 恢复累计计数（缺失/损坏从 0 起步，对齐 loadPersistedStats）
fn load_stats() {
    let Ok(raw) = std::fs::read_to_string(STATS_FILE) else { return };
    let Some(v) = json_parse(raw.trim()) else { return };
    let mut g = STATS.lock().unwrap();
    g.c.total_requests = json_u64(&v, "totalRequests", g.c.total_requests);
    g.c.subset_requests = json_u64(&v, "subsetRequests", g.c.subset_requests);
    g.c.subset_cache_hits = json_u64(&v, "subsetCacheHits", g.c.subset_cache_hits);
    g.c.total_chars = json_u64(&v, "totalChars", g.c.total_chars);
    g.c.temp_uploads = json_u64(&v, "tempUploads", g.c.temp_uploads);
    g.c.offline_subsets = json_u64(&v, "offlineSubsets", g.c.offline_subsets);
    g.c.offline_downloads = json_u64(&v, "offlineDownloads", g.c.offline_downloads);
}

/// 对象字段取无符号整数（缺失/类型不符回退默认）
fn json_u64(v: &JsonValue, key: &str, default: u64) -> u64 {
    let Some(f) = obj_get(v, key) else { return default };
    match f {
        JsonValue::Num(n) if *n >= 0.0 && n.fract() == 0.0 => *n as u64,
        _ => default,
    }
}

/// 每请求计数 + 标脏（对齐 logMiddleware + markStatsDirty）
pub fn stats_total_request() {
    let mut g = STATS.lock().unwrap();
    g.c.total_requests += 1;
    g.dirty = true;
}

/// 子集化计数：请求次数 + 累计字符数（UTF-16 码元口径，对齐 text.length）
pub fn stats_record_subset(utf16_units: usize) {
    let mut g = STATS.lock().unwrap();
    g.c.subset_requests += 1;
    g.c.total_chars += utf16_units as u64;
    g.dirty = true;
}

pub fn stats_record_cache_hit() {
    let mut g = STATS.lock().unwrap();
    g.c.subset_cache_hits += 1;
    g.dirty = true;
}

pub fn stats_record_temp_upload() {
    let mut g = STATS.lock().unwrap();
    g.c.temp_uploads += 1;
    g.dirty = true;
}

pub fn stats_record_offline(subset: bool) {
    let mut g = STATS.lock().unwrap();
    if subset {
        g.c.offline_subsets += 1;
    } else {
        g.c.offline_downloads += 1;
    }
    g.dirty = true;
}

fn stats_flush_thread() {
    loop {
        std::thread::sleep(Duration::from_millis(STATS_FLUSH_MS));
        let snap = {
            let mut g = STATS.lock().unwrap();
            if !g.dirty {
                continue;
            }
            g.dirty = false;
            g.c
        };
        let json = stats_json(snap);
        if std::fs::write(STATS_FILE, json).is_err() {
            // 写盘失败把脏标放回，等下个周期重试（对齐 flushStats 失败路径）
            let mut g = STATS.lock().unwrap();
            g.dirty = true;
        }
    }
}

fn stats_json(c: Counters) -> String {
    format!(
        "{{\"totalRequests\":{},\"subsetRequests\":{},\"subsetCacheHits\":{},\"totalChars\":{},\"tempUploads\":{},\"offlineSubsets\":{},\"offlineDownloads\":{}}}",
        c.total_requests, c.subset_requests, c.subset_cache_hits, c.total_chars, c.temp_uploads, c.offline_subsets, c.offline_downloads
    )
}

// ===== 临时字体清理器（对齐 backend/temp_cleaner.ts）=====

/// 字体最后使用时间戳（key = 文件名）
static LAST_USED: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);

/// 闭包访问 last_used 表（惰性初始化；静态上下文不能调 HashMap::new）
fn with_last_used<R>(f: impl FnOnce(&mut HashMap<String, i64>) -> R) -> R {
    let mut g = LAST_USED.lock().unwrap();
    f(g.get_or_insert_with(HashMap::new))
}

/// 记录临时字体被使用（仅 font/temp 下文件，对齐 markFontUsed）
pub fn mark_font_used(font_path: &str) {
    if !font_path.starts_with("font/temp/") {
        return;
    }
    let name = match font_path.rfind('/') {
        Some(i) => &font_path[i + 1..],
        None => font_path,
    };
    let now = wall_now_ms();
    with_last_used(|m| m.insert(name.to_string(), now));
}

fn clean_once() {
    let now = wall_now_ms();
    let retention_ms = config().temp_retention_seconds * 1000;
    let Ok(entries) = std::fs::read_dir("font/temp") else { return };
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        // 只删普通文件（对齐 entry.kind != .file 跳过）
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let fname = entry.file_name();
        let Some(fname) = fname.to_str() else { continue };
        if !crate::has_font_ext(fname) {
            continue;
        }
        names.push(fname.to_string());
    }
    let mut cleaned: usize = 0;
    for name in names {
        let Ok(md) = std::fs::metadata(format!("font/temp/{name}")) else { continue };
        let last_used_ms = with_last_used(|m| m.get(&name).copied().unwrap_or(0));
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let last_active = last_used_ms.max(mtime_ms);
        if now - last_active > retention_ms as i64 {
            if std::fs::remove_file(format!("font/temp/{name}")).is_err() {
                continue;
            }
            with_last_used(|m| m.remove(&name));
            cleaned += 1;
        }
    }
    if cleaned > 0 {
        eprintln!("[temp-cleaner] 本次清理 {cleaned} 个过期临时字体");
    }
}

fn temp_cleaner_thread() {
    // 清理周期 = 保留时限的一半，最少 5 分钟
    let clean_interval_ms: u64 = (config().temp_retention_seconds * 500).max(300_000);
    eprintln!(
        "[temp-cleaner] 启动，保留时限 {}s，清理周期 {}s",
        config().temp_retention_seconds,
        clean_interval_ms / 1000
    );
    std::thread::sleep(Duration::from_secs(60));
    loop {
        clean_once();
        std::thread::sleep(Duration::from_millis(clean_interval_ms));
    }
}

// ===== 内存闸门（对齐 backend/subset_queue.ts）=====

struct GateInner {
    active: usize,
    #[allow(dead_code)] // waiting 只作排队计数，语义保留
    waiting: usize,
    reserved: usize,
}

static GATE: Mutex<GateInner> = Mutex::new(GateInner { active: 0, waiting: 0, reserved: 0 });
/// init_gate 已执行的标记（打印一次启动行）
static GATE_INITED: AtomicBool = AtomicBool::new(false);

const MIB: usize = 1024 * 1024;

/// 内存快照：宿主/容器空闲与保留水位
struct MemSnap {
    limit: u64,
    free: u64,
    reserve: u64,
}

/// 读 cgroup/proc 数值文件（"max"/非法 → None）
fn read_memory_file(path: &str) -> Option<u64> {
    let raw = std::fs::read_to_string(path).ok()?;
    let s = raw.trim_matches(|c: char| c == ' ' || c == '\t' || c == '\r' || c == '\n');
    if s == "max" {
        return None;
    }
    s.parse::<u64>().ok()
}

/// cgroup v2 优先，再 v1（对齐 readCgroupMemory）
fn read_cgroup_memory() -> Option<(u64, u64)> {
    if let Some(limit) = read_memory_file("/sys/fs/cgroup/memory.max") {
        if let Some(used) = read_memory_file("/sys/fs/cgroup/memory.current") {
            if limit > 0 {
                return Some((limit, limit.saturating_sub(used)));
            }
        }
    }
    if let Some(limit) = read_memory_file("/sys/fs/cgroup/memory/memory.limit_in_bytes") {
        if let Some(used) = read_memory_file("/sys/fs/cgroup/memory/memory.usage_in_bytes") {
            if limit > 0 {
                return Some((limit, limit.saturating_sub(used)));
            }
        }
    }
    None
}

/// /proc/meminfo 兜底（os.totalmem/freemem 等价物）
fn read_meminfo() -> Option<(u64, u64)> {
    let raw = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut total: u64 = 0;
    let mut available: u64 = 0;
    for line in raw.split('\n') {
        let Some(colon) = line.find(':') else { continue };
        let key = &line[..colon];
        let mut val = line[colon + 1..].trim_matches(|c: char| c == ' ' || c == '\t');
        if let Some(stripped) = val.strip_suffix(" kB") {
            val = stripped;
        }
        let Ok(n) = val.trim().parse::<u64>() else { continue };
        if key == "MemTotal" {
            total = n * 1024;
        }
        if key == "MemAvailable" {
            available = n * 1024;
        }
    }
    if total == 0 {
        return None;
    }
    Some((total, available))
}

/// 每次准入都读取当前水位，不缓存（对齐 readMemorySnapshot）
/// 容器内存压力判定：cgroup 可用（limit - usage）低于 total 的比值阈值（15%）
pub fn memory_under_pressure() -> bool {
    let Some((limit, free)) = read_cgroup_memory() else {
        return false;
    };
    free < limit * 15 / 100
}

fn read_memory_snapshot() -> MemSnap {
    let (limit, free) = match read_cgroup_memory() {
        Some(c) => c,
        None => match read_meminfo() {
            Some(m) => m,
            None => (2 * 1024 * MIB as u64, 1024 * MIB as u64),
        },
    };
    // 给运行时和静态请求保留内存，绝不把水位用满
    let reserve = (32 * MIB as u64).max((128 * MIB as u64).min(limit / 10));
    MemSnap { limit, free, reserve }
}

/// 小内存机器最多同时执行两个重任务（对齐 concurrencyLimit）
fn concurrency_limit(limit: u64) -> usize {
    let max_conc = config().subset_concurrency.max(1);
    if limit <= 2 * 1024 * MIB as u64 {
        max_conc.min(2)
    } else {
        max_conc
    }
}

pub fn init_gate() {
    if !GATE_INITED.swap(true, Ordering::SeqCst) {
        eprintln!("[subset-queue] maxConcurrency={}, memoryAware=true", config().subset_concurrency.max(1));
    }
}

/// 排队获取闸门槽位；超时返回 false（调用方回 503）。对齐 withMemoryGate 的轮询语义。
pub fn gate_acquire(timeout_ms: i64, estimated: usize) -> bool {
    let t0 = Instant::now();
    let mut queued = false;
    loop {
        let memory = read_memory_snapshot();
        let granted = {
            let mut g = GATE.lock().unwrap();
            let has_slot = g.active < concurrency_limit(memory.limit);
            let available = memory
                .free
                .saturating_sub(memory.reserve)
                .saturating_sub(g.reserved as u64);
            // 没有任务运行时允许启动一个大任务，避免预估值偏大造成永久饥饿
            let has_memory = if g.active == 0 { available > 0 } else { available >= estimated as u64 };
            if has_slot && has_memory {
                if queued {
                    g.waiting -= 1;
                }
                g.active += 1;
                g.reserved += estimated;
                true
            } else {
                if !queued {
                    queued = true;
                    g.waiting += 1;
                }
                false
            }
        };
        if granted {
            return true;
        }

        let elapsed = t0.elapsed().as_millis() as i64;
        if elapsed >= timeout_ms {
            let mut g = GATE.lock().unwrap();
            g.waiting -= 1;
            return false;
        }
        let remain = (timeout_ms - elapsed) as u64;
        std::thread::sleep(Duration::from_millis(remain.min(50)));
    }
}

pub fn gate_release(estimated: usize) {
    let mut g = GATE.lock().unwrap();
    g.active -= 1;
    g.reserved -= estimated;
}

/// 源文件内存预估：max(64MB, size*4)（对齐 estimateSubsetMemory）
pub fn estimate_subset_memory(font_path: &str) -> usize {
    match std::fs::metadata(font_path) {
        Ok(md) => (md.len() as usize * 4).max(64 * MIB),
        Err(_) => 64 * MIB,
    }
}

/// 队列超时毫秒
pub fn queue_timeout_ms() -> i64 {
    (config().subset_queue_timeout_seconds * 1000) as i64
}

// ===== 通用 JSON 辅助 =====

/// 写 JSON 字符串字面量（转义规则对齐 JSON.stringify：仅转义必要字符，UTF-8 原样输出）
pub fn json_stringify_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u00{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// f64 格式化对齐 JS number：整数值不带小数点，小数保留一位（覆盖率百分比的取值域）
fn json_percent(p: f64) -> String {
    if p == p.trunc() {
        format!("{}", p as i64)
    } else {
        format!("{p:.1}")
    }
}

/// text.length UTF-16 码元口径（对齐 utf16LenUtf8：非法序列按 1 计）
pub fn utf16_len_utf8(s: &str) -> usize {
    let b = s.as_bytes();
    let mut n: usize = 0;
    let mut i: usize = 0;
    while i < b.len() {
        let len = match utf8_seq_len(b[i]) {
            Some(l) => l,
            None => {
                i += 1;
                n += 1;
                continue;
            }
        };
        if i + len > b.len() {
            i += 1;
            n += 1;
            continue;
        }
        match std::str::from_utf8(&b[i..i + len]) {
            Ok(t) => {
                // from_utf8 校验通过后 chars() 恰为 1 个标量值
                n += if t.chars().next().unwrap() as u32 > 0xFFFF { 2 } else { 1 };
            }
            Err(_) => {
                i += 1;
                n += 1;
                continue;
            }
        }
        i += len;
    }
    n
}

/// UTF-8 首字节 → 序列长度（非法返回 None）
fn utf8_seq_len(first: u8) -> Option<usize> {
    match first {
        0x00..=0x7f => Some(1),
        0xc0..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf7 => Some(4),
        _ => None,
    }
}

// ===== 极简 JSON 解析器（对齐 std.json.parseFromSliceLeaky 的取值需求子集）=====

/// JSON 值（解析失败的条目返回 None；对象保序线性查找）
#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsonValue>),
    Obj(Vec<(String, JsonValue)>),
}

impl JsonValue {
    /// 对象取字段
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            JsonValue::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    /// 取字符串字段（存在但类型不符返回 None——上层转 400，对齐 Zig 类型化解析）
    pub fn get_str(&self, key: &str) -> Option<Option<&str>> {
        match self.get(key) {
            Some(JsonValue::Str(s)) => Some(Some(s.as_str())),
            Some(_) => None,
            None => Some(None),
        }
    }
    /// 取整数（integer/float 均接受，越界/负数/非数返回 None）
    pub fn get_u32(&self, key: &str) -> Option<Option<u32>> {
        match self.get(key) {
            Some(JsonValue::Num(n)) if *n >= 0.0 && *n <= u32::MAX as f64 && n.fract() == 0.0 => {
                Some(Some(*n as u32))
            }
            Some(_) => None,
            None => Some(None),
        }
    }
}

/// 解析 JSON 文本（语法错误返回 None；递归深度限 256 对齐 std.json 默认）
pub fn json_parse(s: &str) -> Option<JsonValue> {
    let b = s.as_bytes();
    let mut p = Parser { b, i: 0 };
    p.skip_ws();
    let v = p.value(0)?;
    p.skip_ws();
    if p.i != b.len() {
        return None;
    }
    Some(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

const MAX_DEPTH: usize = 256;

impl Parser<'_> {
    fn skip_ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn value(&mut self, depth: usize) -> Option<JsonValue> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.skip_ws();
        match self.peek()? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => self.string().map(JsonValue::Str),
            b't' => self.lit(b"true", JsonValue::Bool(true)),
            b'f' => self.lit(b"false", JsonValue::Bool(false)),
            b'n' => self.lit(b"null", JsonValue::Null),
            _ => self.number(),
        }
    }

    fn lit(&mut self, word: &[u8], v: JsonValue) -> Option<JsonValue> {
        if self.b.len() - self.i >= word.len() && &self.b[self.i..self.i + word.len()] == word {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }

    fn object(&mut self, depth: usize) -> Option<JsonValue> {
        self.i += 1; // '{'
        let mut items: Vec<(String, JsonValue)> = Vec::new();
        self.skip_ws();
        if self.peek()? == b'}' {
            self.i += 1;
            return Some(JsonValue::Obj(items));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            if self.peek()? != b':' {
                return None;
            }
            self.i += 1;
            let v = self.value(depth + 1)?;
            items.push((key, v));
            self.skip_ws();
            match self.peek()? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(JsonValue::Obj(items));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self, depth: usize) -> Option<JsonValue> {
        self.i += 1; // '['
        let mut items: Vec<JsonValue> = Vec::new();
        self.skip_ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Some(JsonValue::Arr(items));
        }
        loop {
            let v = self.value(depth + 1)?;
            items.push(v);
            self.skip_ws();
            match self.peek()? {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Some(JsonValue::Arr(items));
                }
                _ => return None,
            }
        }
    }

    fn string(&mut self) -> Option<String> {
        if self.peek()? != b'"' {
            return None;
        }
        self.i += 1;
        // 统一字节缓冲：转义与原始字节都 append，最后整体验 UTF-8
        //（非法 UTF-8 → 解析失败，对齐 std.json 严格校验）
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(bytes).ok(),
                b'\\' => {
                    let e = self.peek()?;
                    self.i += 1;
                    match e {
                        b'"' => bytes.push(b'"'),
                        b'\\' => bytes.push(b'\\'),
                        b'/' => bytes.push(b'/'),
                        b'b' => bytes.push(0x08),
                        b'f' => bytes.push(0x0c),
                        b'n' => bytes.push(b'\n'),
                        b'r' => bytes.push(b'\r'),
                        b't' => bytes.push(b'\t'),
                        b'u' => {
                            // \uXXXX（代理对合成，对齐 JSON 标准；孤立代理解析失败，对齐 std.json）
                            let hi = self.hex4()?;
                            let cp = if (0xd800..=0xdbff).contains(&hi) {
                                // 高代理必须紧跟 \uDC00-\uDFFF
                                if self.b.len() - self.i >= 6
                                    && self.b[self.i] == b'\\'
                                    && self.b[self.i + 1] == b'u'
                                {
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if (0xdc00..=0xdfff).contains(&lo) {
                                        0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                                    } else {
                                        return None;
                                    }
                                } else {
                                    return None;
                                }
                            } else if (0xdc00..=0xdfff).contains(&hi) {
                                return None;
                            } else {
                                hi
                            };
                            let ch = char::from_u32(cp)?;
                            let mut buf = [0u8; 4];
                            bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => return None,
                    }
                }
                0x00..=0x1f => return None,
                _ => bytes.push(c),
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        if self.b.len() - self.i < 4 {
            return None;
        }
        let mut v: u32 = 0;
        for k in 0..4 {
            let d = (self.b[self.i + k] as char).to_digit(16)?;
            v = v * 16 + d;
        }
        self.i += 4;
        Some(v)
    }

    fn number(&mut self) -> Option<JsonValue> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        let mut any = false;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'+' || c == b'-' {
                self.i += 1;
                any = true;
            } else {
                break;
            }
        }
        if !any {
            return None;
        }
        std::str::from_utf8(&self.b[start..self.i]).ok()?.parse::<f64>().ok().map(JsonValue::Num)
    }
}

/// 对象取字段（json_parse 结果的便捷入口）
fn obj_get<'a>(v: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    v.get(key)
}

// ===== 字体目录清单缓存（find_font_path 模糊匹配与 /api/fonts 共用）=====

/// 清单条目：模糊匹配键 + 列表输出（main.rs find_font_path 跨模块读取，pub 字段）
pub struct CachedFontEntry {
    /// 去扩展名小写 stem（前缀/包含匹配键）
    pub stem_lower: String,
    /// 原始文件名（/api/fonts 输出）
    pub fname: String,
    /// 所在目录（路径拼装 + temporary 判定）
    pub dir: String,
}

struct FontDirCache {
    at: Instant,
    key: String,
    entries: Arc<Vec<CachedFontEntry>>,
}

/// 短 TTL：上传/删除后的陈旧条目最多存活 5s（成功上传会主动失效，实际窗口更小）
const FONT_DIR_CACHE_TTL: Duration = Duration::from_secs(5);
static FONT_DIR_CACHE: OnceLock<Mutex<Option<FontDirCache>>> = OnceLock::new();

/// 取字体目录清单（5s TTL）：消除每请求 readdir + 逐项 stat，成本随字体数增长的问题。
/// 精确匹配不走此缓存（直 stat，新上传字体立即可见）；上传/删除成功后主动失效
pub fn font_dir_listing(dirs: &[String]) -> Arc<Vec<CachedFontEntry>> {
    let key = dirs.join(":");
    let cell = FONT_DIR_CACHE.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().unwrap();
    if let Some(c) = g.as_ref() {
        if c.key == key && c.at.elapsed() < FONT_DIR_CACHE_TTL {
            return c.entries.clone();
        }
    }
    let entries = scan_font_dirs(dirs);
    let arc = Arc::new(entries);
    *g = Some(FontDirCache { at: Instant::now(), key, entries: arc.clone() });
    arc
}

/// 上传/删除字体后主动失效（下一次任何查找立即重建清单）
pub fn invalidate_font_dir_cache() {
    if let Some(cell) = FONT_DIR_CACHE.get() {
        *cell.lock().unwrap() = None;
    }
}

/// 全量扫描目录建清单（readdir + 逐项 stat，symlink 跟随，对齐原实现）
fn scan_font_dirs(dirs: &[String]) -> Vec<CachedFontEntry> {
    let mut all = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            if !entry_is_file(&entry, dir) {
                continue;
            }
            let fname = entry.file_name();
            let Some(fname) = fname.to_str() else { continue };
            if !crate::has_font_ext(fname) {
                continue;
            }
            all.push(CachedFontEntry {
                stem_lower: crate::strip_ext(fname).to_lowercase(),
                fname: fname.to_string(),
                dir: dir.clone(),
            });
        }
    }
    all
}

// ===== GET /api/fonts（对齐 backend/routes/fonts.ts）=====

/// 目录条目判定是否为普通文件（symlink 需跟进一次 metadata，对齐 readdir+statFile 语义）
fn entry_is_file(entry: &std::fs::DirEntry, dir: &str) -> bool {
    let Ok(ft) = entry.file_type() else { return false };
    if ft.is_file() {
        return true;
    }
    if ft.is_symlink() {
        let fname = entry.file_name();
        let Some(fname) = fname.to_str() else { return false };
        return std::fs::metadata(format!("{dir}/{fname}")).map(|m| m.is_file()).unwrap_or(false);
    }
    false
}

pub fn handle_list_fonts(
    stream: &mut TcpStream,
    dirs: &[String],
    close: bool,
) -> io::Result<bool> {
    let listing = font_dir_listing(dirs);
    let mut body = String::from("[");
    let mut first = true;
    for e in listing.iter() {
        if !first {
            body.push(',');
        }
        first = false;
        body.push_str("{\"name\":");
        body.push_str(&json_stringify_str(&e.fname));
        body.push_str(&format!(",\"temporary\":{}}}", e.dir == "font/temp"));
    }
    body.push(']');
    http::send_json(stream, 200, &body, close)?;
    Ok(close)
}

// ===== GET /api/config（对齐 backend/routes/config.ts）=====

pub fn handle_get_config(stream: &mut TcpStream, close: bool) -> io::Result<bool> {
    let c = config();
    let body = format!(
        "{{\"enableTempUpload\":{},\"adminUploadEnabled\":{},\"supportedOutTypes\":[\"ttf\",\"woff2\"],\"tempRetentionSeconds\":{},\"subsetConcurrency\":{},\"subsetQueueTimeoutSeconds\":{}}}",
        c.enable_temp_upload,
        !c.admin_api_key.is_empty(),
        c.temp_retention_seconds,
        c.subset_concurrency,
        c.subset_queue_timeout_seconds,
    );
    http::send_json(stream, 200, &body, close)?;
    Ok(close)
}

// ===== GET /api/stats + POST /api/stats/event（对齐 backend/routes/stats.ts）=====

pub fn handle_stats(
    stream: &mut TcpStream,
    close: bool,
    subset_cache_entries: usize,
    font_buffer_cache_entries: usize,
) -> io::Result<bool> {
    let c = { STATS.lock().unwrap().c };
    let uptime: u64 = (wall_now_ms() - STATS_START_MS.get().copied().unwrap_or(0)).max(0) as u64 / 1000;
    // 最近 1024 次子集请求耗时分位（可观测性：热路径健康度一眼可见）
    let lat_count = {
        let g = LATENCIES.lock().unwrap();
        g.0.len()
    };
    let lat = format!(
        "\"latencySamples\":{},\"latencyP50\":{},\"latencyP95\":{},\"latencyP99\":{}",
        lat_count,
        latency_percentile(50.0).unwrap_or(0),
        latency_percentile(95.0).unwrap_or(0),
        latency_percentile(99.0).unwrap_or(0),
    );
    let body = format!(
        "{{\"uptime\":{},\"totalRequests\":{},\"subsetRequests\":{},\"subsetCacheHits\":{},\"totalChars\":{},\"tempUploads\":{},\"offlineSubsets\":{},\"offlineDownloads\":{},\"subsetCacheEntries\":{},\"fontBufferCacheEntries\":{},{}}}",
        uptime, c.total_requests, c.subset_requests, c.subset_cache_hits, c.total_chars,
        c.temp_uploads, c.offline_subsets, c.offline_downloads,
        subset_cache_entries, font_buffer_cache_entries, lat,
    );
    http::send_json(stream, 200, &body, close)?;
    Ok(close)
}

pub fn handle_stats_event(stream: &mut TcpStream, body: &[u8], close: bool) -> io::Result<bool> {
    if body.is_empty() {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"请求体为空\"}", close)?;
        return Ok(close);
    }
    let Ok(text) = std::str::from_utf8(body) else {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"invalid body\"}", close)?;
        return Ok(close);
    };
    let Some(parsed) = json_parse(text) else {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"invalid body\"}", close)?;
        return Ok(close);
    };
    // event 字段（缺失 → unknown event；类型不符 → invalid body，对齐 Zig 类型化解析）
    let Some(ev) = parsed.get_str("event") else {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"invalid body\"}", close)?;
        return Ok(close);
    };
    let Some(ev) = ev else {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"unknown event\"}", close)?;
        return Ok(close);
    };
    // 白名单校验（对齐 OFFLINE_EVENTS），只累计计数不记录内容
    match ev {
        "offline_subset" => stats_record_offline(true),
        "offline_download" => stats_record_offline(false),
        _ => {
            http::send_json(stream, 400, "{\"success\":false,\"error\":\"unknown event\"}", close)?;
            return Ok(close);
        }
    }
    http::send_json(stream, 200, "{\"success\":true}", close)?;
    Ok(close)
}

// ===== multipart 解析（对齐 backend/multipart.ts）=====

/// multipart 单文件条目
struct MultipartFile<'a> {
    /// 表单字段名
    #[allow(dead_code)] // 只消费第一个 part 的数据，name 字段语义保留
    name: &'a [u8],
    /// 原始文件名（原始字节，取用时 lossy 转 str）
    filename: &'a [u8],
    /// 文件二进制数据
    data: &'a [u8],
}

/// 解析 multipart body（缺 boundary/起始边界返回 None → 上层 400）
fn parse_multipart<'a>(content_type: &str, body: &'a [u8]) -> Option<Vec<MultipartFile<'a>>> {
    let bo = content_type.find("boundary=")?;
    let mut boundary = &content_type[bo + "boundary=".len()..];
    if let Some(i) = boundary.find(';') {
        boundary = &boundary[..i];
    }
    if let Some(i) = boundary.find(' ') {
        boundary = &boundary[..i];
    }
    // 对齐 boundaryMatch[1].replace(/^"(.*)"$/, "$1")
    if boundary.len() >= 2 && boundary.starts_with('"') && boundary.ends_with('"') {
        boundary = &boundary[1..boundary.len() - 1];
    }

    let mut files: Vec<MultipartFile> = Vec::new();
    let delimiter = format!("\r\n--{boundary}");
    let start_boundary = format!("--{boundary}\r\n");

    let sb_pos = find_bytes(body, start_boundary.as_bytes())?;
    let mut pos = sb_pos + start_boundary.len();

    while pos < body.len() {
        let Some(header_end) = find_bytes_from(body, pos, b"\r\n\r\n") else { break };
        let header_text = &body[pos..header_end];
        let body_start = header_end + 4;

        let Some(next_boundary) = find_bytes_from(body, body_start, delimiter.as_bytes()) else { break };

        // part body 去掉末尾 "\r\n"
        let mut part = &body[body_start..next_boundary];
        if part.len() >= 2 && part[part.len() - 1] == 10 && part[part.len() - 2] == 13 {
            part = &part[..part.len() - 2];
        }

        // 从 Content-Disposition 解析 name/filename（对齐 name="([^"]*)"；原始字节，不做 UTF-8 校验）
        let name = match_quoted_attr(header_text, b"name=");
        let filename = match_quoted_attr(header_text, b"filename=");
        if let Some(n) = name {
            files.push(MultipartFile {
                name: n,
                filename: filename.unwrap_or(&[]),
                data: part,
            });
        }

        pos = next_boundary + delimiter.len();
        // boundary 后紧跟 "--" 表示结束
        if pos + 2 <= body.len() && body[pos] == 45 && body[pos + 1] == 45 {
            break;
        }
        // 跳过 boundary 后的 "\r\n"
        if pos + 1 < body.len() && body[pos] == 13 && body[pos + 1] == 10 {
            pos += 2;
        }
    }
    Some(files)
}

/// 子串查找（全 haystack）
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    find_bytes_from(haystack, 0, needle)
}

/// 子串查找（从 from 起）
fn find_bytes_from(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// 从 header 文本中取 attr="value" 的 value（正则 /attr="([^"]*)"/ 的字面实现）
fn match_quoted_attr<'a>(header: &'a [u8], attr: &[u8]) -> Option<&'a [u8]> {
    let mut search_from: usize = 0;
    while let Some(start) = find_bytes_from(header, search_from, attr) {
        // 属性名前必须是字段分界（行首/空白/分号），防止 filename= 匹配到 xxxfilename=
        if start == 0 || header[start - 1] == b' ' || header[start - 1] == b';' || header[start - 1] == b'\n' {
            let rest = &header[start + attr.len()..];
            if rest.len() >= 2 && rest[0] == b'"' {
                if let Some(end) = rest[1..].iter().position(|&b| b == b'"') {
                    return Some(&rest[1..1 + end]);
                }
            }
            return None;
        }
        search_from = start + attr.len();
    }
    None
}

// ===== POST /api/upload（对齐 backend/routes/upload.ts + upload.ts）=====

const MAX_UPLOAD_SIZE: usize = 50 * 1024 * 1024;

/// 允许的字体扩展名（对齐 isAllowedFontFile）
fn is_allowed_font_file(filename: &str) -> bool {
    crate::has_font_ext(filename)
}

/// 清理文件名：移除路径分隔符/控制字符/路径穿越/隐藏前缀（对齐 sanitizeFilename）
fn sanitize_filename(filename: &str) -> String {
    let mut out = String::new();
    for c in filename.chars() {
        if c == '/' || c == '\\' || c < ' ' {
            continue;
        }
        out.push(c);
    }
    // 移除所有 ".."
    let mut no_dots = String::new();
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '.' && chars[i + 1] == '.' {
            i += 2;
            continue;
        }
        no_dots.push(chars[i]);
        i += 1;
    }
    // 去掉开头的 '.'
    if no_dots.starts_with('.') {
        return no_dots;
    }
    if no_dots.is_empty() {
        return "unnamed.ttf".to_string();
    }
    no_dots
}

fn ensure_dir(dir: &str) {
    if std::fs::metadata(dir).is_err() {
        let _ = std::fs::create_dir_all(dir);
    }
}

/// 上传处理结果
struct UploadResult {
    success: bool,
    err: Option<&'static str>,
}

fn write_upload_result(r: &UploadResult) -> String {
    if r.success {
        "{\"success\":true}".to_string()
    } else {
        format!(
            "{{\"success\":false,\"error\":{}}}",
            json_stringify_str(r.err.unwrap_or(""))
        )
    }
}

/// temp 目录字体文件条目
struct TempFile {
    name: String,
    size: u64,
}

/// temp 目录字体文件清单（name+size，readdir 顺序近似 FIFO，对齐 getTempFontFiles）
fn get_temp_font_files() -> Vec<TempFile> {
    let Ok(entries) = std::fs::read_dir("font/temp") else { return Vec::new() };
    let mut files: Vec<TempFile> = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let fname = entry.file_name();
        let Some(fname) = fname.to_str() else { continue };
        if !is_allowed_font_file(fname) {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        files.push(TempFile { name: fname.to_string(), size: md.len() });
    }
    files
}

/// 按需清理 temp 目录使数量/体积满足限制（对齐 evictIfNeeded；incoming 为净新增字节）
fn evict_if_needed(incoming: i64) {
    let files = get_temp_font_files();
    let c = config();
    let dir = "font/temp";

    // 数量超限时按 readdir 顺序删最早的
    let mut kept: Vec<TempFile> = files;
    while kept.len() >= c.temp_max_files {
        let oldest = kept.remove(0);
        let _ = std::fs::remove_file(format!("{dir}/{}", oldest.name));
    }

    let total: u64 = kept.iter().map(|f| f.size).sum();
    let needed = total as i64 + incoming - c.temp_max_total_size as i64;
    if needed > 0 {
        let mut freed: i64 = 0;
        for f in &kept {
            if freed >= needed {
                break;
            }
            let _ = std::fs::remove_file(format!("{dir}/{}", f.name));
            freed += f.size as i64;
        }
    }
}

fn handle_temp_upload(data: &[u8], filename: &str) -> UploadResult {
    if !config().enable_temp_upload {
        return UploadResult { success: false, err: Some("临时上传功能未启用") };
    }
    if !is_allowed_font_file(filename) {
        return UploadResult { success: false, err: Some("不支持的字体文件格式，仅支持 ttf/otf/woff/woff2") };
    }
    ensure_dir("font/temp");
    let name = sanitize_filename(filename);
    let path = format!("font/temp/{name}");
    // 同名覆盖不算新增，但新文件可能更大仍需检查总体积
    match std::fs::metadata(&path) {
        Ok(existing) => evict_if_needed(data.len() as i64 - existing.len() as i64),
        Err(_) => evict_if_needed(data.len() as i64),
    }
    if std::fs::write(&path, data).is_err() {
        return UploadResult { success: false, err: Some("写入失败") };
    }
    UploadResult { success: true, err: None }
}

fn handle_admin_upload(data: &[u8], filename: &str, api_key: &str) -> UploadResult {
    if config().admin_api_key.is_empty() {
        return UploadResult { success: false, err: Some("管理员上传功能未启用") };
    }
    if api_key != config().admin_api_key {
        return UploadResult { success: false, err: Some("API Key 无效") };
    }
    if !is_allowed_font_file(filename) {
        return UploadResult { success: false, err: Some("不支持的字体文件格式，仅支持 ttf/otf/woff/woff2") };
    }
    ensure_dir("font/admin");
    let name = sanitize_filename(filename);
    let path = format!("font/admin/{name}");
    if std::fs::write(&path, data).is_err() {
        return UploadResult { success: false, err: Some("写入失败") };
    }
    UploadResult { success: true, err: None }
}

/// 从请求原始字节取头值（大小写不敏感）
pub fn get_header<'a>(req: &'a [u8], name: &str) -> Option<&'a str> {
    let mut it = req.split(|&b| b == b'\n');
    let _ = it.next(); // request line
    for h in it {
        let h = if h.last() == Some(&b'\r') { &h[..h.len() - 1] } else { h };
        if h.is_empty() {
            break;
        }
        let Some(colon) = h.iter().position(|&b| b == b':') else { continue };
        let key = &h[..colon];
        if !key.eq_ignore_ascii_case(name.as_bytes()) {
            continue;
        }
        let v = &h[colon + 1..];
        let Ok(v) = std::str::from_utf8(v) else { continue };
        return Some(v.trim_matches(|c: char| c == ' ' || c == '\t'));
    }
    None
}

pub fn handle_upload(
    stream: &mut TcpStream,
    raw_req: &[u8],
    query: &str,
    body: &[u8],
    close: bool,
) -> io::Result<bool> {
    // mode 参数（默认 temp）
    let mut mode: Option<String> = None;
    for kv in query.split('&') {
        let Some(eq) = kv.find('=') else { continue };
        if &kv[..eq] == "mode" {
            mode = String::from_utf8(http::url_decode(&kv[eq + 1..])).ok();
        }
    }

    let content_type = get_header(raw_req, "Content-Type").unwrap_or("");

    // 上传大小限制（对齐 uploadSizeMiddleware）
    let content_length: i64 = get_header(raw_req, "Content-Length")
        .and_then(|cl| cl.parse::<i64>().ok())
        .unwrap_or(0);
    if content_length > MAX_UPLOAD_SIZE as i64 {
        let body = write_upload_result(&UploadResult { success: false, err: Some("文件过大，最大 50MB") });
        http::send_json(stream, 413, &body, close)?;
        return Ok(close);
    }

    if body.is_empty() {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"请求体为空\"}", close)?;
        return Ok(close);
    }

    let Some(files) = parse_multipart(content_type, body) else {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"无效的 multipart 数据\"}", close)?;
        return Ok(close);
    };
    if files.is_empty() {
        http::send_json(stream, 400, "{\"success\":false,\"error\":\"未提供文件\"}", close)?;
        return Ok(close);
    }
    let file = &files[0];
    let filename = String::from_utf8_lossy(file.filename).into_owned();

    if mode.as_deref() == Some("admin") {
        let auth = get_header(raw_req, "Authorization").unwrap_or("");
        let api_key = auth.strip_prefix("Bearer ").unwrap_or(auth);
        let result = handle_admin_upload(file.data, &filename, api_key);
        if result.success {
            invalidate_font_dir_cache();
        }
        let out = write_upload_result(&result);
        http::send_json(stream, if result.success { 200 } else { 403 }, &out, close)?;
        return Ok(close);
    }

    let result = handle_temp_upload(file.data, &filename);
    if result.success {
        stats_record_temp_upload();
        invalidate_font_dir_cache();
    }
    let out = write_upload_result(&result);
    http::send_json(stream, if result.success { 200 } else { 400 }, &out, close)?;
    Ok(close)
}

// ===== GET /api/font-meta（对齐 backend/routes/font_meta.ts + font_util/font_meta.ts）=====

/// 元数据版本指纹（算法变更后 bump 使磁盘缓存失效）
pub const META_VERSION: u32 = 3;

/// 字符集覆盖条目
#[derive(Clone)]
struct CharsetCoverage {
    key: String,
    name: String,
    total: u32,
    covered: u32,
    percent: f64,
}

/// name 表提取的元信息
#[derive(Clone, Default)]
struct FontInfo {
    copyright: Option<String>,
    family: Option<String>,
    subfamily: Option<String>,
    unique_id: Option<String>,
    full_name: Option<String>,
    version: Option<String>,
    post_script: Option<String>,
    trademark: Option<String>,
    manufacturer: Option<String>,
    designer: Option<String>,
    description: Option<String>,
    vendor_url: Option<String>,
    designer_url: Option<String>,
    license: Option<String>,
    license_url: Option<String>,
}

/// 码位连续区间
#[derive(Clone, Copy)]
struct CpRange {
    start: u32,
    end: u32,
}

/// 完整字体元数据
struct FontMeta {
    total_code_points: u32,
    coverage: Vec<CharsetCoverage>,
    ranges: Vec<CpRange>,
    info: FontInfo,
}

/// 人工配置（font-config.json 单条目；key 为 camelCase 字段名）
#[derive(Clone, Default)]
struct UserConfig {
    display_name: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
    homepage: Option<String>,
    preview_text: Option<String>,
    body_title: Option<String>,
    body_text: Option<String>,
    charset_preview: Option<String>,
}

/// 元数据进程缓存（key = font_path）
static META_CACHE: Mutex<Option<HashMap<String, Arc<FontMeta>>>> = Mutex::new(None);

/// 闭包访问元数据缓存（惰性初始化）
fn with_meta_cache<R>(f: impl FnOnce(&mut HashMap<String, Arc<FontMeta>>) -> R) -> R {
    let mut g = META_CACHE.lock().unwrap();
    f(g.get_or_insert_with(HashMap::new))
}

/// 人工配置缓存（font-config.json，mtime 检测变更）
struct UserConfigState {
    map: HashMap<String, UserConfig>,
    mtime_ns: i128,
}

static USER_CONFIG: Mutex<Option<UserConfigState>> = Mutex::new(None);

/// 闭包访问配置状态（惰性初始化）
fn with_user_config<R>(f: impl FnOnce(&mut UserConfigState) -> R) -> R {
    let mut g = USER_CONFIG.lock().unwrap();
    if g.is_none() {
        *g = Some(UserConfigState { map: HashMap::new(), mtime_ns: 0 });
    }
    f(g.as_mut().unwrap())
}
const CONFIG_PATH: &str = "font/font-config.json";

/// 码位位集（全部 Unicode 码位空间）
struct CpBits {
    words: Vec<u64>, // 0x110000 bits
}

impl CpBits {
    fn new() -> CpBits {
        CpBits { words: vec![0; (0x110000 + 63) / 64] }
    }
    fn set(&mut self, cp: usize) {
        self.words[cp / 64] |= 1u64 << (cp % 64);
    }
    fn is_set(&self, cp: usize) -> bool {
        self.words[cp / 64] & (1u64 << (cp % 64)) != 0
    }
    fn count(&self) -> u32 {
        self.words.iter().map(|w| w.count_ones()).sum()
    }
    /// 升序遍历已置位码位
    fn iter_set(&self) -> impl Iterator<Item = u32> + '_ {
        (0..0x110000u32).filter(|&cp| self.is_set(cp as usize))
    }
}

/// ttf/otf 表目录条目
fn read_table_entry(data: &[u8], tag: &[u8; 4]) -> Option<(u32, u32)> {
    if data.len() < 12 {
        return None;
    }
    let num_tables = ((data[4] as u16) << 8) | data[5] as u16;
    if num_tables == 0 || num_tables > 100 {
        return None;
    }
    for i in 0..num_tables as usize {
        let rec = 12 + i * 16;
        if rec + 16 > data.len() {
            return None;
        }
        if &data[rec..rec + 4] == tag {
            let off = |k: usize| ((data[rec + k] as u32) << 24) | ((data[rec + k + 1] as u32) << 16) | ((data[rec + k + 2] as u32) << 8) | data[rec + k + 3] as u32;
            return Some((off(8), off(12)));
        }
    }
    None
}

fn ru16(data: &[u8], i: usize) -> u16 {
    ((data[i] as u16) << 8) | data[i + 1] as u16
}

fn ru32(data: &[u8], i: usize) -> u32 {
    ((data[i] as u32) << 24) | ((data[i + 1] as u32) << 16) | ((data[i + 2] as u32) << 8) | data[i + 3] as u32
}

/// glyph 有效性验证器：TrueType 查 loca 非空轮廓；CFF 恒真（对齐 createGlyphValidator）
struct GlyphValidator<'a> {
    data: &'a [u8],
    loca_base: usize,
    loca_format: u16,
    is_ttf: bool,
}

impl GlyphValidator<'_> {
    fn has_glyph(&self, gid: u32) -> bool {
        if !self.is_ttf {
            return true;
        }
        if self.loca_format == 0 {
            let lo_i = self.loca_base + gid as usize * 2;
            let hi_i = lo_i + 2;
            if hi_i + 2 > self.data.len() {
                return false;
            }
            let start = ru16(self.data, lo_i) as u64 * 2;
            let end = ru16(self.data, hi_i) as u64 * 2;
            return end > start;
        }
        let lo_i = self.loca_base + gid as usize * 4;
        let hi_i = lo_i + 4;
        if hi_i + 4 > self.data.len() {
            return false;
        }
        let start = ru32(self.data, lo_i);
        let end = ru32(self.data, hi_i);
        end > start
    }
}

fn create_glyph_validator(data: &[u8]) -> GlyphValidator<'_> {
    let glyf = read_table_entry(data, b"glyf");
    let loca = read_table_entry(data, b"loca");
    let head = read_table_entry(data, b"head");
    let (Some(_glyf), Some(loca), Some(head)) = (glyf, loca, head) else {
        // CFF 字体：cmap 有映射即有效
        return GlyphValidator { data, loca_base: 0, loca_format: 0, is_ttf: false };
    };
    let hf = head.0 as usize + 50;
    let loca_format: u16 = if hf + 2 <= data.len() { ru16(data, hf) } else { 0 };
    GlyphValidator { data, loca_base: loca.0 as usize, loca_format, is_ttf: true }
}

/// format4 收集（对齐 collectFormat4：gid≠0 且 loca 非空才计入）
fn collect_format4(data: &[u8], sub_off: usize, cps: &mut CpBits, gv: &GlyphValidator<'_>) {
    if sub_off + 14 > data.len() {
        return;
    }
    let seg_count = ru16(data, sub_off + 6) as usize / 2;
    let end_code_base = sub_off + 14;
    let start_code_base = end_code_base + seg_count * 2 + 2;
    let id_delta_base = start_code_base + seg_count * 2;
    let id_range_offset_base = id_delta_base + seg_count * 2;

    for i in 0..seg_count {
        let e_i = end_code_base + i * 2;
        if e_i + 2 > data.len() {
            break;
        }
        let end = ru16(data, e_i);
        let s_i = start_code_base + i * 2;
        if s_i + 2 > data.len() {
            break;
        }
        let start = ru16(data, s_i);
        // 0xFFFF 哨兵 segment 跳过
        if start == 0xFFFF {
            continue;
        }
        let d_i = id_delta_base + i * 2;
        if d_i + 2 > data.len() {
            break;
        }
        let id_delta = ru16(data, d_i);
        let ro_i = id_range_offset_base + i * 2;
        if ro_i + 2 > data.len() {
            break;
        }
        let id_range_offset = ru16(data, ro_i);

        let mut cp: u32 = start as u32;
        while cp <= end as u32 {
            if id_range_offset == 0 {
                let gid = (cp.wrapping_add(id_delta as u32)) & 0xFFFF;
                if gid != 0 && gv.has_glyph(gid as u32) {
                    cps.set(cp as usize);
                }
            } else {
                let glyph_off = id_range_offset_base + i * 2 + id_range_offset as usize + (cp - start as u32) as usize * 2;
                if glyph_off + 2 > data.len() {
                    break;
                }
                let glyph_id = ru16(data, glyph_off);
                let gid = (glyph_id.wrapping_add((cp.wrapping_add(id_delta as u32)) as u16)) & 0xFFFF;
                if glyph_id != 0 && gid != 0 && gv.has_glyph(gid as u32) {
                    cps.set(cp as usize);
                }
            }
            cp += 1;
        }
    }
}

/// format12 收集（对齐 collectFormat12：逐 cp 验证 loca 非空）
fn collect_format12(data: &[u8], sub_off: usize, cps: &mut CpBits, gv: &GlyphValidator<'_>) {
    if sub_off + 16 > data.len() {
        return;
    }
    let n_groups = ru32(data, sub_off + 12);
    let groups_base = sub_off + 16;
    for i in 0..n_groups {
        let g_off = groups_base + i as usize * 12;
        if g_off + 12 > data.len() {
            break;
        }
        let g_start = ru32(data, g_off);
        let g_end = ru32(data, g_off + 4);
        let g_gid = ru32(data, g_off + 8);
        let mut cp = g_start;
        while cp <= g_end {
            let gid = g_gid.wrapping_add(cp - g_start);
            if gid != 0 && gv.has_glyph(gid) {
                cps.set(cp as usize);
            }
            cp += 1;
        }
    }
}

/// 从字体字节收集所有有效 codepoint（对齐 extractCodePoints：fmt12 优先 + fmt4 补充）
fn extract_code_points(data: &[u8]) -> CpBits {
    let mut cps = CpBits::new();
    let Some(cmap) = read_table_entry(data, b"cmap") else { return cps };

    let number_subtables = ru16(data, cmap.0 as usize + 2);
    let mut fmt4_off: Option<usize> = None;
    let mut fmt12_off: Option<usize> = None;
    let mut dir = cmap.0 as usize + 4;
    for _ in 0..number_subtables {
        if dir + 8 > data.len() {
            break;
        }
        let platform_id = ru16(data, dir);
        let encoding_id = ru16(data, dir + 2);
        let sub_rel = ru32(data, dir + 4);
        let sub_off = cmap.0 as usize + sub_rel as usize;
        if sub_off + 2 <= data.len() {
            let format = ru16(data, sub_off);
            if format == 12 && platform_id == 3 && encoding_id == 10 && fmt12_off.is_none() {
                fmt12_off = Some(sub_off);
            } else if format == 4 && platform_id == 3 && encoding_id == 1 && fmt4_off.is_none() {
                fmt4_off = Some(sub_off);
            }
        }
        dir += 8;
    }

    let gv = create_glyph_validator(data);
    if let Some(off) = fmt12_off {
        collect_format12(data, off, &mut cps, &gv);
    }
    if let Some(off) = fmt4_off {
        collect_format4(data, off, &mut cps, &gv);
    }
    cps
}

/// 标准字符集（对齐 CHARSETS）
const CHARSETS: [(&str, &str, u32, u32); 7] = [
    ("ascii", "英文字母数字", 0x20, 0x7e),
    ("commonHanzi", "常用汉字（约3500）", 0x4e00, 0x5bad),
    ("cjkBasic", "CJK 基本汉字（20992）", 0x4e00, 0x9fff),
    ("cjkExtA", "CJK 扩展A（罕用字）", 0x3400, 0x4dbf),
    ("punctuation", "中文标点", 0x3000, 0x303f),
    ("fullwidth", "全角字符", 0xff00, 0xffef),
    ("cyrillic", "西里尔字母/俄文", 0x400, 0x4ff),
];

/// 计算各类字符集覆盖率（对齐 calcCoverage）
fn calc_coverage(cps: &CpBits) -> Vec<CharsetCoverage> {
    CHARSETS
        .iter()
        .map(|&(key, name, start, end)| {
            let mut covered: u32 = 0;
            for cp in start..=end {
                if cps.is_set(cp as usize) {
                    covered += 1;
                }
            }
            let total = end - start + 1;
            let percent = if total > 0 {
                (covered as f64 / total as f64 * 1000.0).round() / 10.0
            } else {
                0.0
            };
            CharsetCoverage { key: key.to_string(), name: name.to_string(), total, covered, percent }
        })
        .collect()
}

/// codepoint 位集 → 连续区间数组（对齐 codePointsToRanges）
fn code_points_to_ranges(cps: &CpBits) -> Vec<CpRange> {
    let mut ranges: Vec<CpRange> = Vec::new();
    let mut current: Option<CpRange> = None;
    for cp in cps.iter_set() {
        if let Some(c) = current {
            if cp == c.end + 1 {
                current = Some(CpRange { start: c.start, end: cp });
                continue;
            }
            ranges.push(c);
        }
        current = Some(CpRange { start: cp, end: cp });
    }
    if let Some(c) = current {
        ranges.push(c);
    }
    ranges
}

/// UTF-16BE 码元流解码（对齐 decodeNameString platformID=3：代理对合成，孤立代理 → U+FFFD）
fn decode_utf16be(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut i: usize = 0;
    while i + 2 <= bytes.len() {
        let unit = ((bytes[i] as u16) << 8) | bytes[i + 1] as u16;
        if (0xd800..=0xdbff).contains(&unit) && i + 4 <= bytes.len() {
            let lo = ((bytes[i + 2] as u16) << 8) | bytes[i + 3] as u16;
            if (0xdc00..=0xdfff).contains(&lo) {
                let cp: u32 = 0x10000 + ((unit as u32 - 0xd800) << 10) + (lo as u32 - 0xdc00);
                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                i += 4; // zig 分支内 i+=2 + 循环步进 i+=2
                continue;
            }
        }
        if (0xd800..=0xdfff).contains(&unit) {
            // 孤立代理（TS 此处抛 RangeError 属崩溃边界）→ 用 U+FFFD 保守替代
            out.push('\u{fffd}');
        } else if unit != 0 {
            out.push(char::from_u32(unit as u32).unwrap_or('\u{fffd}'));
        }
        i += 2;
    }
    out
}

/// 字节流按 UTF-8 lossy 解码（对齐 TextDecoder 默认：非法序列替换 U+FFFD）
fn decode_utf8_lossy(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut i: usize = 0;
    while i < bytes.len() {
        let len = match utf8_seq_len(bytes[i]) {
            Some(l) => l,
            None => {
                out.push('\u{fffd}');
                i += 1;
                continue;
            }
        };
        if i + len > bytes.len() {
            out.push('\u{fffd}');
            i += 1;
            continue;
        }
        match std::str::from_utf8(&bytes[i..i + len]) {
            Ok(t) => out.push_str(t),
            Err(_) => out.push('\u{fffd}'),
        }
        i += len;
    }
    out
}

/// name 表提取（对齐 extractFontInfo：优先级 Windows 英文 > Windows > Mac）
fn extract_font_info(data: &[u8]) -> FontInfo {
    let Some(entry) = read_table_entry(data, b"name") else { return FontInfo::default() };
    let base = entry.0 as usize;
    if base + 6 > data.len() {
        return FontInfo::default();
    }

    let count = ru16(data, base + 2);
    let string_offset = ru16(data, base + 4);
    let storage_base = base + string_offset as usize;

    // EXTRACT_NAME_IDS 恰为 0~14，按下标收集
    let mut collected: [Option<String>; 15] = Default::default();
    let mut priorities: [u8; 15] = [0; 15];

    let record_base = base + 6;
    for i in 0..count {
        let rec = record_base + i as usize * 12;
        if rec + 12 > data.len() {
            break;
        }
        let platform_id = ru16(data, rec);
        let encoding_id = ru16(data, rec + 2);
        let language_id = ru16(data, rec + 4);
        let name_id = ru16(data, rec + 6);
        let length = ru16(data, rec + 8);
        let offset = ru16(data, rec + 10);

        if name_id >= 15 {
            continue;
        }

        let priority: u8 = if platform_id == 3 && language_id == 0x0409 {
            4
        } else if platform_id == 3 && encoding_id == 1 {
            3
        } else if platform_id == 3 {
            2
        } else if platform_id == 1 {
            1
        } else {
            0
        };
        if collected[name_id as usize].is_some() && priorities[name_id as usize] >= priority {
            continue;
        }

        let str_off = storage_base + offset as usize;
        if str_off + length as usize > data.len() {
            // 对齐 decodeNameString 越界返回 ""（不覆盖已有值）
            continue;
        }
        let raw = &data[str_off..str_off + length as usize];
        let text = if platform_id == 3 {
            decode_utf16be(raw)
        } else {
            decode_utf8_lossy(raw)
        };
        if !text.is_empty() {
            collected[name_id as usize] = Some(text);
            priorities[name_id as usize] = priority;
        }
    }

    let mut c = collected.into_iter();
    FontInfo {
        copyright: c.next().unwrap(),
        family: c.next().unwrap(),
        subfamily: c.next().unwrap(),
        unique_id: c.next().unwrap(),
        full_name: c.next().unwrap(),
        version: c.next().unwrap(),
        post_script: c.next().unwrap(),
        trademark: c.next().unwrap(),
        manufacturer: c.next().unwrap(),
        designer: c.next().unwrap(),
        description: c.next().unwrap(),
        vendor_url: c.next().unwrap(),
        designer_url: c.next().unwrap(),
        license: c.next().unwrap(),
        license_url: c.next().unwrap(),
    }
}

/// 完整元数据提取（对齐 extractFontMeta）
fn extract_font_meta(data: &[u8]) -> FontMeta {
    let cps = extract_code_points(data);
    FontMeta {
        total_code_points: cps.count(),
        coverage: calc_coverage(&cps),
        ranges: code_points_to_ranges(&cps),
        info: extract_font_info(data),
    }
}

/// 写元数据 JSON（config 为 None 时输出磁盘缓存形态；字段顺序对齐 TS JSON.stringify）
fn write_meta_json(meta: &FontMeta, config: Option<&UserConfig>) -> String {
    let mut w = String::new();
    w.push_str(&format!(
        "{{\"metaVersion\":{},\"totalCodePoints\":{},\"coverage\":[",
        META_VERSION, meta.total_code_points
    ));
    for (i, c) in meta.coverage.iter().enumerate() {
        if i > 0 {
            w.push(',');
        }
        w.push_str("{\"key\":");
        w.push_str(&json_stringify_str(&c.key));
        w.push_str(",\"name\":");
        w.push_str(&json_stringify_str(&c.name));
        w.push_str(&format!(",\"total\":{},\"covered\":{},\"percent\":", c.total, c.covered));
        w.push_str(&json_percent(c.percent));
        w.push('}');
    }
    w.push_str("],\"ranges\":[");
    for (i, r) in meta.ranges.iter().enumerate() {
        if i > 0 {
            w.push(',');
        }
        w.push_str(&format!("[{},{}]", r.start, r.end));
    }
    w.push_str("],\"info\":{");
    let fields: [(&str, &Option<String>); 15] = [
        ("copyright", &meta.info.copyright),
        ("family", &meta.info.family),
        ("subfamily", &meta.info.subfamily),
        ("uniqueId", &meta.info.unique_id),
        ("fullName", &meta.info.full_name),
        ("version", &meta.info.version),
        ("postScript", &meta.info.post_script),
        ("trademark", &meta.info.trademark),
        ("manufacturer", &meta.info.manufacturer),
        ("designer", &meta.info.designer),
        ("description", &meta.info.description),
        ("vendorUrl", &meta.info.vendor_url),
        ("designerUrl", &meta.info.designer_url),
        ("license", &meta.info.license),
        ("licenseUrl", &meta.info.license_url),
    ];
    let mut first = true;
    for (name, value) in fields {
        if let Some(v) = value {
            if !first {
                w.push(',');
            }
            first = false;
            w.push('"');
            w.push_str(name);
            w.push_str("\":");
            w.push_str(&json_stringify_str(v));
        }
    }
    w.push('}');
    if let Some(c) = config {
        w.push_str(",\"config\":{");
        let str_fields: [(&str, &Option<String>); 7] = [
            ("displayName", &c.display_name),
            ("description", &c.description),
            ("homepage", &c.homepage),
            ("previewText", &c.preview_text),
            ("bodyTitle", &c.body_title),
            ("bodyText", &c.body_text),
            ("charsetPreview", &c.charset_preview),
        ];
        let mut cfirst = true;
        for (name, value) in str_fields {
            if let Some(v) = value {
                if !cfirst {
                    w.push(',');
                }
                cfirst = false;
                w.push('"');
                w.push_str(name);
                w.push_str("\":");
                w.push_str(&json_stringify_str(v));
            }
        }
        if let Some(tags) = &c.tags {
            if !cfirst {
                w.push(',');
            }
            w.push_str("\"tags\":[");
            for (ti, t) in tags.iter().enumerate() {
                if ti > 0 {
                    w.push(',');
                }
                w.push_str(&json_stringify_str(t));
            }
            w.push(']');
        }
        w.push('}');
    }
    w.push('}');
    w
}

/// mtime 是否变化（对齐 refreshUserConfig 的廉价检测）
fn refresh_user_config() {
    with_user_config(|g| {
        refresh_user_config_locked(g);
    });
}

/// mtime 变更后重载（持锁段，对齐 refreshUserConfig 的廉价检测）
fn refresh_user_config_locked(g: &mut UserConfigState) {
    let Ok(md) = std::fs::metadata(CONFIG_PATH) else { return };
    if !md.is_file() || md.len() == 0 {
        return;
    }
    let mtime_ns: i128 = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    if mtime_ns == g.mtime_ns {
        return;
    }
    g.mtime_ns = mtime_ns;

    let Ok(raw) = std::fs::read_to_string(CONFIG_PATH) else { return };
    let Some(v) = json_parse(raw.trim()) else { return };
    let JsonValue::Obj(items) = v else { return };
    g.map.clear();
    for (key, val) in items {
        // 非 object 值（类型化解析失败）整条跳过，对齐 Zig 两头解析路径
        let Some(uc) = user_config_from_json(&val) else { continue };
        g.map.insert(key, uc);
    }
}

/// JsonValue → UserConfig（存在但类型不符的字段使整条失败，对齐 Zig 类型化解析）
fn user_config_from_json(v: &JsonValue) -> Option<UserConfig> {
    if !matches!(v, JsonValue::Obj(_)) {
        return None;
    }
    // 字符串字段提取（缺失 → None；类型不符 → 整条失败）
    let s = |key: &str| -> Option<Option<String>> {
        match v.get(key) {
            Some(JsonValue::Str(x)) => Some(Some(x.clone())),
            Some(_) => None,
            None => Some(None),
        }
    };
    let tags = match v.get("tags") {
        Some(JsonValue::Arr(items)) => {
            let mut out: Vec<String> = Vec::with_capacity(items.len());
            for it in items {
                match it {
                    JsonValue::Str(x) => out.push(x.clone()),
                    _ => return None,
                }
            }
            Some(out)
        }
        Some(_) => return None,
        None => None,
    };
    Some(UserConfig {
        display_name: s("displayName")?,
        description: s("description")?,
        tags,
        homepage: s("homepage")?,
        preview_text: s("previewText")?,
        body_title: s("bodyTitle")?,
        body_text: s("bodyText")?,
        charset_preview: s("charsetPreview")?,
    })
}

/// 匹配 font-config.json 的 key：取 basename（对齐 fontBasename）
fn font_basename(font_path: &str) -> &str {
    match font_path.rfind('/') {
        Some(i) => &font_path[i + 1..],
        None => font_path,
    }
}

/// {"error":"字体不存在: <name>"}（JSON 转义）
fn build_not_found_json(font_name: &str) -> String {
    format!("{{\"error\":\"字体不存在: {}\"}}", json_stringify_str(font_name))
}

/// 磁盘 .meta.json → FontMeta（版本指纹不匹配返回 None）
fn meta_from_disk_json(raw: &str) -> Option<FontMeta> {
    let v = json_parse(raw.trim())?;
    let meta_version = v.get_u32("metaVersion")??;
    if meta_version != META_VERSION {
        return None;
    }
    let total = v.get_u32("totalCodePoints")??;

    let JsonValue::Arr(cov_arr) = v.get("coverage")? else { return None };
    let mut coverage: Vec<CharsetCoverage> = Vec::with_capacity(cov_arr.len());
    for item in cov_arr {
        let key = item.get_str("key")??;
        let name = item.get_str("name")??;
        let total_c = item.get_u32("total")??;
        let covered = item.get_u32("covered")??;
        let percent = match item.get("percent")? {
            JsonValue::Num(n) => *n,
            _ => return None,
        };
        coverage.push(CharsetCoverage {
            key: key.to_string(),
            name: name.to_string(),
            total: total_c,
            covered,
            percent,
        });
    }

    let JsonValue::Arr(rng_arr) = v.get("ranges")? else { return None };
    let mut ranges: Vec<CpRange> = Vec::with_capacity(rng_arr.len());
    for item in rng_arr {
        let JsonValue::Arr(pair) = item else { return None };
        if pair.len() != 2 {
            return None;
        }
        let start = pair_u32(&pair[0])?;
        let end = pair_u32(&pair[1])?;
        ranges.push(CpRange { start, end });
    }

    let info_v = v.get("info")?;
    let opt = |key: &str| info_v.get_str(key).flatten().map(|s| s.to_string());
    let info = FontInfo {
        copyright: opt("copyright"),
        family: opt("family"),
        subfamily: opt("subfamily"),
        unique_id: opt("uniqueId"),
        full_name: opt("fullName"),
        version: opt("version"),
        post_script: opt("postScript"),
        trademark: opt("trademark"),
        manufacturer: opt("manufacturer"),
        designer: opt("designer"),
        description: opt("description"),
        vendor_url: opt("vendorUrl"),
        designer_url: opt("designerUrl"),
        license: opt("license"),
        license_url: opt("licenseUrl"),
    };

    Some(FontMeta { total_code_points: total, coverage, ranges, info })
}

/// ranges 数组元素取 u32
fn pair_u32(v: &JsonValue) -> Option<u32> {
    match v {
        JsonValue::Num(n) if *n >= 0.0 && *n <= u32::MAX as f64 && n.fract() == 0.0 => Some(*n as u32),
        _ => None,
    }
}

pub fn handle_font_meta(
    stream: &mut TcpStream,
    dirs: &[String],
    query: &str,
    close: bool,
) -> io::Result<bool> {
    let mut font_name = String::new();
    for kv in query.split('&') {
        let Some(eq) = kv.find('=') else { continue };
        if &kv[..eq] == "font" {
            if let Ok(s) = String::from_utf8(http::url_decode(&kv[eq + 1..])) {
                font_name = s;
            }
        }
    }
    if font_name.is_empty() {
        http::send_json(stream, 400, "{\"error\":\"缺少 font 参数\"}", close)?;
        return Ok(close);
    }
    let Some(font_path) = crate::find_font_path(dirs, &font_name) else {
        let msg = build_not_found_json(&font_name);
        http::send_json(stream, 404, &msg, close)?;
        return Ok(close);
    };

    refresh_user_config();

    // 1. 进程内存命中 → 2. 磁盘 .meta.json（版本指纹不匹配视为 miss）→ 3. 现算
    let mut meta: Option<Arc<FontMeta>> = with_meta_cache(|m| m.get(&font_path).cloned());
    if meta.is_none() {
        // 磁盘缓存（对齐 loadMetaFromDisk + META_VERSION 校验）
        let meta_path = format!("{font_path}.meta.json");
        if let Ok(raw) = std::fs::read_to_string(&meta_path) {
            meta = meta_from_disk_json(&raw).map(Arc::new);
        }
        if meta.is_none() {
            // CPU/内存密集，复用子集化并发闸门（对齐 withMemoryGate + 503）
            let memory_bytes = estimate_subset_memory(&font_path);
            if !gate_acquire(queue_timeout_ms(), memory_bytes) {
                http::send_text(stream, 503, "Server busy, please retry", close, &["Retry-After: 1"])?;
                return Ok(close);
            }
            let extracted = match std::fs::read(&font_path) {
                Ok(data) => {
                    let m = extract_font_meta(&data);
                    gate_release(memory_bytes);
                    Arc::new(m)
                }
                Err(_) => {
                    gate_release(memory_bytes);
                    http::send_text(stream, 404, "font not found", close, &[])?;
                    return Ok(close);
                }
            };
            meta = Some(extracted);
            // 写盘缓存（失败不影响响应，对齐 saveMetaToDisk）
            let disk_form = write_meta_json(meta.as_ref().unwrap(), None);
            let _ = std::fs::write(&meta_path, disk_form);
        }
        // 进缓存（并发下二次检查，取先入者）
        with_meta_cache(|map| {
            if let Some(m) = map.get(&font_path) {
                meta = Some(m.clone());
            } else {
                map.insert(font_path.clone(), meta.clone().unwrap());
            }
        });
    }

    // 人工配置（basename 匹配）
    let config = with_user_config(|g| g.map.get(font_basename(&font_path)).cloned());

    let body = write_meta_json(&meta.unwrap(), config.as_ref());
    http::send_json(stream, 200, &body, close)?;
    Ok(close)
}

// ===== 静态资源 + 字体详情页 SSR（对齐 backend/app.ts staticFileMiddleware + routes/font_detail.ts）=====

const ROOT_DIR: &str = "dist";

/// SSG 模板占位符（对齐 src/placeholders.ts）
const FONT_NAME_PH: &str = "__FONT_NAME__";
const FONT_SLUG_PH: &str = "__FONT_SLUG__";
const ORIGIN_PH: &str = "__ORIGIN__";

/// MIME 映射（对齐 server/mime_type.ts；大小写敏感、缺省 application/octet-stream）
fn mime_type(ext: &str) -> &'static str {
    const TABLE: [(&str, &str); 13] = [
        ("html", "text/html"),
        ("css", "text/css"),
        ("js", "application/javascript; charset=utf-8"),
        ("json", "application/json"),
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("svg", "image/svg+xml"),
        ("woff", "font/woff"),
        ("woff2", "font/woff2"),
        ("ttf", "font/ttf"),
        ("otf", "font/otf"),
    ];
    for (e, m) in TABLE {
        if e == ext {
            return m;
        }
    }
    "application/octet-stream"
}

/// 带任意 Content-Type 的 200 响应（静态资源/SSR/SPA fallback 共用，含 CORS 头）
fn send_file_bytes(stream: &mut TcpStream, bytes: &[u8], content_type: &str, close: bool) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n",
        bytes.len()
    );
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n");
    head.push_str("Access-Control-Allow-Headers: Content-Type, Authorization\r\n");
    head.push_str(&format!("Connection: {}\r\n\r\n", if close { "close" } else { "keep-alive" }));
    http::write_all(stream, &[head.as_bytes(), bytes])
}

/// SSG 模板缓存（进程级读一次，对齐 templateCache）
static TEMPLATE_CACHE: Mutex<Option<String>> = Mutex::new(None);

fn get_template() -> Option<String> {
    let mut g = TEMPLATE_CACHE.lock().unwrap();
    if let Some(t) = &*g {
        return Some(t.clone());
    }
    let path = format!("{ROOT_DIR}/fonts/{FONT_NAME_PH}/index.html");
    let raw = std::fs::read_to_string(&path).ok()?;
    *g = Some(raw.clone());
    Some(raw)
}

/// 查询字体是否存在（任意目录为文件即存在，对齐 getFontMeta）
fn font_exists(dirs: &[String], slug: &str) -> bool {
    for dir in dirs {
        if std::fs::metadata(format!("{dir}/{slug}"))
            .map(|m| m.is_file())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// 字体详情页 SSR：读 SSG 模板替换占位符；模板不存在返回 None 走 SPA fallback
fn handle_font_detail(dirs: &[String], raw_path: &str) -> Option<String> {
    // 提取 slug：/fonts/令东齐伋复刻体.ttf → 令东齐伋复刻体.ttf（decodeURIComponent + 去尾部 /）
    let mut slug = &raw_path["/fonts/".len()..];
    if slug.ends_with('/') {
        slug = &slug[..slug.len() - 1];
    }
    let slug = String::from_utf8(http::url_decode(slug)).ok()?;

    let template = get_template()?;

    let exists = font_exists(dirs, &slug);

    // 占位符 → 实际值（对齐 values：FONT_NAME/FONT_SLUG=slug，ORIGIN=""）
    let mut html = template.replace(FONT_NAME_PH, &slug);
    html = html.replace(FONT_SLUG_PH, &slug);
    html = html.replace(ORIGIN_PH, "");

    // 字体不存在时在 head 注入 noindex（replace 只替换第一处，对齐 String.replace）
    if !exists {
        if let Some(pos) = html.find("</head>") {
            html = format!(
                "{}<meta name=\"robots\" content=\"noindex\">\n</head>{}",
                &html[..pos],
                &html[pos + "</head>".len()..]
            );
        }
    }
    Some(html)
}

/// 解析静态文件：精确文件 → 目录/index.html → 读出字节（对齐 try 块三情况）。
/// 返回 (字节, 实际落盘文件路径)——目录情形展开为 index.html，
/// Content-Type 须按实际文件扩展名判定（/fonts → dist/fonts/index.html → text/html；
/// 按原始路径判定会得 application/octet-stream，浏览器把页面导航当下载中止）
fn resolve_static(file_path: &str) -> Option<(Vec<u8>, String)> {
    let md = std::fs::metadata(file_path).ok()?;
    let mut resolved = file_path.to_string();
    if md.is_dir() {
        resolved = format!("{file_path}/index.html");
        std::fs::metadata(&resolved).ok()?;
    }
    std::fs::read(&resolved).ok().map(|b| (b, resolved))
}

/// 文件扩展名（大小写敏感，对齐 split(".").pop()）
fn ext_of(path: &str) -> &str {
    if let Some(i) = path.rfind('.') {
        // 对齐 JS：无点或点后为空（路径以 / 结尾等）返回空串
        if i + 1 < path.len() && i > 0 && path.as_bytes()[i - 1] != b'/' {
            return &path[i + 1..];
        }
    }
    ""
}

/// 路径是否带后缀（对齐 /\.[^/]+$/：最后一段含 '.'）
fn path_has_ext(path: &str) -> bool {
    let last_seg = match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    };
    last_seg.rfind('.').is_some()
}

/// 静态资源中间件：GET → dist 静态/SSR/SPA fallback；非 GET → 405（对齐 staticFileMiddleware）
pub fn handle_static(
    stream: &mut TcpStream,
    dirs: &[String],
    method: &str,
    pathname: &str,
    close: bool,
) -> io::Result<bool> {
    if method != "GET" {
        http::send_text(stream, 405, "Method Not Allowed", close, &[])?;
        return Ok(close);
    }

    let file_path = if pathname == "/" {
        format!("{ROOT_DIR}/index.html")
    } else {
        format!("{ROOT_DIR}{pathname}")
    };
    // 防止路径穿越：规范化后必须仍在 dist 目录内
    if !file_path.starts_with("dist/") && file_path != ROOT_DIR {
        http::send_text(stream, 403, "403 Forbidden", close, &[])?;
        return Ok(close);
    }

    if let Some((bytes, resolved)) = resolve_static(&file_path) {
        send_file_bytes(stream, &bytes, mime_type(ext_of(&resolved)), close)?;
        return Ok(close);
    }

    // 字体详情页 SSR：/fonts/xxx 无预渲染文件时读模板替换占位符
    if let Some(prefix) = pathname.strip_prefix("/fonts/") {
        let _ = prefix;
        if let Some(html) = handle_font_detail(dirs, pathname) {
            send_file_bytes(stream, html.as_bytes(), "text/html; charset=utf-8", close)?;
            return Ok(close);
        }
    }

    // 带后缀的请求不 fallback 直接 404；否则 SPA fallback 返回根 index.html
    if path_has_ext(pathname) {
        http::send_text(stream, 404, "404 Not Found", close, &[])?;
        return Ok(close);
    }
    match std::fs::read(format!("{ROOT_DIR}/index.html")) {
        Ok(fallback) => {
            send_file_bytes(stream, &fallback, "text/html; charset=utf-8", close)?;
            Ok(close)
        }
        Err(_) => {
            http::send_text(stream, 500, "index.html missing", close, &[])?;
            Ok(close)
        }
    }
}

// ===== POST /api/glyph-match（原属 zig main.zig，NDJSON 事件）=====

/// UTF-8 首码点（语义对齐 char.codePointAt(0)；非法序列报错 → None）
fn first_code_point(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.is_empty() {
        return None;
    }
    let len = utf8_seq_len(b[0])?;
    if b.len() < len {
        return None;
    }
    std::str::from_utf8(&b[..len]).ok()?.chars().next().map(|c| c as u32)
}

/// POST /api/glyph-match —— 逐字体光栅化评分，NDJSON 事件返回
/// 语义对齐 backend/routes/glyph_match.ts 慢路径（无 .gidx 索引/聚类，直接从
/// 原字体光栅化：子集不改动轮廓坐标，评分结果与 TS 索引位图逐位一致）
pub fn handle_glyph_match(
    stream: &mut TcpStream,
    dirs: &[String],
    fonts: &FontCache,
    body: &[u8],
    close: bool,
) -> io::Result<bool> {
    if body.is_empty() {
        http::send_json(stream, 400, "{\"error\":\"request body required\"}", close)?;
        return Ok(close);
    }
    let Ok(text) = std::str::from_utf8(body) else {
        http::send_json(stream, 400, "{\"error\":\"invalid json\"}", close)?;
        return Ok(close);
    };
    let Some(parsed) = json_parse(text) else {
        http::send_json(stream, 400, "{\"error\":\"invalid json\"}", close)?;
        return Ok(close);
    };
    // glyphs 数组（缺失按空处理；存在但类型不符 → invalid json，对齐 Zig 类型化解析）
    let glyph_items: Vec<JsonValue> = match parsed.get("glyphs") {
        Some(JsonValue::Arr(a)) => a.clone(),
        Some(_) => {
            http::send_json(stream, 400, "{\"error\":\"invalid json\"}", close)?;
            return Ok(close);
        }
        None => Vec::new(),
    };
    // 先收条目（char/bitmap 类型不符 → invalid json，对齐 Zig 类型化解析）
    let mut pairs: Vec<(String, String)> = Vec::with_capacity(glyph_items.len());
    for g in &glyph_items {
        let JsonValue::Obj(_) = g else {
            http::send_json(stream, 400, "{\"error\":\"invalid json\"}", close)?;
            return Ok(close);
        };
        let ch = match g.get_str("char") {
            Some(Some(s)) => s.to_string(),
            Some(None) => String::new(),
            None => {
                http::send_json(stream, 400, "{\"error\":\"invalid json\"}", close)?;
                return Ok(close);
            }
        };
        let bm = match g.get_str("bitmap") {
            Some(Some(s)) => s.to_string(),
            Some(None) => String::new(),
            None => {
                http::send_json(stream, 400, "{\"error\":\"invalid json\"}", close)?;
                return Ok(close);
            }
        };
        pairs.push((ch, bm));
    }
    // 查询字形过滤语义对齐 TS：char 非空 + 位图恰为 4096 个 0/1
    let mut raws: Vec<gm::RawGlyph<'_>> = Vec::with_capacity(pairs.len());
    for (ch, bm) in &pairs {
        let cp = if !ch.is_empty() { first_code_point(ch) } else { None };
        raws.push(gm::RawGlyph { char: ch.as_bytes(), bitmap: bm.as_bytes(), code_point: cp });
    }
    let queries = gm::parse_query_glyphs(&raws);
    if queries.is_empty() {
        http::send_json(stream, 400, "{\"error\":\"glyphs required (char + 64x64 bitmap)\"}", close)?;
        return Ok(close);
    }

    // 收集候选字体（目录序 × readdir 序，语义对齐 listCandidateFonts）
    struct Cand {
        name: String,
        path: String,
    }
    let mut cands: Vec<Cand> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            if !entry_is_file(&entry, dir) {
                continue;
            }
            let fname = entry.file_name();
            let Some(fname) = fname.to_str() else { continue };
            if !crate::has_font_ext(fname) {
                continue;
            }
            cands.push(Cand { name: fname.to_string(), path: format!("{dir}/{fname}") });
        }
    }

    // NDJSON 事件流（一次性收集全量再返回，语义对齐 collectMatchEvents 非流式形态）
    let mut out = String::new();
    out.push_str(&format!("{{\"type\":\"start\",\"total\":{}}}\n", cands.len()));

    for cand in &cands {
        // 逐字体内存闸门（对齐 glyph_match.ts 慢路径 withMemoryGate；排队超时仅 fontDone 跳过）
        let est = estimate_subset_memory(&cand.path);
        if !gate_acquire(queue_timeout_ms(), est) {
            out.push_str(&format!("{{\"type\":\"fontDone\",\"font\":{}}}\n", json_stringify_str(&cand.name)));
            continue;
        }

        let font = match fonts.get_or_parse(&cand.path) {
            Ok(f) => Some(f),
            Err(_) => {
                // 单个字体裁剪/解析失败不拖垮整个搜索（语义对齐 catch 后仅 fontDone）
                None
            }
        };
        let Some(font) = font else {
            out.push_str(&format!("{{\"type\":\"fontDone\",\"font\":{}}}\n", json_stringify_str(&cand.name)));
            gate_release(est);
            continue;
        };
        // OTF（CFF 轮廓）不参与评分：TS 慢路径 subset.ttf 为 null 直接返回 []
        if !font.has_table(b"glyf") {
            out.push_str(&format!("{{\"type\":\"fontDone\",\"font\":{}}}\n", json_stringify_str(&cand.name)));
            gate_release(est);
            continue;
        }

        let mut started = false;
        let mut has_match = false;
        for q in &queries {
            if font.glyph_id(q.code_point).is_none() {
                if started {
                    out.push_str(&format!(
                        "{{\"type\":\"glyph\",\"font\":{},\"glyph\":null,\"missing\":true}}\n",
                        json_stringify_str(&cand.name)
                    ));
                }
                continue;
            }
            if !started {
                started = true;
                out.push_str(&format!(
                    "{{\"type\":\"font\",\"font\":{},\"subset\":\"\"}}\n",
                    json_stringify_str(&cand.name)
                ));
            }
            let Some(bm) = gm::get_glyph_bitmap(&font, q.code_point) else {
                out.push_str(&format!(
                    "{{\"type\":\"glyph\",\"font\":{},\"glyph\":null,\"missing\":true}}\n",
                    json_stringify_str(&cand.name)
                ));
                continue;
            };
            has_match = true;
            let mut dt_b: gm::DtT = [0.0; gm::GRID * gm::GRID];
            gm::distance_transform(&bm[..], &mut dt_b);
            let score = gm::glyph_similarity(&q.bitmap[..], &bm[..], &q.dt[..], &dt_b[..]);
            let ch = std::str::from_utf8(raws[q.query_index].char).unwrap_or("");
            out.push_str(&format!(
                "{{\"type\":\"glyph\",\"font\":{},\"glyph\":{{\"char\":{},\"score\":{},\"queryIndex\":{}}},\"missing\":false}}\n",
                json_stringify_str(&cand.name),
                json_stringify_str(ch),
                score,
                q.query_index
            ));
        }
        // 全部缺字的候选不展示，但仍计入完成进度
        if started && !has_match {
            out.push_str(&format!(
                "{{\"type\":\"glyph\",\"font\":{},\"glyph\":null,\"missing\":true}}\n",
                json_stringify_str(&cand.name)
            ));
        }
        out.push_str(&format!("{{\"type\":\"fontDone\",\"font\":{}}}\n", json_stringify_str(&cand.name)));
        gate_release(est);
    }
    out.push_str("{\"type\":\"done\"}\n");

    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nX-Accel-Buffering: no\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nConnection: close\r\n\r\n",
        out.len()
    );
    http::write_all(stream, &[head.as_bytes(), out.as_bytes()])?;
    Ok(true) // TS 显式 Connection: close
}

// ===== 字体扩展名判定 =====
// misc 模块内统一使用 crate::has_font_ext（main.rs 同名实现，语义对齐 main.zig hasFontExt）

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_len_utf8_bmp_and_astral() {
        assert_eq!(utf16_len_utf8("abc"), 3);
        assert_eq!(utf16_len_utf8("字体"), 2);
        // U+1F600 → 2 个 UTF-16 码元
        assert_eq!(utf16_len_utf8("😀"), 2);
        assert_eq!(utf16_len_utf8("a😀字"), 4);
    }

    #[test]
    fn json_stringify_escapes_like_json_stringify() {
        assert_eq!(json_stringify_str("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_stringify_str("x\ny"), "\"x\\ny\"");
        assert_eq!(json_stringify_str("\u{1}"), "\"\\u0001\"");
        assert_eq!(json_stringify_str("字体"), "\"字体\"");
    }

    #[test]
    fn json_parse_basic() {
        let v = json_parse(r#"{"a":1,"b":[true,null,"x\ny"],"c":{"d":-2.5}}"#).unwrap();
        assert_eq!(v.get("a"), Some(&JsonValue::Num(1.0)));
        match v.get("b") {
            Some(JsonValue::Arr(a)) => {
                assert_eq!(a.len(), 3);
                assert_eq!(a[0], JsonValue::Bool(true));
                // JSON 文本里的 \n 转义 → 真实换行
                assert_eq!(a[2], JsonValue::Str("x\ny".to_string()));
            }
            _ => panic!("b 应为数组"),
        }
        assert!(matches!(v.get("c").unwrap().get("d"), Some(JsonValue::Num(n)) if *n == -2.5));
        assert!(json_parse("{").is_none());
        assert!(json_parse("[1,]").is_none());
    }

    #[test]
    fn json_parse_unicode_escape() {
        let v = json_parse(r#""字""#).unwrap();
        assert_eq!(v, JsonValue::Str("字".to_string()));
        // 代理对 U+1F600
        let v = json_parse(r#""😀""#).unwrap();
        assert_eq!(v, JsonValue::Str("😀".to_string()));
    }

    #[test]
    fn multipart_parse_basic() {
        let ct = "multipart/form-data; boundary=XYZ";
        let body = b"--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.ttf\"\r\nContent-Type: font/ttf\r\n\r\nBIN\r\n--XYZ--\r\n";
        let files = parse_multipart(ct, body).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, b"a.ttf");
        assert_eq!(files[0].data, b"BIN");
    }

    #[test]
    fn sanitize_filename_strips_traversal() {
        assert_eq!(sanitize_filename("../../x/y..z.ttf"), "xyz.ttf");
        assert_eq!(sanitize_filename(".hidden.ttf"), ".hidden.ttf");
        assert_eq!(sanitize_filename(""), "unnamed.ttf");
    }

    #[test]
    fn json_percent_formats_like_js() {
        assert_eq!(json_percent(100.0), "100");
        assert_eq!(json_percent(12.3), "12.3");
        assert_eq!(json_percent(0.0), "0");
    }

    #[test]
    fn first_code_point_semantics() {
        assert_eq!(first_code_point("字"), Some(0x5b57));
        assert_eq!(first_code_point("ab"), Some('a' as u32));
        assert_eq!(first_code_point(""), None);
        assert_eq!(first_code_point("\u{fffd}"), Some(0xfffd));
    }
}
