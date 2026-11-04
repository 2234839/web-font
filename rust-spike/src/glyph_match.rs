//! glyph-match 评分引擎：字形光栅化 + Chamfer 相似度（对译 zig-spike/src/glyph_match.zig，
//! 语义对齐 backend/font_util/glyph_bitmap.ts）
//!
//! 64x64 归一化网格：TrueType 二次曲线 4 段细分 → 非零环绕扫描线填充 →
//! 紧致 bbox 归一化（12% 留边）；比对用 Chamfer 3-4 距离变换 + ±2px 平移搜索。
//! 全 f64 光栅化（与 TS number 同精度），距离场 f32（与 Float32Array 同精度）。

use crate::ttf::{self, GlyfPt};

/// 归一化网格边长（与前端 segmenter.GRID 一致）
pub const GRID: usize = 64;
/// 归一化留边比例（与前端一致：12%）
const MARGIN_RATIO: f64 = 0.12;
/// 二次曲线细分段数（64 网格精度足够）
const MID_STEPS: usize = 4;

/// 64x64 二值位图（0/1）
pub type BitmapT = [u8; GRID * GRID];
/// 位图距离场
pub type DtT = [f32; GRID * GRID];

/// 二维点（多边形顶点，y 已翻转）
#[derive(Clone, Copy)]
struct Pt {
    x: f64,
    y: f64,
}

/// 生成位图（含 Chamfer 相似度）所需查询字形
pub struct QueryGlyph {
    /// 首个码点（TS codePointAt(0) 语义）
    pub code_point: u32,
    /// 64x64 二值位图（0/1）
    pub bitmap: Box<BitmapT>,
    /// 位图距离场（解析后算一次，全库扫描复用）
    pub dt: Box<DtT>,
    /// 查询序号（回传给前端对位）
    pub query_index: usize,
}

/// 查询字形原始输入（JSON 解析后的中间形态）
pub struct RawGlyph<'a> {
    /// UTF-8 char 字段
    pub char: &'a [u8],
    /// 4096 长度的 01 串
    pub bitmap: &'a [u8],
    /// char 首码点（解码失败为 None，条目被过滤）
    pub code_point: Option<u32>,
}

/// 二次贝塞尔细分 MID_STEPS 段追加（不含起点，含终点）
fn quad(p0: Pt, pc: Pt, p1: Pt, poly: &mut Vec<Pt>) {
    for i in 1..=MID_STEPS {
        let t = i as f64 / MID_STEPS as f64;
        let mt = 1.0 - t;
        poly.push(Pt {
            x: mt * mt * p0.x + 2.0 * mt * t * pc.x + t * t * p1.x,
            y: mt * mt * p0.y + 2.0 * mt * t * pc.y + t * t * p1.y,
        });
    }
}

/// 中点
fn mid(a: Pt, b: Pt) -> Pt {
    Pt { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 }
}

/// 单条轮廓扁平化为多边形顶点序列（y 翻转 + 隐含中点 + 二次曲线细分）
fn flatten_contour(contour: &[GlyfPt]) -> Vec<Pt> {
    if contour.len() < 2 {
        return Vec::new();
    }
    let n = contour.len();
    // pts = y 翻转
    let pts: Vec<Pt> = contour
        .iter()
        .map(|p| Pt { x: p.x as f64, y: -(p.y as f64) })
        .collect();

    // 先找 on-curve 起点
    let start_idx = contour.iter().position(|p| p.on_curve);
    let Some(si) = start_idx else {
        // 全 off-curve（极罕见）：首尾中点为隐含起点
        let start_pt = mid(pts[n - 1], pts[0]);
        let mut poly = Vec::new();
        poly.push(start_pt);
        for i in 0..n {
            let cur = pts[i];
            let next = pts[(i + 1) % n];
            if contour[i].on_curve {
                poly.push(cur);
            } else {
                let end = if contour[(i + 1) % n].on_curve { next } else { mid(cur, next) };
                quad(*poly.last().unwrap(), cur, end, &mut poly);
            }
        }
        return poly;
    };

    // 正常路径：从 on-curve 起点绕一圈
    let mut poly = Vec::new();
    poly.push(pts[si]);
    let mut prev_on = pts[si];
    for k in 1..=n {
        let i = (si + k) % n;
        let cur = pts[i];
        if contour[i].on_curve {
            poly.push(cur);
            prev_on = cur;
        } else {
            let next_idx = (i + 1) % n;
            let end = if contour[next_idx].on_curve { pts[next_idx] } else { mid(cur, pts[next_idx]) };
            quad(prev_on, cur, end, &mut poly);
            // off-curve 段结束后的隐含 on-curve 点也要成为下一段的起点
            poly.push(end);
            prev_on = end;
        }
    }
    poly
}

/// 紧致 bbox 归一化多边形到 64x64 内框（12% 留边，与前端 maskToNormalizedRGBA 同参）
fn normalize_polys(polys: &[Vec<Pt>]) -> Vec<Vec<Pt>> {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for poly in polys {
        for p in poly {
            if p.x < min_x {
                min_x = p.x;
            }
            if p.x > max_x {
                max_x = p.x;
            }
            if p.y < min_y {
                min_y = p.y;
            }
            if p.y > max_y {
                max_y = p.y;
            }
        }
    }
    let w = max_x - min_x;
    let h = max_y - min_y;
    // 退化（空轮廓/纯水平线）保护
    if !(w > 0.0) || !(h > 0.0) {
        return Vec::new();
    }

    let margin = GRID as f64 * MARGIN_RATIO;
    let inner = GRID as f64 - margin * 2.0;
    let scale = (inner / w).min(inner / h);
    let dw = w * scale;
    let dh = h * scale;
    let ox = (GRID as f64 - dw) / 2.0 - min_x * scale;
    let oy = (GRID as f64 - dh) / 2.0 - min_y * scale;
    polys
        .iter()
        .map(|poly| {
            poly.iter()
                .map(|p| Pt { x: p.x * scale + ox, y: p.y * scale + oy })
                .collect()
        })
        .collect()
}

/// 交点（x 坐标 + 环绕方向）
struct Crossing {
    x: f64,
    winding: i32,
}

/// 扫描线按非零环绕规则填充多边形集合（必须合并全部轮廓的交点，保留封闭留白）
fn scanline_fill(polys: &[Vec<Pt>]) -> BitmapT {
    let mut grid: BitmapT = [0; GRID * GRID];
    let mut crossings: Vec<Crossing> = Vec::new();
    for y in 0..GRID {
        let sy = y as f64 + 0.5;
        crossings.clear();
        for poly in polys {
            if poly.len() < 3 {
                continue;
            }
            for (i, a) in poly.iter().enumerate() {
                let b = poly[(i + 1) % poly.len()];
                if a.y == b.y {
                    continue;
                }
                if (sy >= a.y && sy < b.y) || (sy >= b.y && sy < a.y) {
                    crossings.push(Crossing {
                        x: a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x),
                        winding: if a.y < b.y { 1 } else { -1 },
                    });
                }
            }
        }
        // 按 x 升序（稳定排序，对齐 Zig std.mem.sort）
        crossings.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let mut winding: i32 = 0;
        for i in 0..crossings.len().saturating_sub(1) {
            winding += crossings[i].winding;
            if winding == 0 {
                continue;
            }
            // 对齐 Zig：x0 只向下钳 0、x1 只向上钳 GRID-1，越出网格的方向不钳
            // （x0 > x1 时循环自然不执行），避免右边缘多填一格
            let x0 = ((crossings[i].x - 0.5).ceil() as i64).max(0);
            let x1 = ((crossings[i + 1].x - 0.5).floor() as i64).min(GRID as i64 - 1);
            let mut x = x0;
            while x <= x1 {
                grid[y * GRID + x as usize] = 1;
                x += 1;
            }
        }
    }
    grid
}

/// 距离变换（Chamfer 3-4 两遍扫描）：每个 0 像素到最近 1 像素的距离
pub fn distance_transform(mask: &[u8], dt: &mut DtT) {
    const INF: f32 = 1e9;
    for i in 0..dt.len() {
        dt[i] = if mask[i] != 0 { 0.0 } else { INF };
    }
    // 正向扫描（左上 → 右下）
    for y in 0..GRID {
        for x in 0..GRID {
            let i = y * GRID + x;
            let mut v = dt[i];
            if x > 0 {
                v = v.min(dt[i - 1] + 3.0);
            }
            if y > 0 {
                v = v.min(dt[i - GRID] + 3.0);
            }
            if x > 0 && y > 0 {
                v = v.min(dt[i - GRID - 1] + 4.0);
            }
            if x < GRID - 1 && y > 0 {
                v = v.min(dt[i - GRID + 1] + 4.0);
            }
            dt[i] = v;
        }
    }
    // 反向扫描（右下 → 左上）
    let mut y = GRID - 1;
    loop {
        let mut x = GRID - 1;
        loop {
            let i = y * GRID + x;
            let mut v = dt[i];
            if x < GRID - 1 {
                v = v.min(dt[i + 1] + 3.0);
            }
            if y < GRID - 1 {
                v = v.min(dt[i + GRID] + 3.0);
            }
            if x < GRID - 1 && y < GRID - 1 {
                v = v.min(dt[i + GRID + 1] + 4.0);
            }
            if x > 0 && y < GRID - 1 {
                v = v.min(dt[i + GRID - 1] + 4.0);
            }
            dt[i] = v;
            if x == 0 {
                break;
            }
            x -= 1;
        }
        if y == 0 {
            break;
        }
        y -= 1;
    }
}

/// a 的笔画像素在 dt_b 距离场上的平均距离（越近越像）；空掩码返回 -1
fn mean_distance(a: &[u8], dt_b: &[f32], dx: i64, dy: i64) -> f64 {
    let mut sum: f64 = 0.0;
    let mut count: u32 = 0;
    for y in 0..GRID {
        let sy = y as i64 + dy;
        if sy < 0 || sy >= GRID as i64 {
            continue;
        }
        for x in 0..GRID {
            if a[y * GRID + x] == 0 {
                continue;
            }
            let sx = x as i64 + dx;
            if sx < 0 || sx >= GRID as i64 {
                continue;
            }
            sum += dt_b[(sy * GRID as i64 + sx) as usize] as f64;
            count += 1;
        }
    }
    if count == 0 {
        return -1.0;
    }
    sum / count as f64 / 3.0 // 除以 3 归一到像素单位
}

/// 容错字形相似度 —— 对称 Chamfer 距离 + ±2px 平移搜索，score = exp(-worst/σ)，σ=4px
pub fn glyph_similarity(a: &[u8], b: &[u8], dt_a: &[f32], dt_b: &[f32]) -> f64 {
    let mut worst = f64::INFINITY;
    for dy in -2i64..=2 {
        for dx in -2i64..=2 {
            let d_ab = mean_distance(a, dt_b, dx, dy);
            let d_ba = mean_distance(b, dt_a, -dx, -dy);
            if d_ab < 0.0 || d_ba < 0.0 {
                continue;
            }
            let m = d_ab.max(d_ba);
            if m < worst {
                worst = m;
            }
        }
    }
    if !worst.is_finite() {
        return 0.0;
    }
    (-worst / 4.0).exp()
}

/// 从已解析字体取指定码点的归一化位图；缺字/空轮廓/全空位图返回 None（语义对齐 getGlyphBitmap）
pub fn get_glyph_bitmap(font: &ttf::Font, code_point: u32) -> Option<Box<BitmapT>> {
    let gid = font.glyph_id(code_point)?;
    let Ok(contours) = ttf::glyph_contours(font, gid, 0) else {
        return None;
    };
    if contours.is_empty() {
        return None;
    }
    let mut polys: Vec<Vec<Pt>> = Vec::new();
    for c in &contours {
        let poly = flatten_contour(c);
        if poly.len() >= 3 {
            polys.push(poly);
        }
    }
    let normalized = normalize_polys(&polys);
    if normalized.is_empty() {
        return None;
    }
    let bitmap: Box<BitmapT> = Box::new(scanline_fill(&normalized));
    // 全空位图视为缺字
    if bitmap.iter().all(|&v| v == 0) {
        return None;
    }
    Some(bitmap)
}

/// 解析查询字形列表：01 串 → 位图 + 距离场；非法位图/空 char 的条目被过滤（语义对齐 handler 过滤）
pub fn parse_query_glyphs(raw: &[RawGlyph<'_>]) -> Vec<QueryGlyph> {
    let mut out: Vec<QueryGlyph> = Vec::new();
    for (query_index, rg) in raw.iter().enumerate() {
        if rg.bitmap.len() != GRID * GRID {
            continue;
        }
        let mut bm: Box<BitmapT> = Box::new([0; GRID * GRID]);
        let mut valid = true;
        for (i, &c) in rg.bitmap.iter().enumerate() {
            if c != b'0' && c != b'1' {
                valid = false;
                break;
            }
            bm[i] = c - b'0';
        }
        if !valid {
            continue;
        }
        let Some(code_point) = rg.code_point else { continue };
        let mut dt: Box<DtT> = Box::new([0.0; GRID * GRID]);
        distance_transform(&bm[..], &mut dt);
        out.push(QueryGlyph { code_point, bitmap: bm, dt, query_index });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_transform_zero_mask_is_all_inf() {
        let mask = [0u8; GRID * GRID];
        let mut dt: DtT = [0.0; GRID * GRID];
        distance_transform(&mask, &mut dt);
        assert!(dt.iter().all(|&v| v == 1e9));
    }

    #[test]
    fn distance_transform_center_dot() {
        let mut mask = [0u8; GRID * GRID];
        mask[32 * GRID + 32] = 1;
        let mut dt: DtT = [0.0; GRID * GRID];
        distance_transform(&mask, &mut dt);
        assert_eq!(dt[32 * GRID + 32], 0.0);
        // 相邻 0 像素距离 3（Chamfer 3-4）
        assert_eq!(dt[32 * GRID + 31], 3.0);
        // 对角像素距离 4
        assert_eq!(dt[31 * GRID + 31], 4.0);
    }

    #[test]
    fn similarity_self_is_one() {
        let mut mask = [0u8; GRID * GRID];
        for y in 20..44 {
            for x in 20..44 {
                mask[y * GRID + x] = 1;
            }
        }
        let mut dt: DtT = [0.0; GRID * GRID];
        distance_transform(&mask, &mut dt);
        let s = glyph_similarity(&mask, &mask, &dt, &dt);
        assert!((s - 1.0).abs() < 1e-12);
    }

    #[test]
    fn empty_similarity_is_zero() {
        let mask = [0u8; GRID * GRID];
        let mut dt: DtT = [0.0; GRID * GRID];
        distance_transform(&mask, &mut dt);
        assert_eq!(glyph_similarity(&mask, &mask, &dt, &dt), 0.0);
    }

    #[test]
    fn parse_query_glyphs_filters_invalid() {
        let raw = [
            RawGlyph { char: b"a", bitmap: &[b'0'; 4096], code_point: Some(97) },
            RawGlyph { char: b"b", bitmap: &[b'0'; 100], code_point: Some(98) }, // 长度不足
            RawGlyph { char: b"c", bitmap: &[b'2'; 4096], code_point: Some(99) }, // 非法字符
            RawGlyph { char: b"d", bitmap: &[b'1'; 4096], code_point: None },   // 无码点
        ];
        let out = parse_query_glyphs(&raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].query_index, 0);
        assert_eq!(out[0].code_point, 97);
    }

    #[test]
    fn scanline_fill_rectangle() {
        // 一个填满 [10,54)x[10,54) 的正方形（顶点在整数网格上，扫描线 y+0.5 命中内部）
        let poly = vec![
            Pt { x: 10.0, y: 10.0 },
            Pt { x: 54.0, y: 10.0 },
            Pt { x: 54.0, y: 54.0 },
            Pt { x: 10.0, y: 54.0 },
        ];
        let grid = scanline_fill(&[poly]);
        assert_eq!(grid[30 * GRID + 30], 1);
        // 交点恰在 x=10：x0=ceil(10-0.5)=10，右界 x1=floor(54-0.5)=53（不含 54）
        assert_eq!(grid[10 * GRID + 10], 1);
        assert_eq!(grid[10 * GRID + 54], 0);
        assert_eq!(grid[9 * GRID + 30], 0); // y<10 行未命中
        assert_eq!(grid[54 * GRID + 30], 0); // y>=54 行未命中
    }
}
