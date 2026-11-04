//! webfont-rs spike：HTTP 服务 + TTF 子集化（对译 zig-spike/src/main.zig）
//! 用法：PORT=8090 FONT_DIR=../font ./webfont-rs
//!       webfont-rs bench <font> <text> [iters]  （纯计算微基准，输出 checksum 防 DCE）
//!
//! 语义对齐 backend/routes/subset.ts（缓存/响应头/错误码），以 zig-spike 版为第二 oracle。

mod cache;
mod cff;
mod glyph_match;
mod gsub;
mod http;
mod misc;
mod ttf;
mod woff2;

use std::io::Read;
use std::net::TcpListener;
use std::time::Instant;

use cache::{FontCache, SubsetCache, DEFAULT_SUBSET_CACHE_MAX_BYTES};

/// 字体目录列表（启动时确定）：FONT_DIRS（冒号分隔）> FONT_DIR（单目录）> TS 默认三目录
const DEFAULT_FONT_DIRS: [&str; 3] = ["font/admin", "font", "font/temp"];

/// 共享服务状态
struct App {
    font_dirs: Vec<String>,
    fonts: FontCache,
    subset_cache: SubsetCache,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        match args[1].as_str() {
            "bench" => return run_bench(&args[2..]),
            "alloc-stats" => return run_alloc_stats(&args[2..]),
            other => {
                eprintln!("未知子命令: {other}（可用: bench, alloc-stats）");
                std::process::exit(2);
            }
        }
    }
    run_server();
}

/// 计数分配器：wrap System 累加分配/释放次数与字节（alloc-stats 诊断用）
struct CountingAlloc;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

static ALLOC_N: AtomicUsize = AtomicUsize::new(0);
static ALLOC_B: AtomicUsize = AtomicUsize::new(0);
static REALLOC_N: AtomicUsize = AtomicUsize::new(0);
static REALLOC_B: AtomicUsize = AtomicUsize::new(0);
static DEALLOC_N: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOC_N.fetch_add(1, Ordering::Relaxed);
        ALLOC_B.fetch_add(l.size(), Ordering::Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        DEALLOC_N.fetch_add(1, Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        REALLOC_N.fetch_add(1, Ordering::Relaxed);
        REALLOC_B.fetch_add(n.saturating_sub(l.size()), Ordering::Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        ALLOC_N.fetch_add(1, Ordering::Relaxed);
        ALLOC_B.fetch_add(l.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
}

#[global_allocator]
static GLOBAL_ALLOC: CountingAlloc = CountingAlloc;

/// 诊断子命令：统计稳态单次 subset 的分配次数与字节量（性能优化期工具）
fn run_alloc_stats(args: &[String]) {
    let (font_path, text, iters) = match args {
        [f, t] => (f.as_str(), t.as_str(), 100usize),
        [f, t, i] => (f.as_str(), t.as_str(), i.parse().unwrap_or(100)),
        _ => {
            eprintln!("用法: webfont-rs alloc-stats <font> <text> [iters]");
            std::process::exit(2);
        }
    };
    let data = std::fs::read(font_path).expect("read font");
    let font = ttf::Font::parse(data).expect("parse");
    for _ in 0..20 {
        let _ = ttf::subset(&font, text).expect("subset");
    }
    ALLOC_N.store(0, Ordering::Relaxed);
    ALLOC_B.store(0, Ordering::Relaxed);
    REALLOC_N.store(0, Ordering::Relaxed);
    REALLOC_B.store(0, Ordering::Relaxed);
    DEALLOC_N.store(0, Ordering::Relaxed);
    for _ in 0..iters {
        let _ = ttf::subset(&font, text).expect("subset");
    }
    let it = iters as f64;
    eprintln!(
        "alloc: {:.1} 次/迭代, {:.0}B/迭代 | realloc: {:.1} 次/迭代, 搬移+{:.0}B/迭代 | dealloc: {:.1} 次/迭代",
        ALLOC_N.load(Ordering::Relaxed) as f64 / it,
        ALLOC_B.load(Ordering::Relaxed) as f64 / it,
        REALLOC_N.load(Ordering::Relaxed) as f64 / it,
        REALLOC_B.load(Ordering::Relaxed) as f64 / it,
        DEALLOC_N.load(Ordering::Relaxed) as f64 / it,
    );
}

fn run_server() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8090);
    let font_dirs = resolve_font_dirs();
    let subset_max: usize = std::env::var("SUBSET_CACHE_MAX_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_SUBSET_CACHE_MAX_BYTES);

    let app = std::sync::Arc::new(App {
        font_dirs,
        fonts: FontCache::new(),
        subset_cache: SubsetCache::new(subset_max),
    });

    // misc 初始化（配置解析/统计恢复/目录创建/后台线程，对齐 zig misc.init 在 listen 之前）
    misc::init();

    // 字体空闲卸载：FONT_IDLE_UNLOAD_SECONDS 秒未被使用的解析体释放内存（0 = 关闭）
    // 内存受限环境（容器限额）下冷门大字体不再长期驻留；再次访问重付一次读盘+解析
    let idle_secs: u64 = std::env::var("FONT_IDLE_UNLOAD_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1800);
    if idle_secs > 0 {
        let app = app.clone();
        eprintln!("[font-idle-unload] 阈值 {idle_secs}s，扫描周期 60s，压力卸载水位 15%");
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            // 时间卸载：日常释放久未使用的字体
            let n = app.fonts.evict_idle(std::time::Duration::from_secs(idle_secs));
            if n > 0 {
                eprintln!("[font-idle-unload] 卸载 {n} 个空闲字体");
            }
            // 压力卸载兜底：内存水位不足时按 LRU 再卸（至少保留 2 个热字体）
            if misc::memory_under_pressure() {
                let p = app.fonts.evict_under_pressure(2, || !misc::memory_under_pressure());
                if p > 0 {
                    eprintln!("[font-idle-unload] 内存压力，LRU 卸载 {p} 个字体");
                }
            }
        });
    }

    let listener = TcpListener::bind(("0.0.0.0", port)).expect("bind");
    let dirs = app.font_dirs.join(":");
    eprintln!("webfont-rs listening on {port}, font_dirs={dirs}");

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let app = app.clone();
        // 每连接一线程：keep-alive 长连接不阻塞其他客户端（对齐 Zig connThread 模型）
        std::thread::spawn(move || {
            let _ = conn_loop(&app, stream);
        });
    }
}

/// 解析字体目录配置（优先级：FONT_DIRS > FONT_DIR > 默认三目录）
fn resolve_font_dirs() -> Vec<String> {
    if let Ok(s) = std::env::var("FONT_DIRS") {
        let list: Vec<String> = s.split(':').filter(|d| !d.is_empty()).map(String::from).collect();
        if !list.is_empty() {
            return list;
        }
    }
    if let Ok(d) = std::env::var("FONT_DIR") {
        return vec![d];
    }
    DEFAULT_FONT_DIRS.iter().map(|s| s.to_string()).collect()
}

/// 请求行 + 头解析结果
struct Request<'a> {
    method: &'a str,
    path: &'a str,
    query: &'a str,
    body: &'a [u8],
    close: bool,
    /// If-None-Match 请求头（协商缓存 304 判定）
    if_none_match: Option<String>,
}

/// 连接线程主体：keep-alive 循环，按 Content-Length 完整取帧后处理（对译 connThread/extractFrame）
fn conn_loop(app: &App, mut stream: std::net::TcpStream) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
    let mut rbuf = [0u8; 16 * 1024];
    loop {
        if let Some(total) = extract_frame(&buf) {
            let req_bytes = &buf[..total];
            let close = process_request(app, &mut stream, req_bytes)?;
            // 移除已消费字节（剩余是下一请求的开头）
            buf.drain(..total);
            if close {
                return Ok(());
            }
            continue;
        }
        if buf.len() > 1024 * 1024 {
            let _ = http::send_text(&mut stream, 400, "request too large", true, &[]);
            return Ok(());
        }
        let n = stream.read(&mut rbuf)?;
        if n == 0 {
            return Ok(()); // 客户端关闭
        }
        buf.extend_from_slice(&rbuf[..n]);
    }
}

/// 判定缓冲里是否有完整请求帧（头结束 + Content-Length 全 body）；无则 None（继续等读）
fn extract_frame(req: &[u8]) -> Option<usize> {
    let hdr_end = find(req, b"\r\n\r\n")?;
    let head = &req[..hdr_end];
    let mut content_length = 0usize;
    for h in head.split(|&b| b == b'\n') {
        let h = trim_cr(h);
        let Some(colon) = h.iter().position(|&b| b == b':') else { continue };
        let name = &h[..colon];
        if !name.eq_ignore_ascii_case(b"content-length") {
            continue;
        }
        let mut v = &h[colon + 1..];
        while let Some(&f) = v.first() {
            if f == b' ' || f == b'\t' { v = &v[1..]; } else { break; }
        }
        content_length = std::str::from_utf8(v).ok()?.trim().parse().unwrap_or(0);
        break;
    }
    let total = hdr_end + 4 + content_length;
    if req.len() < total {
        return None;
    }
    Some(total)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn trim_cr(h: &[u8]) -> &[u8] {
    match h.last() {
        Some(&b'\r') => &h[..h.len() - 1],
        _ => h,
    }
}

/// 解析请求行 + 头（对译 parseRequest + headerWantsClose）
fn parse_request(req: &[u8]) -> Option<Request<'_>> {
    let line_end = find(req, b"\r\n")?;
    let line = &req[..line_end];
    let sp1 = line.iter().position(|&b| b == b' ')?;
    let method = &line[..sp1];
    let rest = &line[sp1 + 1..];
    let rest = &rest[rest.iter().position(|&b| b != b' ').unwrap_or(rest.len())..];
    let sp2 = rest.iter().rposition(|&b| b == b' ')?;
    let target = &rest[..sp2];
    let qpos = target.iter().position(|&b| b == b'?');
    let (path, query) = match qpos {
        Some(q) => (&target[..q], &target[q + 1..]),
        None => (target, &target[target.len()..]),
    };
    let close = header_wants_close(req);
    let hdr_end = find(req, b"\r\n\r\n")?;
    let if_none_match = header_value(req, b"if-none-match")
        .and_then(|v| String::from_utf8(v.to_vec()).ok());
    Some(Request {
        if_none_match,
        method: std::str::from_utf8(method).ok()?,
        path: std::str::from_utf8(path).ok()?,
        query: std::str::from_utf8(query).ok()?,
        body: &req[hdr_end + 4..],
        close,
    })
}

/// 扫描请求头取指定头的值（大小写不敏感；找不到返 None）
fn header_value<'a>(req: &'a [u8], name: &[u8]) -> Option<&'a [u8]> {
    for h in req.split(|&b| b == b'\n') {
        let h = trim_cr(h);
        if h.is_empty() {
            break;
        }
        let Some(colon) = h.iter().position(|&b| b == b':') else { continue };
        if !h[..colon].eq_ignore_ascii_case(name) {
            continue;
        }
        let mut v = &h[colon + 1..];
        while let Some(&f) = v.first() {
            if f == b' ' || f == b'\t' { v = &v[1..]; } else { break; }
        }
        return Some(v);
    }
    None
}

/// 扫描请求头是否 Connection: close
fn header_wants_close(req: &[u8]) -> bool {
    for h in req.split(|&b| b == b'\n') {
        let h = trim_cr(h);
        if h.is_empty() {
            break; // 空行 = 头结束
        }
        let Some(colon) = h.iter().position(|&b| b == b':') else { continue };
        if !h[..colon].eq_ignore_ascii_case(b"connection") {
            continue;
        }
        let mut v = &h[colon + 1..];
        while let Some(&f) = v.first() {
            if f == b' ' || f == b'\t' { v = &v[1..]; } else { break; }
        }
        return v.eq_ignore_ascii_case(b"close");
    }
    false
}

/// 处理单个请求，返回 true 表示应关闭连接（对译 processRequest + routeRequest）
fn process_request(app: &App, stream: &mut std::net::TcpStream, req_bytes: &[u8]) -> std::io::Result<bool> {
    let Some(r) = parse_request(req_bytes) else {
        http::send_text(stream, 400, "bad request", true, &[])?;
        return Ok(true);
    };
    let close = r.close;
    let t0 = Instant::now();

    // 日志中间件 + 总请求计数（对齐 logMiddleware：响应后打印 [Nms] METHOD path）
    misc::stats_total_request();
    let out_close = route_request(app, stream, req_bytes, &r, close)?;

    // 日志中间件（对齐 logMiddleware：响应后打印 [Nms] METHOD path）
    eprintln!("[{}ms] {} {}", t0.elapsed().as_millis(), r.method, r.path);
    Ok(out_close)
}

/// 统一路由表（对齐 zig routeRequest：app.ts fontApiMiddleware + 静态资源中间件的兜底顺序）
fn route_request(
    app: &App,
    stream: &mut std::net::TcpStream,
    req_bytes: &[u8],
    r: &Request<'_>,
    close: bool,
) -> std::io::Result<bool> {
    // CORS 预检（corsMiddleware 的 OPTIONS 分支：204 + Content-Length: 0，无 CORS 头）
    if r.method == "OPTIONS" {
        http::send_options(stream, close)?;
        return Ok(close);
    }
    let is_get = r.method == "GET";
    let is_post = r.method == "POST";

    if r.path == "/api/fonts" && is_get {
        return misc::handle_list_fonts(stream, &app.font_dirs, close);
    }
    if r.path == "/api/config" && is_get {
        return misc::handle_get_config(stream, close);
    }
    if r.path == "/api/stats" && is_get {
        return misc::handle_stats(stream, close, app.subset_cache.len(), app.fonts.len());
    }
    if r.path == "/api/stats/event" && is_post {
        return misc::handle_stats_event(stream, r.body, close);
    }
    if r.path == "/api/upload" && is_post {
        return misc::handle_upload(stream, req_bytes, r.query, r.body, close);
    }
    if r.path == "/api/font-meta" && is_get {
        return misc::handle_font_meta(stream, &app.font_dirs, r.query, close);
    }
    if r.path == "/api" && is_get {
        return handle_subset(app, stream, r.query, close, r.if_none_match.as_deref());
    }
    if r.path == "/api/glyph-match" && is_post {
        return misc::handle_glyph_match(stream, &app.font_dirs, &app.fonts, r.body, close);
    }

    // 未匹配路由 → 静态资源中间件（GET 走 dist/SSR/SPA fallback，非 GET 405）
    misc::handle_static(stream, &app.font_dirs, r.method, r.path, close)
}

/// GET /api?font=..&text=..&outType=.. —— 字体裁剪（对译 handleSubset，语义对齐 backend/routes/subset.ts）
fn handle_subset(
    app: &App,
    stream: &mut std::net::TcpStream,
    query: &str,
    close: bool,
    if_none_match: Option<&str>,
) -> std::io::Result<bool> {
    let t0 = Instant::now();
    let mut font_name: Vec<u8> = Vec::new();
    let mut text: Vec<u8> = Vec::new();
    let mut out_woff2 = false;
    for kv in query.split('&') {
        let Some(eq) = kv.find('=') else { continue };
        let (k, v) = (&kv[..eq], &kv[eq + 1..]);
        match k {
            "font" => font_name = http::url_decode(v),
            "text" => text = http::url_decode(v),
            "outType" if v == "woff2" => out_woff2 = true,
            _ => {}
        }
    }
    let Ok(font_name) = std::str::from_utf8(&font_name) else {
        http::send_text(stream, 400, "bad font", close, &[])?;
        return Ok(close);
    };
    // TS 语义：text 为空时不响应（框架原样透传 res，连接挂起）；Rust 收线等价安全
    if text.is_empty() {
        return Ok(true);
    }
    // 路径穿越防护（Zig 额外加固；TS 无此拦截）
    if font_name.contains("..") {
        http::send_text(stream, 400, "bad font", close, &[])?;
        return Ok(close);
    }
    let Ok(text) = std::str::from_utf8(&text) else {
        http::send_text(stream, 400, "bad text", close, &[])?;
        return Ok(close);
    };
    let Some(font_path) = find_font_path(&app.font_dirs, font_name) else {
        let msg = format!("Font not found: {font_name}");
        http::send_text(stream, 404, &msg, close, &[])?;
        return Ok(close);
    };
    let t1 = Instant::now();

    // 记录字体被使用（临时字体保留机制）+ 子集化计数（对齐 subset.ts 顺序）
    misc::mark_font_used(&font_path);
    misc::stats_record_subset(misc::utf16_len_utf8(text));

    // 查询裁剪结果缓存（key 对齐 TS：fontPath:outType:text）
    let cache_key = format!(
        "{font_path}:{}:{text}",
        if out_woff2 { "woff2" } else { "ttf" }
    );
    if let Some(bytes) = app.subset_cache.get(&cache_key) {
        misc::stats_record_cache_hit();
        let t_hit = Instant::now();
        let timing = [format!("X-Timing-Total: {}", ms(t0, t_hit))];
        let timing: Vec<&str> = timing.iter().map(|s| s.as_str()).collect();
        let etag = http::etag_of(&bytes);
        http::send_font(
            stream,
            &bytes,
            close,
            if out_woff2 { "font/woff2" } else { "font/ttf" },
            &["X-Cache: HIT"],
            &timing,
            &etag,
            if_none_match,
        )?;
        return Ok(close);
    }

    // 内存闸门：完整字体读取和裁剪都在闸门内；缓存命中不占槽位（对齐 subset.ts）
    let est = misc::estimate_subset_memory(&font_path);
    if !misc::gate_acquire(misc::queue_timeout_ms(), est) {
        http::send_text(stream, 503, "Server busy, please retry", close, &["Retry-After: 1"])?;
        return Ok(close);
    }

    let font = match app.fonts.get_or_parse(&font_path) {
        Ok(f) => f,
        Err(cache::FontCacheError::NotFound) => {
            misc::gate_release(est);
            http::send_text(stream, 404, "font not found", close, &[])?;
            return Ok(close);
        }
        Err(cache::FontCacheError::ParseFailed) => {
            misc::gate_release(est);
            http::send_text(stream, 422, "font parse failed", close, &[])?;
            return Ok(close);
        }
    };
    let t2 = Instant::now();
    let result = match ttf::subset(&font, text) {
        Ok(b) => b,
        Err(ttf::SubsetError::NotTtf) => {
            misc::gate_release(est);
            http::send_text(stream, 422, "not a ttf font", close, &[])?;
            return Ok(close);
        }
        Err(ttf::SubsetError::SubsetFailed) => {
            misc::gate_release(est);
            http::send_text(stream, 422, "subset failed", close, &[])?;
            return Ok(close);
        }
    };
    // woff2 编码（outType=woff2 时）。Zig 版 `try` 上抛后 defer 释放闸门再静默收线
    let out_bytes: Vec<u8> = if out_woff2 {
        match woff2::encode_ttf_to_woff2(&result) {
            Ok(b) => b,
            Err(_) => {
                misc::gate_release(est);
                return Ok(true);
            }
        }
    } else {
        result
    };
    let t3 = Instant::now();
    misc::gate_release(est);

    app.subset_cache.insert(&cache_key, out_bytes.to_vec());

    let timing = [
        format!("X-Timing-Find: {}", ms(t0, t1)),
        format!("X-Timing-Read: {}", ms(t1, t2)),
        format!("X-Timing-Subset: {}", ms(t2, t3)),
        format!("X-Timing-Total: {}", ms(t0, t3)),
    ];
    let timing: Vec<&str> = timing.iter().map(|s| s.as_str()).collect();
    let etag = http::etag_of(&out_bytes);
    http::send_font(
        stream,
        &out_bytes,
        close,
        if out_woff2 { "font/woff2" } else { "font/ttf" },
        &["X-Cache: MISS"],
        &timing,
        &etag,
        if_none_match,
    )?;
    Ok(close)
}

/// 毫秒耗时（X-Timing-* 头）
fn ms(from: Instant, to: Instant) -> u128 {
    to.duration_since(from).as_millis()
}

/// 在所有字体目录中查找字体文件（对译 findFontPath：精确 > 前缀 > 包含，大小写不敏感，扩展名剥除比较）
pub(crate) fn find_font_path(dirs: &[String], name: &str) -> Option<String> {
    // 精确匹配（不缓存：直 stat，新上传字体立即可见）
    for dir in dirs {
        let p = format!("{dir}/{name}");
        if let Ok(md) = std::fs::metadata(&p) {
            if md.is_file() {
                return Some(p);
            }
        }
    }
    // 模糊匹配（前缀 > 包含）走共享清单缓存（5s TTL，上传后主动失效）：
    // 原实现每请求 readdir + 逐项 stat，成本随字体数线性增长（线上实测 find 4ms）
    let listing = misc::font_dir_listing(dirs);
    let query = strip_ext(name).to_lowercase();
    for e in listing.iter() {
        if e.stem_lower.starts_with(&query) {
            return Some(format!("{}/{}", e.dir, e.fname));
        }
    }
    for e in listing.iter() {
        if e.stem_lower.contains(&query) {
            return Some(format!("{}/{}", e.dir, e.fname));
        }
    }
    None
}

/// 剥最后一个扩展名（语义对齐 JS name.replace(/\.[^.]+$/, "")）
fn strip_ext(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) => &name[..dot],
        None => name,
    }
}

/// 字体扩展名判定（大小写不敏感，语义对齐 /\.(ttf|otf|woff|woff2)$/i）
pub(crate) fn has_font_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".ttf", ".otf", ".woff", ".woff2"].iter().any(|e| lower.len() > e.len() && lower.ends_with(e))
}

/// 纯计算微基准：parse 一次，循环 subset 计 avg/min，累积 checksum 防编译器死代码消除
/// （对译 runBench；防 DCE 规则见 memory benchmark-dce-checksum-rule）
fn run_bench(args: &[String]) {
    let (font_path, text, iters) = match args {
        [f, t] => (f.as_str(), t.as_str(), 500usize),
        [f, t, i] => (f.as_str(), t.as_str(), i.parse().unwrap_or(500)),
        _ => {
            eprintln!("用法: webfont-rs bench <font> <text> [iters]");
            std::process::exit(2);
        }
    };
    let data = std::fs::read(font_path).expect("read font");
    let t0 = Instant::now();
    let font = ttf::Font::parse(data).expect("parse");
    eprintln!("Font.parse: {}ms", t0.elapsed().as_millis());

    let mut checksum: u64 = 0;
    let mut total_us: u128 = 0;
    let mut min_us: u128 = u128::MAX;
    // 预热 20 次（页缓存/JIT 无但 allocator/缓存热身），计入 checksum
    for _ in 0..20 {
        let r = ttf::subset(&font, text).expect("subset");
        checksum = checksum.wrapping_add(r.len() as u64 + r[0] as u64 + r[r.len() - 1] as u64);
    }
    for _ in 0..iters {
        let t0 = Instant::now();
        let r = ttf::subset(&font, text).expect("subset");
        let d = t0.elapsed();
        total_us += d.as_micros();
        min_us = min_us.min(d.as_micros());
        checksum = checksum.wrapping_add(r.len() as u64 + r[0] as u64 + r[r.len() - 1] as u64);
    }
    eprintln!(
        "iters={iters} checksum=0x{checksum:x} avg={:.3}ms min={:.3}ms",
        total_us as f64 / iters as f64 / 1000.0,
        min_us as f64 / 1000.0,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_frame_partial_and_complete() {
        let full = b"GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi";
        assert_eq!(extract_frame(full), Some(full.len()));
        assert_eq!(extract_frame(&full[..full.len() - 1]), None); // body 未齐
        assert_eq!(extract_frame(b"GET / HTTP/1.1\r\n"), None); // 头未结束
    }

    #[test]
    fn parse_request_fields() {
        let req = b"GET /api?font=a.ttf&text=%E5%AD%97 HTTP/1.1\r\nConnection: close\r\n\r\nbody";
        let r = parse_request(req).unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.path, "/api");
        assert_eq!(r.query, "font=a.ttf&text=%E5%AD%97");
        assert_eq!(r.body, b"body");
        assert!(r.close);
    }

    #[test]
    fn font_ext_case_insensitive() {
        assert!(has_font_ext("A.TTF"));
        assert!(has_font_ext("x.woff2"));
        assert!(!has_font_ext("x.ttf.txt"));
        assert!(!has_font_ext(".ttf")); // 与 Zig 一致：len > e.len 才算
    }
}
