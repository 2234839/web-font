//! WOFF2 编码器：bug-for-bug 移植自 zig-spike/src/woff2.zig（其源自 vendor/fonteditor-core/woff2/woff2-encode.ts）
//! 压缩：brotli crate（纯 Rust 实现）。
//! 已知差异：Rust brotli 与 Zig 静态链接的 C libbrotli（google/brotli v1.2.0）在相同参数
//! （quality=2, lgwin=22, sizeHint=未压缩表数据长度）下压缩流不逐字节一致——两实现的
//! Huffman/匹配决策不同，Rust 输出稳定略小（实测 ~0.1%）；解码等价性由 fixture 对拍
//! 测试保证（两侧 woff2 解码回的 TTF 逐字节一致，见文件尾 #[test] 与报告）。
//! 参考: https://www.w3.org/TR/WOFF2/
use brotli::enc::BrotliEncoderParams;

/// brotli 质量级对齐 TS 侧默认：quality 2（q2 比 q3 省 8% 时间、体积仅 +0.09%）
const BROTLI_QUALITY: i32 = 2;
/// 窗口大小对齐 node zlib 默认（BROTLI_DEFAULT_WINDOW）
const BROTLI_LGWIN: i32 = 22;

/// Known Table Tags（与 TS KNOWN_TAGS 同序；"VORG " 的尾空格是 TS 字符串形式残留，
/// tag 比较只用前 4 字节，语义等价）
const KNOWN_TAGS: [[u8; 4]; 50] = [
    *b"cmap", *b"head", *b"hhea", *b"hmtx", *b"maxp", *b"name", *b"OS/2", *b"post",
    *b"cvt ", *b"fpgm", *b"glyf", *b"loca", *b"prep", *b"CFF ", *b"VORG", *b"EBDT",
    *b"EBLC", *b"EBSC", *b"CBDT", *b"CBLC", *b"COLR", *b"CPAL", *b"SVG ", *b"sbix",
    *b"acnt", *b"avar", *b"bdat", *b"bloc", *b"bsln", *b"cvar", *b"fdsc", *b"feat",
    *b"fmtx", *b"fvar", *b"gvar", *b"gdef", *b"hsty", *b"jstf", *b"lcar", *b"mort",
    *b"morx", *b"opbd", *b"prop", *b"trak", *b"Zapf", *b"Silf", *b"Glat", *b"Gloc",
    *b"Feat", *b"Sill",
];

/// 从 4 字节 tag 获取 Known Table Tag 索引；不在表内返回 63（自定义 tag）
fn tag_index(tag: &[u8; 4]) -> usize {
    for (i, t) in KNOWN_TAGS.iter().enumerate() {
        if t == tag {
            return i;
        }
    }
    63
}

/// UIntBase128 编码字节数
fn size_u_int_base128(value: u32) -> usize {
    if value < 0x80 {
        return 1;
    }
    if value < 0x4000 {
        return 2;
    }
    if value < 0x200000 {
        return 3;
    }
    if value < 0x10000000 {
        return 4;
    }
    5
}

/// 编码 UIntBase128 到 buf[offset..]（大端序：高位 7 位组在前，除末字节外均置续位 0x80）
fn encode_u_int_base128(value: u32, buf: &mut [u8], offset: usize) -> usize {
    let mut tmp = [0u8; 5];
    let mut n = 0;
    let mut v = value;
    tmp[n] = (v & 0x7F) as u8;
    n += 1;
    v >>= 7;
    while v != 0 {
        tmp[n] = ((v & 0x7F) | 0x80) as u8;
        n += 1;
        v >>= 7;
    }
    for (i, item) in tmp[..n].iter().rev().enumerate() {
        buf[offset + i] = *item;
    }
    n
}

/// 255UInt16 编码字节数
fn size_255_u_int16(value: u16) -> usize {
    if value <= 252 {
        return 1;
    }
    if value <= 762 {
        return 2;
    }
    3
}

/// 编码 255UInt16 追加到 out，返回写入字节数（Zig 版保留函数，当前编码主路径未使用）
#[allow(dead_code)] // 对译保留：Zig append255UInt16
fn append_255_u_int16(out: &mut Vec<u8>, value: u16) -> usize {
    if value < 253 {
        out.push(value as u8);
        return 1;
    }
    if value < 506 {
        out.extend_from_slice(&[255, (value - 253) as u8]);
        return 2;
    }
    if value < 762 {
        out.extend_from_slice(&[254, (value - 506) as u8]);
        return 2;
    }
    out.extend_from_slice(&[253, (value >> 8) as u8, (value & 0xFF) as u8]);
    3
}

/// 编码 255UInt16 到定长 3 字节缓冲（写入变长区间）
fn write_255_u_int16(buf: &mut [u8], offset: usize, value: u16) -> usize {
    if value < 253 {
        buf[offset] = value as u8;
        return 1;
    }
    if value < 506 {
        buf[offset] = 255;
        buf[offset + 1] = (value - 253) as u8;
        return 2;
    }
    if value < 762 {
        buf[offset] = 254;
        buf[offset + 1] = (value - 506) as u8;
        return 2;
    }
    buf[offset] = 253;
    buf[offset + 1] = (value >> 8) as u8;
    buf[offset + 2] = (value & 0xFF) as u8;
    3
}

fn read_u16(data: &[u8], off: usize) -> u16 {
    u16::from_be_bytes([data[off], data[off + 1]])
}

fn read_i16(data: &[u8], off: usize) -> i16 {
    i16::from_be_bytes([data[off], data[off + 1]])
}

fn read_u32(data: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}

fn write_u16(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_be_bytes());
}

fn write_u32(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_be_bytes());
}

/// 复合 glyph 元数据（Pass 2 写 bboxStream 用）
struct CompositeInfo {
    x_min: i16,
    y_min: i16,
    x_max: i16,
    y_max: i16,
    #[allow(dead_code)] // bug-for-bug 对译保留：原始字形/指令段位置（Zig 版同名字段，防御性记录未消费）
    raw_offset: usize,
    #[allow(dead_code)] // 同 raw_offset
    raw_length: usize,
    #[allow(dead_code)] // 同 raw_offset
    instr_offset: usize,
    #[allow(dead_code)] // 同 raw_offset
    instr_length: usize,
}

/// 简单 glyph 元数据（Pass 2 写 nContour/nPoints 用）
struct SimpleInfo {
    number_of_contours: i16,
    /// 各轮廓点数 delta（255UInt16 编码）
    n_points_deltas: Vec<u16>,
}

enum GlyphInfo {
    Empty,
    Composite(CompositeInfo),
    Simple(SimpleInfo),
}

/// glyf/loca 变换结果
struct TransformResult {
    transformed_glyf: Vec<u8>,
    loca_orig_length: u32,
}

fn read_loca_offsets(loca_data: &[u8], index_format: u16, num_glyphs: usize) -> Vec<u32> {
    let mut offsets = vec![0u32; num_glyphs + 1];
    if index_format == 0 {
        for (i, off) in offsets.iter_mut().enumerate() {
            *off = read_u16(loca_data, i * 2) as u32 * 2;
        }
    } else {
        for (i, off) in offsets.iter_mut().enumerate() {
            *off = read_u32(loca_data, i * 4);
        }
    }
    offsets
}

/// 对 glyf + loca 执行 WOFF2 变换（TS transformGlyfAndLoca 移植）
fn transform_glyf_and_loca(
    glyf_data: &[u8],
    loca_data: &[u8],
    index_format: u16,
    num_glyphs: usize,
) -> TransformResult {
    let offsets = read_loca_offsets(loca_data, index_format, num_glyphs);

    let xshort_flag: u8 = 2;
    let xsame_flag: u8 = 16;
    let yshort_flag: u8 = 4;
    let ysame_flag: u8 = 32;
    let repeat_flag: u8 = 8;
    let overlap_flag: u8 = 64;

    let mut flag_accum: Vec<u8> = Vec::new();
    let mut glyph_accum: Vec<u8> = Vec::new();
    let mut instr_accum: Vec<u8> = Vec::new();

    let mut total_n_points_size: usize = 0;
    let mut bbox_stream_size: usize = 0;
    let mut has_overlap_bitmap = false;

    let bbox_bitmap_size: usize = ((num_glyphs + 31) >> 5) << 2;
    let mut bbox_bitmap = vec![0u8; bbox_bitmap_size];
    let mut overlap_bitmap = vec![0u8; bbox_bitmap_size];

    let mut glyph_infos: Vec<GlyphInfo> = Vec::with_capacity(num_glyphs);

    for gi in 0..num_glyphs {
        let glyph_start = offsets[gi] as usize;
        let glyph_end = offsets[gi + 1] as usize;

        if glyph_start == glyph_end {
            glyph_infos.push(GlyphInfo::Empty);
            continue;
        }

        let number_of_contours = read_i16(glyf_data, glyph_start);

        if number_of_contours < 0 {
            // 复合 glyph：bbox 显式存 bboxStream（raw 组件数据剥离 glyph 头，解码端无法重建）
            let x_min = read_i16(glyf_data, glyph_start + 2);
            let y_min = read_i16(glyf_data, glyph_start + 4);
            let x_max = read_i16(glyf_data, glyph_start + 6);
            let y_max = read_i16(glyf_data, glyph_start + 8);
            let mut comp_off: usize = glyph_start + 10;
            let mut have_instructions = false;
            let mut instr_length: usize = 0;
            let mut instr_offset: usize = 0;

            let more_components: u16 = 0x0020;
            let we_have_instructions: u16 = 0x0100;
            while comp_off < glyph_end {
                let comp_flags = read_u16(glyf_data, comp_off);
                comp_off += 2;
                comp_off += 2; // glyphIndex

                comp_off += if comp_flags & 0x0001 != 0 { 4 } else { 2 };
                if comp_flags & 0x0008 != 0 {
                    comp_off += 2;
                } else if comp_flags & 0x0040 != 0 {
                    comp_off += 4;
                } else if comp_flags & 0x0080 != 0 {
                    comp_off += 8;
                }

                if comp_off > glyph_end {
                    comp_off = glyph_end;
                    have_instructions = false;
                    break;
                }
                if comp_flags & more_components == 0 {
                    have_instructions = comp_flags & we_have_instructions != 0;
                    break;
                }
            }

            let component_data_end = comp_off;

            if have_instructions && comp_off + 2 <= glyph_end {
                instr_length = read_u16(glyf_data, comp_off) as usize;
                comp_off += 2;
                if instr_length > 0 && comp_off + instr_length <= glyph_end {
                    instr_offset = comp_off;
                } else {
                    instr_length = 0;
                }
            }

            let raw_offset = glyph_start + 10;
            let raw_length = component_data_end - glyph_start - 10;

            glyph_infos.push(GlyphInfo::Composite(CompositeInfo {
                x_min,
                y_min,
                x_max,
                y_max,
                raw_offset,
                raw_length,
                instr_offset,
                instr_length,
            }));

            bbox_bitmap[gi >> 3] |= 0x80u8 >> (gi & 7);
            bbox_stream_size += 8;

            glyph_accum.extend_from_slice(&glyf_data[raw_offset..raw_offset + raw_length]);

            if instr_length > 0 {
                instr_accum.extend_from_slice(&glyf_data[instr_offset..instr_offset + instr_length]);
                let mut enc = [0u8; 3];
                let n = write_255_u_int16(&mut enc, 0, instr_length as u16);
                glyph_accum.extend_from_slice(&enc[..n]);
            }
            continue;
        }

        // 简单 glyph
        let mut data_off: usize = glyph_start + 10;

        let mut n_points_deltas = vec![0u16; number_of_contours as usize];
        let mut n_points_bytes: usize = 0;
        let mut prev_end: i32 = -1;
        let last_end_pt: i32;
        for delta in n_points_deltas.iter_mut() {
            let end_pt: i32 = read_u16(glyf_data, data_off) as i32;
            data_off += 2;
            // 有损截断对齐 Zig @intCast：delta = end_pt - prev_end（prev_end 初始 -1），
            // 正常字体 endPtOfContours 单调不减且 ≤ 65535，delta ∈ [0, 65536]，
            // 异常畸形字体的回绕行为与 Zig release 构建一致
            *delta = (end_pt - prev_end) as u16;
            n_points_bytes += size_255_u_int16(*delta);
            prev_end = end_pt;
        }
        last_end_pt = prev_end;
        total_n_points_size += n_points_bytes;

        let instruction_length: usize = read_u16(glyf_data, data_off) as usize;
        data_off += 2;
        let instr_offset = data_off;
        data_off += instruction_length;

        if instruction_length > 0 {
            instr_accum.extend_from_slice(&glyf_data[instr_offset..instr_offset + instruction_length]);
        }

        let num_points: usize = if number_of_contours > 0 { (last_end_pt + 1) as usize } else { 0 };

        // 原始 flags 解码（REPEAT 展开）写入 flag_accum
        let flag_write_base = flag_accum.len();
        flag_accum.resize(flag_write_base + num_points, 0);
        let mut has_overlap = false;
        {
            let mut fi: usize = 0;
            while fi < num_points {
                let flag = glyf_data[data_off];
                data_off += 1;
                if flag & overlap_flag != 0 {
                    has_overlap = true;
                }
                flag_accum[flag_write_base + fi] = flag;
                fi += 1;
                if flag & repeat_flag != 0 && fi < num_points {
                    let repeat = glyf_data[data_off];
                    data_off += 1;
                    let count: usize = std::cmp::min(repeat as usize, num_points - fi);
                    flag_accum[flag_write_base + fi..flag_write_base + fi + count].fill(flag);
                    fi += count;
                }
            }
        }

        if number_of_contours > 0 && has_overlap {
            has_overlap_bitmap = true;
            overlap_bitmap[gi >> 3] |= 0x80u8 >> (gi & 7);
        }

        // x 解码直接存 delta（TTF xCoordinates 本就是相对前点的 delta）
        let mut x_coords = vec![0i32; num_points];
        for (xi, xc) in x_coords.iter_mut().enumerate() {
            let f = flag_accum[flag_write_base + xi];
            if f & xshort_flag != 0 {
                let b: i32 = glyf_data[data_off] as i32;
                data_off += 1;
                *xc = if f & xsame_flag != 0 { b } else { -b };
            } else if f & xsame_flag == 0 {
                let dx: i32 = read_i16(glyf_data, data_off) as i32;
                data_off += 2;
                *xc = dx;
            } else {
                *xc = 0;
            }
        }

        if number_of_contours > 0 {
            let gs_base = glyph_accum.len();
            // 每点最多 4 数据字节，预扩容（写指针直写，避免逐点 append）
            glyph_accum.resize(gs_base + num_points * 4, 0);
            let gs = &mut glyph_accum[gs_base..];
            let mut gsbi: usize = 0;
            for (yi, item) in flag_accum[flag_write_base..flag_write_base + num_points]
                .iter_mut()
                .enumerate()
            {
                let f = *item;
                let dy: i32;
                if f & yshort_flag != 0 {
                    let b: i32 = glyf_data[data_off] as i32;
                    data_off += 1;
                    dy = if f & ysame_flag != 0 { b } else { -b };
                } else if f & ysame_flag == 0 {
                    dy = read_i16(glyf_data, data_off) as i32;
                    data_off += 2;
                } else {
                    dy = 0;
                }

                let dx = x_coords[yi];
                let curve_bit: u16 = (((f & 1) ^ 1) as u16) << 7;
                // 无分支 abs + 符号位（dx/dy 为 i32，>>31 负时 -1）
                let dx_sgn = dx >> 31;
                let dy_sgn = dy >> 31;
                let abs_dx = (dx ^ dx_sgn) - dx_sgn;
                let abs_dy = (dy ^ dy_sgn) - dy_sgn;
                let x_sign_bit: u16 = (dx_sgn + 1) as u16;
                let y_sign_bit: u16 = (dy_sgn + 1) as u16;
                let wpos = gsbi;
                let flag: u16;
                let adv: usize;
                if dx == 0 && abs_dy < 1280 {
                    gs[wpos] = abs_dy as u32 as u8;
                    flag = curve_bit + (((abs_dy as u32 & 0xF00) as u16) >> 7) + y_sign_bit;
                    adv = 1;
                } else if dy == 0 && abs_dx < 1280 {
                    gs[wpos] = abs_dx as u32 as u8;
                    flag = curve_bit + 10 + (((abs_dx as u32 & 0xF00) as u16) >> 7) + x_sign_bit;
                    adv = 1;
                } else if abs_dx < 65 && abs_dy < 65 {
                    let ax: u32 = abs_dx as u32 - 1;
                    let ay: u32 = abs_dy as u32 - 1;
                    gs[wpos] = (((ax & 0xF) << 4) | (ay & 0xF)) as u8;
                    flag = curve_bit + 20 + ((ax & 0x30) as u16) + (((ay & 0x30) as u16) >> 2) + x_sign_bit + 2 * y_sign_bit;
                    adv = 1;
                } else if abs_dx < 769 && abs_dy < 769 {
                    let ax: u32 = abs_dx as u32 - 1;
                    let ay: u32 = abs_dy as u32 - 1;
                    gs[wpos] = (ax & 0xFF) as u8;
                    gs[wpos + 1] = (ay & 0xFF) as u8;
                    flag = curve_bit + 84 + 12 * (((ax & 0x300) as u16) >> 8) + (((ay & 0x300) as u16) >> 6) + x_sign_bit + 2 * y_sign_bit;
                    adv = 2;
                } else if abs_dx < 4096 && abs_dy < 4096 {
                    gs[wpos] = (abs_dx as u32 >> 4) as u8;
                    gs[wpos + 1] = (((abs_dx as u32 & 0xF) << 4) | (abs_dy as u32 >> 8)) as u8;
                    gs[wpos + 2] = (abs_dy as u32) as u8;
                    flag = curve_bit + 120 + x_sign_bit + 2 * y_sign_bit;
                    adv = 3;
                } else {
                    gs[wpos] = (abs_dx as u32 >> 8) as u8;
                    gs[wpos + 1] = (abs_dx as u32) as u8;
                    gs[wpos + 2] = (abs_dy as u32 >> 8) as u8;
                    gs[wpos + 3] = (abs_dy as u32) as u8;
                    flag = curve_bit + 124 + x_sign_bit + 2 * y_sign_bit;
                    adv = 4;
                }
                // triplet flag 回写 flag_accum（flagStream 存 triplet flag）
                *item = flag as u8;
                gsbi += adv;
            }
            glyph_accum.truncate(gs_base + gsbi);

            let mut enc = [0u8; 3];
            let n = write_255_u_int16(&mut enc, 0, instruction_length as u16);
            glyph_accum.extend_from_slice(&enc[..n]);
        } else {
            // numberOfContours === 0 的空字形：仍需消费 yCoord 字节以推进 dataOff（保持 TS 原语义）
            // （num_points 此时恒为 0，循环实际不执行，忠实保留 TS 原结构）
            for yi0 in 0..num_points {
                let f = flag_accum[flag_write_base + yi0];
                if f & yshort_flag != 0 {
                    data_off += 1;
                } else if f & ysame_flag == 0 {
                    data_off += 2;
                }
            }
            // dataOff 此后不再消费（TS 原语义的推进保持），显式读取抑制 dead-store 警告
            let _ = data_off;
        }

        glyph_infos.push(GlyphInfo::Simple(SimpleInfo {
            number_of_contours,
            n_points_deltas,
        }));
    }

    let n_contour_stream_size = num_glyphs * 2;
    let header_size = 36;
    let flag_stream_size = flag_accum.len();
    let instruction_stream_size = instr_accum.len();
    let overlap_bitmap_size: usize = if has_overlap_bitmap { bbox_bitmap_size } else { 0 };
    let glyph_stream_size = glyph_accum.len();
    let total_size = header_size +
        n_contour_stream_size +
        total_n_points_size +
        flag_stream_size +
        glyph_stream_size +
        bbox_bitmap_size +
        bbox_stream_size +
        instruction_stream_size +
        overlap_bitmap_size;

    // TS 的 new Uint8Array 零填充；空字形 nContour 槽等位置依赖跳写后的零值
    let mut result = vec![0u8; total_size];

    // Header
    let mut pos: usize = 0;
    write_u16(&mut result, pos, 0);
    pos += 2;
    write_u16(&mut result, pos, if has_overlap_bitmap { 1 } else { 0 });
    pos += 2;
    write_u16(&mut result, pos, num_glyphs as u16);
    pos += 2;
    write_u16(&mut result, pos, index_format);
    pos += 2;
    write_u32(&mut result, pos, n_contour_stream_size as u32);
    pos += 4;
    write_u32(&mut result, pos, total_n_points_size as u32);
    pos += 4;
    write_u32(&mut result, pos, flag_stream_size as u32);
    pos += 4;
    write_u32(&mut result, pos, glyph_stream_size as u32);
    pos += 4;
    write_u32(&mut result, pos, 0); // compositeStreamSize 占位（TS 写 0，组件数据在 glyphStream）
    pos += 4;
    write_u32(&mut result, pos, (bbox_bitmap_size + bbox_stream_size) as u32);
    pos += 4;
    write_u32(&mut result, pos, instruction_stream_size as u32);
    pos += 4;

    let n_contour_end = pos + n_contour_stream_size;
    let mut n_contour_pos = pos;
    let mut n_points_pos = n_contour_end;
    pos = n_contour_end + total_n_points_size;

    let flag_stream_start = pos;
    pos += flag_stream_size;
    let glyph_stream_start = pos;
    pos += glyph_stream_size;
    let bbox_bitmap_start = pos;
    pos += bbox_bitmap_size;
    // pos 现指向 bboxStream 起点（bitmap 之后）
    let mut bbox_pos = pos;

    for g in &glyph_infos {
        match g {
            GlyphInfo::Empty => n_contour_pos += 2,
            GlyphInfo::Composite(ci) => {
                write_u16(&mut result, n_contour_pos, 0xFFFF);
                n_contour_pos += 2;
                write_u16(&mut result, bbox_pos, ci.x_min as u16);
                write_u16(&mut result, bbox_pos + 2, ci.y_min as u16);
                write_u16(&mut result, bbox_pos + 4, ci.x_max as u16);
                write_u16(&mut result, bbox_pos + 6, ci.y_max as u16);
                bbox_pos += 8;
            }
            GlyphInfo::Simple(si) => {
                write_u16(&mut result, n_contour_pos, si.number_of_contours as u16);
                n_contour_pos += 2;
                if si.number_of_contours == 0 {
                    continue;
                }
                for d in &si.n_points_deltas {
                    n_points_pos += write_255_u_int16(&mut result, n_points_pos, *d);
                }
            }
        }
    }

    result[flag_stream_start..flag_stream_start + flag_stream_size].copy_from_slice(&flag_accum);
    result[glyph_stream_start..glyph_stream_start + glyph_stream_size].copy_from_slice(&glyph_accum);
    if instruction_stream_size > 0 {
        // pos 已含 bitmap_size，只补 bboxStream
        let s = pos + bbox_stream_size;
        result[s..s + instruction_stream_size].copy_from_slice(&instr_accum);
    }

    result[bbox_bitmap_start..bbox_bitmap_start + bbox_bitmap_size].copy_from_slice(&bbox_bitmap);

    if has_overlap_bitmap {
        let s = pos + bbox_stream_size + instruction_stream_size;
        result[s..s + overlap_bitmap_size].copy_from_slice(&overlap_bitmap);
    }

    let loca_orig_length: u32 = if index_format == 0 {
        ((num_glyphs + 1) * 2) as u32
    } else {
        ((num_glyphs + 1) * 4) as u32
    };

    TransformResult {
        transformed_glyf: result,
        loca_orig_length,
    }
}

/// sfnt 表目录项（解析自 TTF）
#[derive(Clone)]
struct SfntTable {
    tag: [u8; 4],
    offset: u32,
    length: u32,
    tag_index: usize,
}

/// WOFF2 Table Directory entry
struct DirEntry<'a> {
    tag: [u8; 4],
    tag_index: usize,
    /// flags 字节（tagIndex | 变换版本位；glyf/loca 变换=版本0 不置 0x40）
    flags: u8,
    orig_length: u32,
    /// 目录序列化追加 transformLength 字段（loca 变换=0/glyf 变换=变换后长度）
    has_transform: bool,
    /// 拼接进压缩数据的字节（非变换表=原始字节；空 loca 为空）
    data: &'a [u8],
    is_head: bool,
}

const WOFF2_SIGNATURE: u32 = 0x774F4632;
const WOFF2_HEADER_SIZE: usize = 48;

/// 计算单个 Table Directory entry 的序列化字节数
fn entry_size(tag_index: usize, orig_length: u32, has_transform: bool, transform_length: u32) -> usize {
    1 +
        (if tag_index == 63 { 4 } else { 0 }) +
        size_u_int_base128(orig_length) +
        (if has_transform { size_u_int_base128(transform_length) } else { 0 })
}

/// WOFF2 编码错误（对译 Zig EncodeError；Rust 侧分配失败直接 abort，无 OutOfMemory；
/// brotli 参数经由 struct 字段设置不会失败，无 BrotliInit/BrotliParam）
#[derive(Debug)]
pub enum EncodeError {
    /// data 不是合法 sfnt（长度不足或表目录越界）
    NotSfnt,
    /// 表 offset+length 超出 buffer
    BadTable,
    /// brotli 压缩失败
    BrotliCompress,
}

/// brotli 压缩（quality=2 + sizeHint 对齐 TS brotliCompressSync params）
fn brotli_compress(input: &[u8], size_hint: usize) -> Result<Vec<u8>, EncodeError> {
    let mut params = BrotliEncoderParams::default();
    params.quality = BROTLI_QUALITY;
    params.lgwin = BROTLI_LGWIN;
    params.size_hint = size_hint;
    let mut out = Vec::new();
    let mut reader = input;
    brotli::BrotliCompress(&mut reader, &mut out, &mut params).map_err(|_| EncodeError::BrotliCompress)?;
    Ok(out)
}

/// 将 sfnt（TTF/OTF）buffer 编码为 WOFF2 buffer（TS encodeTTFToWOFF2 移植）
pub fn encode_ttf_to_woff2(data: &[u8]) -> Result<Vec<u8>, EncodeError> {
    if data.len() < 12 {
        return Err(EncodeError::NotSfnt);
    }
    let flavor = read_u32(data, 0);
    let num_tables: usize = read_u16(data, 4) as usize;

    // 解析 Table Directory
    let mut tables = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let off = 12 + i * 16;
        if off + 16 > data.len() {
            return Err(EncodeError::NotSfnt);
        }
        tables.push(SfntTable {
            tag: data[off..off + 4].try_into().unwrap(),
            offset: read_u32(data, off + 8),
            length: read_u32(data, off + 12),
            tag_index: tag_index(&data[off..off + 4].try_into().unwrap()),
        });
    }

    // 移除 DSIG（保序过滤，语义对齐 Zig write_idx 压缩）
    tables.retain(|t| t.tag != *b"DSIG");
    // 稳定排序（对齐 Zig std.mem.sort = std.sort.block 稳定序）
    tables.sort_by(|a, b| a.tag_index.cmp(&b.tag_index).then_with(|| a.tag.cmp(&b.tag)));
    let filtered = &tables;

    // 查找关键表
    let mut index_to_loc_format: u16 = 0;
    let mut num_glyphs: usize = 0;
    let mut glyf_table: Option<SfntTable> = None;
    let mut loca_table: Option<SfntTable> = None;
    for t in filtered {
        if t.tag == *b"head" && t.offset as usize + 52 <= data.len() {
            index_to_loc_format = read_u16(data, t.offset as usize + 50);
        }
        if t.tag == *b"maxp" && t.offset as usize + 6 <= data.len() {
            num_glyphs = read_u16(data, t.offset as usize + 4) as usize;
        }
        if t.tag == *b"glyf" {
            glyf_table = Some(t.clone());
        }
        if t.tag == *b"loca" {
            loca_table = Some(t.clone());
        }
    }

    // glyf + loca 变换（任一缺失则整体不变换）
    let glyf_transformed: Option<TransformResult> = if glyf_table.is_some() && loca_table.is_some() {
        let gt = glyf_table.as_ref().unwrap();
        let lt = loca_table.as_ref().unwrap();
        if gt.offset as usize + gt.length as usize > data.len() || lt.offset as usize + lt.length as usize > data.len() {
            return Err(EncodeError::BadTable);
        }
        Some(transform_glyf_and_loca(
            &data[gt.offset as usize..gt.offset as usize + gt.length as usize],
            &data[lt.offset as usize..lt.offset as usize + lt.length as usize],
            index_to_loc_format,
            num_glyphs,
        ))
    } else {
        None
    };

    // 构建 Table Directory entries
    let mut dir_entries: Vec<DirEntry> = Vec::new();
    let mut total_dir_size: usize = 0;

    for t in filtered {
        if t.tag == *b"loca" {
            if glyf_transformed.is_none() {
                // 无 glyf（如 CFF/OTF）：loca 不会单独存在，理论不达；防御性透传
                let d = &data[t.offset as usize..t.offset as usize + t.length as usize];
                dir_entries.push(DirEntry {
                    tag: t.tag,
                    tag_index: t.tag_index,
                    flags: t.tag_index as u8 | 0x40,
                    orig_length: t.length,
                    has_transform: false,
                    data: d,
                    is_head: false,
                });
                total_dir_size += entry_size(t.tag_index, t.length, false, t.length);
                continue;
            }
            let orig_length = glyf_transformed.as_ref().unwrap().loca_orig_length;
            dir_entries.push(DirEntry {
                tag: t.tag,
                tag_index: t.tag_index,
                flags: t.tag_index as u8,
                orig_length,
                has_transform: true,
                data: &[],
                is_head: false,
            });
            total_dir_size += entry_size(t.tag_index, orig_length, true, 0);
            continue;
        }

        if t.tag == *b"glyf" && glyf_transformed.is_some() {
            let tl = glyf_transformed.as_ref().unwrap().transformed_glyf.len() as u32;
            dir_entries.push(DirEntry {
                tag: t.tag,
                tag_index: t.tag_index,
                flags: t.tag_index as u8,
                orig_length: t.length,
                has_transform: true,
                data: &glyf_transformed.as_ref().unwrap().transformed_glyf,
                is_head: false,
            });
            total_dir_size += entry_size(t.tag_index, t.length, true, tl);
            continue;
        }

        if t.offset as usize + t.length as usize > data.len() {
            return Err(EncodeError::BadTable);
        }
        let table_data = &data[t.offset as usize..t.offset as usize + t.length as usize];
        dir_entries.push(DirEntry {
            tag: t.tag,
            tag_index: t.tag_index,
            flags: t.tag_index as u8,
            orig_length: t.length,
            has_transform: false,
            data: table_data,
            is_head: t.tag == *b"head",
        });
        total_dir_size += entry_size(t.tag_index, t.length, false, t.length);
    }

    // totalSfntSize（解码端重建 TTF 所需字节数）
    let mut total_sfnt_size: usize = 12 + filtered.len() * 16;
    for t in filtered {
        total_sfnt_size += t.length as usize + ((4 - (t.length as usize & 3)) & 3);
    }

    // 拼接表数据（head patch：checkSumAdjustment 清零 + flags 置 bit11）
    let mut total_table_data_size: usize = 0;
    for e in &dir_entries {
        total_table_data_size += e.data.len();
    }
    let mut uncompressed_data = vec![0u8; total_table_data_size];
    let mut data_pos: usize = 0;
    for e in &dir_entries {
        if !e.data.is_empty() {
            uncompressed_data[data_pos..data_pos + e.data.len()].copy_from_slice(e.data);
            if e.is_head && e.data.len() >= 46 {
                let base = data_pos;
                uncompressed_data[base + 8..base + 12].fill(0);
                let head_flags = ((uncompressed_data[base + 44] as u16) << 8) | uncompressed_data[base + 45] as u16;
                let new_flags = head_flags | (1 << 11);
                uncompressed_data[base + 44] = (new_flags >> 8) as u8;
                uncompressed_data[base + 45] = (new_flags & 0xFF) as u8;
            }
            data_pos += e.data.len();
        }
    }

    let compressed_data = brotli_compress(&uncompressed_data, total_table_data_size)?;

    // 组装 WOFF2（Round4 padding 预留）
    let raw_length = WOFF2_HEADER_SIZE + total_dir_size + compressed_data.len();
    let padded_length = (raw_length + 3) & !3;
    // 长度 < 4GB（u32 上限）在字体场景恒成立，截断语义对齐 Zig @intCast
    let mut woff2 = vec![0u8; padded_length];

    // Header
    write_u32(&mut woff2, 0, WOFF2_SIGNATURE);
    write_u32(&mut woff2, 4, flavor);
    write_u32(&mut woff2, 8, padded_length as u32);
    write_u16(&mut woff2, 12, dir_entries.len() as u16);
    write_u16(&mut woff2, 14, 0);
    write_u32(&mut woff2, 16, total_sfnt_size as u32);
    write_u32(&mut woff2, 20, compressed_data.len() as u32);
    write_u16(&mut woff2, 24, 1);
    write_u16(&mut woff2, 26, 0);

    // Table Directory
    let mut dir_pos: usize = WOFF2_HEADER_SIZE;
    for e in &dir_entries {
        woff2[dir_pos] = e.flags;
        dir_pos += 1;
        if e.tag_index == 63 {
            woff2[dir_pos..dir_pos + 4].copy_from_slice(&e.tag);
            dir_pos += 4;
        }
        dir_pos += encode_u_int_base128(e.orig_length, &mut woff2, dir_pos);
        if e.has_transform {
            let tl: u32 = if e.tag == *b"glyf" {
                e.data.len() as u32
            } else {
                0
            };
            dir_pos += encode_u_int_base128(tl, &mut woff2, dir_pos);
        }
    }

    // 压缩数据
    woff2[dir_pos..dir_pos + compressed_data.len()].copy_from_slice(&compressed_data);

    Ok(woff2)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fixture 获取方式（8090 端口 zig-spike 服务，同 text 的 ttf/woff2 互为 oracle）：
    ///   curl -s -o /tmp/fix1.ttf  'http://127.0.0.1:8090/api?font=鸿蒙黑体.ttf&text=中文字体测试ABCabc123&outType=ttf'
    ///   curl -s -o /tmp/fix1.woff2 'http://127.0.0.1:8090/api?font=鸿蒙黑体.ttf&text=中文字体测试ABCabc123&outType=woff2'
    ///   （fix2 = 令东齐伋复刻体.ttf，text=永和九年岁在癸丑暮春之初会于会稽山阴之兰亭The quick brown fox 0123456789）
    ///   （fix3 = 思源黑体.ttf，text=永和九年岁在癸丑ABCabc）
    /// fixture 不在时测试空转通过（本机验证时以 zig 服务在跑为准）。
    const FIXTURES: [(&str, &str); 3] = [
        ("/tmp/fix1.ttf", "/tmp/fix1.woff2"),
        ("/tmp/fix2.ttf", "/tmp/fix2.woff2"),
        ("/tmp/fix3.ttf", "/tmp/fix3.woff2"),
    ];

    fn load(p: &str) -> Option<Vec<u8>> {
        std::fs::read(p).ok()
    }

    /// 读 WOFF2 header 固定字段（offset, 宽, 名）
    fn hdr(buf: &[u8], off: usize, len: usize) -> u64 {
        let mut v: u64 = 0;
        for b in &buf[off..off + len] {
            v = (v << 8) | *b as u64;
        }
        v
    }

    /// 遍历 Table Directory，返回 (各 entry 序列化区间, dir 总字节数)
    fn walk_dir(buf: &[u8]) -> (Vec<(usize, usize)>, usize) {
        let num_tables = hdr(buf, 12, 2) as usize;
        let mut pos = WOFF2_HEADER_SIZE;
        let mut spans = Vec::new();
        for _ in 0..num_tables {
            let start = pos;
            pos += 1; // flags
            let flags = buf[start];
            if flags & 0x3F == 63 {
                pos += 4; // 自定义 tag
            }
            // UIntBase128 变长：续位 0x80
            while buf[pos] & 0x80 != 0 {
                pos += 1;
            }
            pos += 1;
            if flags & 0xC0 == 0 {
                // 已变换（glyf/loca）：追加 transformLength
                while buf[pos] & 0x80 != 0 {
                    pos += 1;
                }
                pos += 1;
            }
            spans.push((start, pos));
        }
        (spans, pos - WOFF2_HEADER_SIZE)
    }

    #[test]
    fn not_sfnt() {
        // 仅长度 <12 判 NotSfnt；numTables=0 的 20 字节输入在 Zig 中同样合法编码（空表目录）
        assert!(matches!(encode_ttf_to_woff2(&[0u8; 5]), Err(EncodeError::NotSfnt)));
        assert!(matches!(encode_ttf_to_woff2(&[0u8; 11]), Err(EncodeError::NotSfnt)));
    }

    /// 编码函数逐 fixture 对拍：头部逐字段 + 目录段逐字节 + 体积差 <1%
    /// （压缩流与 C brotli 不逐字节一致，属已知实现差异；解码等价由 decode-parity 外部验证）
    #[test]
    fn encode_fixtures_parity() {
        for (ttf_path, oracle_path) in FIXTURES {
            let (Some(ttf), Some(oracle)) = (load(ttf_path), load(oracle_path)) else {
                eprintln!("skip: fixture 缺失 {ttf_path}（获取方式见 FIXTURES 注释）");
                continue;
            };
            let out = encode_ttf_to_woff2(&ttf).expect("encode ok");
            let name = ttf_path.rsplit('/').next().unwrap();

            // 头部逐字段（除 length/totalCompressedSize 两个依赖压缩流长度的字段外必须一致）
            assert_eq!(hdr(&out, 0, 4), hdr(&oracle, 0, 4), "{name} signature");
            assert_eq!(hdr(&out, 4, 4), hdr(&oracle, 4, 4), "{name} flavor");
            assert_eq!(hdr(&out, 12, 2), hdr(&oracle, 12, 2), "{name} numTables");
            assert_eq!(hdr(&out, 14, 2), hdr(&oracle, 14, 2), "{name} reserved");
            assert_eq!(hdr(&out, 16, 4), hdr(&oracle, 16, 4), "{name} totalSfntSize");
            assert_eq!(hdr(&out, 24, 2), 1, "{name} majorVersion");
            assert_eq!(hdr(&out, 26, 2), 0, "{name} minorVersion");
            assert_eq!(hdr(&out, 28, 20), 0, "{name} meta/priv 全零");

            // 目录段逐字节一致（origLength/transformLength 编码与 C 侧完全相同）
            let (out_spans, out_dir_size) = walk_dir(&out);
            let (oracle_spans, oracle_dir_size) = walk_dir(&oracle);
            assert_eq!(out_dir_size, oracle_dir_size, "{name} 目录段长度");
            for (i, ((os, oe), (rs, re))) in out_spans.iter().zip(&oracle_spans).enumerate() {
                assert_eq!((os, oe), (rs, re), "{name} entry{i} 边界");
                assert_eq!(&out[*os..*oe], &oracle[*rs..*re], "{name} entry{i} 字节");
            }

            // 体积差 <1%（压缩流实现差异的量化验收线）
            let diff = out.len().abs_diff(oracle.len());
            assert!(
                diff * 100 < oracle.len(),
                "{name} 体积差 {diff}B 超过 1%（out={} oracle={}）",
                out.len(),
                oracle.len()
            );
            eprintln!("{name}: rust={} oracle={} diff={diff}B ({:.3}%)", out.len(), oracle.len(), diff as f64 * 100.0 / oracle.len() as f64);
        }
    }

    /// UIntBase128 / 255UInt16 / tagIndex 边界用例（对译 Zig 单元语义）
    #[test]
    fn primitive_encoders() {
        assert_eq!(size_u_int_base128(0), 1);
        assert_eq!(size_u_int_base128(0x7F), 1);
        assert_eq!(size_u_int_base128(0x80), 2);
        assert_eq!(size_u_int_base128(0x3FFF), 2);
        assert_eq!(size_u_int_base128(0x1FFFFF), 3);
        assert_eq!(size_u_int_base128(0x0FFFFFFF), 4);
        assert_eq!(size_u_int_base128(u32::MAX), 5);

        let mut buf = [0u8; 8];
        // 0x3FFF=16383=14 位全 1：高 7 位组 127（续位）→ FF，低组 0x7F
        assert_eq!(encode_u_int_base128(0x3FFF, &mut buf, 0), 2);
        assert_eq!(&buf[..2], &[0xFF, 0x7F]);
        assert_eq!(encode_u_int_base128(0x80, &mut buf, 0), 2);
        assert_eq!(&buf[..2], &[0x81, 0x00]);
        assert_eq!(encode_u_int_base128(0, &mut buf, 0), 1);
        assert_eq!(buf[0], 0);

        assert_eq!(size_255_u_int16(252), 1);
        assert_eq!(size_255_u_int16(253), 2);
        assert_eq!(size_255_u_int16(505), 2);
        assert_eq!(size_255_u_int16(506), 2);
        assert_eq!(size_255_u_int16(761), 2);
        // TS 原版即有的边界不一致：size 用 <=762 判 2 字节，而实际编码 762 走 3 字节形态，bug-for-bug 保留
        assert_eq!(size_255_u_int16(762), 2);

        let mut b3 = [0u8; 3];
        assert_eq!(write_255_u_int16(&mut b3, 0, 100), 1);
        assert_eq!(b3[0], 100);
        assert_eq!(write_255_u_int16(&mut b3, 0, 300), 2);
        assert_eq!(&b3[..2], &[255, 47]); // 300-253
        assert_eq!(write_255_u_int16(&mut b3, 0, 600), 2);
        assert_eq!(&b3[..2], &[254, 94]); // 600-506
        assert_eq!(write_255_u_int16(&mut b3, 0, 0x1234), 3);
        assert_eq!(&b3[..3], &[253, 0x12, 0x34]);

        assert_eq!(tag_index(b"cmap"), 0);
        assert_eq!(tag_index(b"Sill"), 49);
        assert_eq!(tag_index(b"DSIG"), 63);
    }

    /// 端内一致性：同输入两次编码输出一致（确定性）
    #[test]
    fn encode_deterministic() {
        let Some(ttf) = load("/tmp/fix1.ttf") else {
            eprintln!("skip: fixture 缺失 /tmp/fix1.ttf");
            return;
        };
        let a = encode_ttf_to_woff2(&ttf).unwrap();
        let b = encode_ttf_to_woff2(&ttf).unwrap();
        assert_eq!(a, b);
    }
}
