//! GET /api/svg?font=..&text=..&size=..&color=.. —— 文字 → 字形矢量轮廓 SVG
//!
//! 语义对齐 backend/routes/svg.ts：把字符转成 TrueType 二次贝塞尔轮廓路径
//! （非 <text>），供 README / 邮件 / 不支持自定义字体的环境用 <img> 直接展示。
//! 与 TS 版的结构性差异：Rust 版不做子集化——直接从进程级缓存的完整 Font 上
//! 查 cmap + 取轮廓，省掉整条裁剪管线（更快且结果相同）。

use crate::cache::FontCacheError;
use crate::{cache, http, misc, ttf, App};

/// 二次贝塞尔轮廓 → SVG path 片段（M/L/Q/Z；TrueType 隐含中点 on-curve 语义）
fn contour_to_path(contour: &[ttf::GlyfPt], parts: &mut Vec<String>) {
    if contour.len() < 2 {
        return;
    }
    let n = contour.len();
    let mid = |a: &ttf::GlyfPt, b: &ttf::GlyfPt| (f64::from(a.x + b.x) / 2.0, f64::from(a.y + b.y) / 2.0);
    // 数值格式化：整数不带小数点，节省体积
    let num = |v: f64| -> String {
        if v.fract() == 0.0 {
            format!("{}", v as i64)
        } else {
            format!("{v}")
        }
    };

    // 找 on-curve 起点；全 off-curve（极罕见）用首尾中点作隐含起点
    let start_idx = match contour.iter().position(|p| p.on_curve) {
        Some(i) => i,
        None => 0,
    };
    let (sx, sy): (f64, f64) = if contour[start_idx].on_curve {
        (f64::from(contour[start_idx].x), f64::from(contour[start_idx].y))
    } else {
        let (mx, my) = mid(&contour[n - 1], &contour[0]);
        (mx, my)
    };
    parts.push(format!("M {} {}", num(sx), num(sy)));

    let mut prev = (sx, sy);
    // 悬挂中的 off-curve 控制点
    let mut ctrl: Option<(f64, f64)> = None;
    for k in 1..=n {
        let p = &contour[(start_idx + k) % n];
        let cur = (f64::from(p.x), f64::from(p.y));
        if p.on_curve {
            match ctrl.take() {
                Some(c) => parts.push(format!("Q {} {} {} {}", num(c.0), num(c.1), num(cur.0), num(cur.1))),
                None => parts.push(format!("L {} {}", num(cur.0), num(cur.1))),
            }
            prev = cur;
        } else {
            if let Some(c) = ctrl {
                // 连续 off-curve：前控制点与本控制点的中点是隐含 on-curve 终点
                let implied = ((c.0 + cur.0) / 2.0, (c.1 + cur.1) / 2.0);
                parts.push(format!("Q {} {} {} {}", num(c.0), num(c.1), num(implied.0), num(implied.1)));
                prev = implied;
            }
            ctrl = Some(cur);
        }
    }
    // 收尾：悬挂控制点指回起点
    if let Some(c) = ctrl {
        parts.push(format!("Q {} {} {} {}", num(c.0), num(c.1), num(sx), num(sy)));
    }
    let _ = prev;
    parts.push("Z".to_string());
}

/// 参数安全化：颜色仅允许 3/6 位十六进制，防 SVG 注入
fn sanitize_color(input: &str) -> String {
    let v: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if v.len() == 3 || v.len() == 6 {
        v
    } else {
        "333333".to_string()
    }
}

/// GET /api/svg —— 文字 → 字形矢量路径 SVG（对译 backend/routes/svg.ts）
pub fn handle_svg(
    app: &App,
    stream: &mut std::net::TcpStream,
    query: &str,
    close: bool,
    if_none_match: Option<&str>,
) -> std::io::Result<bool> {
    let mut font_name = Vec::new();
    let mut text = Vec::new();
    let mut size: i64 = 64;
    let mut color = String::new();
    for kv in query.split('&') {
        let Some(eq) = kv.find('=') else { continue };
        let (k, v) = (&kv[..eq], &kv[eq + 1..]);
        match k {
            "font" => font_name = http::url_decode(v),
            "text" => text = http::url_decode(v),
            "size" => size = v.parse().unwrap_or(64),
            "color" => color = sanitize_color(&String::from_utf8_lossy(&http::url_decode(v))),
            _ => {}
        }
    }
    let Ok(font_name) = std::str::from_utf8(&font_name) else {
        http::send_text(stream, 400, "bad font", close, &[])?;
        return Ok(close);
    };
    if text.is_empty() {
        return Ok(true);
    }
    if font_name.contains("..") {
        http::send_text(stream, 400, "bad font", close, &[])?;
        return Ok(close);
    }
    let Ok(text) = std::str::from_utf8(&text) else {
        http::send_text(stream, 400, "bad text", close, &[])?;
        return Ok(close);
    };
    let Some(font_path) = crate::find_font_path(&app.font_dirs, font_name) else {
        let msg = format!("Font not found: {font_name}");
        http::send_text(stream, 404, &msg, close, &[])?;
        return Ok(close);
    };

    let size = size.clamp(12, 400);

    misc::mark_font_used(&font_path);
    misc::stats_record_subset(misc::utf16_len_utf8(text));

    // 缓存 key 对齐 TS：svg 前缀 + 字体路径 + size + color + 文本
    let cache_key = format!("svg:{font_path}:{size}:{color}:{text}");
    if let Some(bytes) = app.subset_cache.get(&cache_key) {
        misc::stats_record_cache_hit();
        let etag = http::etag_of(&bytes);
        http::send_font(
            stream,
            &bytes,
            close,
            "image/svg+xml; charset=utf-8",
            &["X-Cache: HIT"],
            &[],
            &etag,
            if_none_match,
        )?;
        return Ok(close);
    }

    // 与 handle_subset 同闸门：字体读取/解析在闸门内，轮廓提取（毫秒级 CPU）在外
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
        Err(FontCacheError::ParseFailed) => {
            misc::gate_release(est);
            http::send_text(stream, 422, "font parse failed", close, &[])?;
            return Ok(close);
        }
    };
    misc::gate_release(est);

    let upem = f64::from(font.units_per_em.max(1));

    // 逐字符取轮廓拼 path；缺字跳过（空占位，与 TS 版一致）
    let mut paths: Vec<(f64 /*dx*/, String /*d*/)> = Vec::new();
    let mut pen_x: f64 = 0.0;
    for ch in text.chars() {
        let cp = ch as u32;
        let Some(gid) = font.cmap_get(cp) else {
            pen_x += upem / 2.0;
            continue;
        };
        let contours = match ttf::glyph_contours(&font, gid, 0) {
            Ok(c) => c,
            // CFF/OTF 轮廓不经过 glyf 表，无法转 SVG 路径（对齐 TS 版 422）
            Err(_) => {
                http::send_text(
                    stream,
                    422,
                    "SVG output is not supported for this font (CFF/OTF outline)",
                    close,
                    &[],
                )?;
                return Ok(close);
            }
        };
        let mut parts: Vec<String> = Vec::new();
        for c in &contours {
            contour_to_path(c, &mut parts);
        }
        if !parts.is_empty() {
            paths.push((pen_x, parts.join(" ")));
        }
        pen_x += f64::from(font.advance_width(gid).unwrap_or_else(|| font.units_per_em.max(1) as u16));
    }

    // 高度行框按字体单位 1.3 倍（含 ascender/descender 余量），y 翻转由 group transform 完成
    let ascent = upem * 1.05;
    let descent = upem * 0.25;
    let size_f = size as f64;
    let scale = size_f / upem;
    let total_w = pen_x;
    let svg_w = (total_w * scale).max(1.0);
    let svg_h = size_f * (ascent + descent) / upem;
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}" width="{:.2}" height="{:.2}" fill="#{}">"##,
        fmt_num(total_w),
        fmt_num(ascent + descent),
        svg_w,
        svg_h,
        color
    );
    for (dx, d) in &paths {
        svg.push_str(&format!(
            r#"<path transform="translate({} {}) scale(1 -1)" d="{}"/>"#,
            fmt_num(*dx),
            fmt_num(ascent),
            d
        ));
    }
    svg.push_str("</svg>");

    let bytes = svg.into_bytes();
    app.subset_cache.insert(&cache_key, bytes.clone());
    let etag = http::etag_of(&bytes);
    http::send_font(
        stream,
        &bytes,
        close,
        "image/svg+xml; charset=utf-8",
        &["X-Cache: MISS"],
        &[],
        &etag,
        if_none_match,
    )?;
    Ok(close)
}

/// 数值格式化：整数不带小数点
fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}
