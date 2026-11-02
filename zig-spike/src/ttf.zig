//! TTF 解析与子集化（零依赖，Zig 0.17 API）
const std = @import("std");

pub const SubsetError = error{
    NotTtf,
    BadTable,
    NoCmap,
    NoGlyphs,
    OutOfMemory,
};

/// sfnt 表目录条目
const TableDir = struct {
    tag: [4]u8,
    checksum: u32,
    offset: u32,
    length: u32,
};

/// 字节构建器（0.17 ArrayList 是 unmanaged 的，包一层方便写大端）
const ByteList = struct {
    list: std.ArrayList(u8) = .empty,
    alloc: std.mem.Allocator,

    fn deinit(self: *ByteList) void {
        self.list.deinit(self.alloc);
    }

    fn bytes(self: *const ByteList) []const u8 {
        return self.list.items;
    }

    fn append(self: *ByteList, b: u8) SubsetError!void {
        try self.list.append(self.alloc, b);
    }

    fn appendSlice(self: *ByteList, s: []const u8) SubsetError!void {
        try self.list.appendSlice(self.alloc, s);
    }

    fn writeInt(self: *ByteList, comptime T: type, v: T) SubsetError!void {
        var buf: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &buf, v, .big);
        try self.appendSlice(&buf);
    }

    fn pad4(self: *ByteList) SubsetError!void {
        while (self.list.items.len % 4 != 0) try self.append(0);
    }

    fn owned(self: *ByteList) SubsetError![]u8 {
        return self.list.toOwnedSlice(self.alloc);
    }
};

pub const Font = struct {
    data: []const u8,
    tables: []TableDir,
    num_glyphs: u16,
    units_per_em: u16,
    index_to_loc_format: u16,
    cmap: std.AutoHashMap(u32, u16),

    pub fn parse(alloc: std.mem.Allocator, data: []const u8) SubsetError!Font {
        if (data.len < 12) return error.NotTtf;
        if (std.mem.readInt(u32, data[0..4], .big) != 0x00010000 and
            std.mem.readInt(u32, data[0..4], .big) != 0x74727565) return error.NotTtf;
        const num_tables = std.mem.readInt(u16, data[4..6], .big);
        if (data.len < 12 + @as(usize, num_tables) * 16) return error.BadTable;
        const tables = try alloc.alloc(TableDir, num_tables);
        var i: usize = 0;
        while (i < num_tables) : (i += 1) {
            const off = 12 + i * 16;
            tables[i] = .{
                .tag = data[off..][0..4].*,
                .checksum = std.mem.readInt(u32, data[off + 4 ..][0..4], .big),
                .offset = std.mem.readInt(u32, data[off + 8 ..][0..4], .big),
                .length = std.mem.readInt(u32, data[off + 12 ..][0..4], .big),
            };
        }
        var f = Font{
            .data = data,
            .tables = tables,
            .num_glyphs = 0,
            .units_per_em = 1000,
            .index_to_loc_format = 0,
            .cmap = std.AutoHashMap(u32, u16).init(alloc),
        };
        f.num_glyphs = f.readMaxpGlyphs();
        f.index_to_loc_format = f.readHeadLocFormat();
        f.units_per_em = f.readHeadUpem();
        try f.parseCmap();
        return f;
    }

    fn findTable(self: *const Font, comptime tag: *const [4]u8) ?[]const u8 {
        for (self.tables) |t| {
            if (std.mem.eql(u8, &t.tag, tag)) {
                const end = t.offset + t.length;
                if (end <= self.data.len) return self.data[t.offset..end];
            }
        }
        return null;
    }

    fn readMaxpGlyphs(self: *const Font) u16 {
        const maxp = self.findTable("maxp") orelse return 0;
        if (maxp.len < 6) return 0;
        return std.mem.readInt(u16, maxp[4..6], .big);
    }

    fn readHeadUpem(self: *const Font) u16 {
        const head = self.findTable("head") orelse return 1000;
        if (head.len < 18) return 1000;
        return std.mem.readInt(u16, head[18..20], .big);
    }

    fn readHeadLocFormat(self: *const Font) u16 {
        const head = self.findTable("head") orelse return 0;
        if (head.len < 52) return 0;
        return std.mem.readInt(u16, head[50..52], .big);
    }

    fn parseCmap(self: *Font) SubsetError!void {
        const cmap = self.findTable("cmap") orelse return error.NoCmap;
        if (cmap.len < 4) return error.NoCmap;
        const num_sub = std.mem.readInt(u16, cmap[2..4], .big);
        var i: usize = 0;
        while (i < num_sub) : (i += 1) {
            const rec = cmap[4 + i * 8 ..];
            if (rec.len < 8) break;
            const platform = std.mem.readInt(u16, rec[0..2], .big);
            const encoding = std.mem.readInt(u16, rec[2..4], .big);
            const offset = std.mem.readInt(u32, rec[4..8], .big);
            const is_unicode = (platform == 3 and (encoding == 1 or encoding == 10)) or platform == 0;
            if (!is_unicode or offset >= cmap.len) continue;
            const sub = cmap[offset..];
            if (sub.len < 2) continue;
            const format = std.mem.readInt(u16, sub[0..2], .big);
            switch (format) {
                4 => try self.parseCmap4(sub),
                12 => try self.parseCmap12(sub),
                else => {},
            }
        }
        if (self.cmap.count() == 0) return error.NoCmap;
    }

    fn parseCmap4(self: *Font, sub: []const u8) SubsetError!void {
        if (sub.len < 14) return;
        const seg_count = std.mem.readInt(u16, sub[6..8], .big) / 2;
        const seg_end_off = 14;
        const seg_start_off = seg_end_off + @as(usize, seg_count) * 2 + 2;
        const delta_off = seg_start_off + @as(usize, seg_count) * 2;
        const range_off = delta_off + @as(usize, seg_count) * 2;
        if (sub.len < range_off + @as(usize, seg_count) * 2) return;
        var seg: usize = 0;
        while (seg < seg_count) : (seg += 1) {
            const end_cp = std.mem.readInt(u16, sub[seg_end_off + seg * 2 ..][0..2], .big);
            const start_cp = std.mem.readInt(u16, sub[seg_start_off + seg * 2 ..][0..2], .big);
            const delta = std.mem.readInt(u16, sub[delta_off + seg * 2 ..][0..2], .big);
            const ro = std.mem.readInt(u16, sub[range_off + seg * 2 ..][0..2], .big);
            var cp: u32 = start_cp;
            while (cp <= end_cp) : (cp += 1) {
                var gid: u16 = undefined;
                if (ro % 2 == 1) continue; // 罕见奇数 idRangeOffset，跳过
                if (ro == 0) {
                    gid = @truncate(@as(u32, cp) +% delta);
                } else {
                    const gid_off = range_off + seg * 2 + ro + (cp - start_cp) * 2;
                    if (gid_off + 2 > sub.len) {
                        if (cp == 0xFFFF) break;
                        continue;
                    }
                    const g = std.mem.readInt(u16, sub[gid_off..][0..2], .big);
                    if (g == 0) {
                        if (cp == 0xFFFF) break;
                        continue;
                    }
                    gid = @truncate(@as(u32, g) +% delta);
                }
                if (gid != 0 and gid < self.num_glyphs) {
                    try self.cmap.put(cp, gid);
                }
                if (cp == 0xFFFF) break;
            }
        }
    }

    fn parseCmap12(self: *Font, sub: []const u8) SubsetError!void {
        if (sub.len < 16) return;
        const num_groups = std.mem.readInt(u32, sub[12..16], .big);
        var g: usize = 0;
        while (g < num_groups) : (g += 1) {
            const rec = sub[16 + g * 12 ..];
            if (rec.len < 12) break;
            const start_cp = std.mem.readInt(u32, rec[0..4], .big);
            const end_cp = std.mem.readInt(u32, rec[4..8], .big);
            const start_gid = std.mem.readInt(u32, rec[8..12], .big);
            var cp = start_cp;
            while (cp <= end_cp) : (cp += 1) {
                const gid = start_gid + (cp - start_cp);
                if (gid < self.num_glyphs) try self.cmap.put(cp, @truncate(gid));
                if (cp == 0x10FFFF) break;
            }
        }
    }

    /// gid 的 loca 原始区间（无则是空字形）
    fn locaRange(self: *const Font, gid: u16) ?struct { start: u32, end: u32 } {
        const loca = self.findTable("loca") orelse return null;
        if (self.index_to_loc_format == 0) {
            if (loca.len < (@as(usize, gid) + 2) * 2) return null;
            const start = @as(u32, std.mem.readInt(u16, loca[gid * 2 ..][0..2], .big)) * 2;
            const end = @as(u32, std.mem.readInt(u16, loca[(gid + 1) * 2 ..][0..2], .big)) * 2;
            return .{ .start = start, .end = end };
        }
        if (loca.len < (@as(usize, gid) + 2) * 4) return null;
        return .{
            .start = std.mem.readInt(u32, loca[gid * 4 ..][0..4], .big),
            .end = std.mem.readInt(u32, loca[(gid + 1) * 4 ..][0..4], .big),
        };
    }

    /// 复合字形递归收集引用分量（防环）
    fn collectComponents(self: *const Font, gid: u16, glyf: []const u8, out: *std.ArrayList(u16), alloc: std.mem.Allocator) SubsetError!void {
        const range = self.locaRange(gid) orelse return;
        if (range.end <= range.start or range.end > glyf.len) return;
        const gdata = glyf[range.start..range.end];
        if (gdata.len < 2) return;
        const nc = std.mem.readInt(i16, gdata[0..2], .big);
        if (nc >= 0 or gdata.len < 10) return;
        var off: usize = 10;
        while (off + 4 <= gdata.len) {
            const flags_raw = std.mem.readInt(u16, gdata[off..][0..2], .big);
            const comp_gid = std.mem.readInt(u16, gdata[off + 2 ..][0..2], .big);
            var dup = false;
            for (out.items) |x| {
                if (x == comp_gid) dup = true;
            }
            if (!dup and comp_gid != gid and comp_gid < self.num_glyphs) {
                try out.append(alloc, comp_gid);
                try self.collectComponents(comp_gid, glyf, out, alloc);
            }
            off += 4;
            if (flags_raw & 0x0001 != 0) off += 4 else off += 2; // ARG_1_AND_2_ARE_WORDS
            if (flags_raw & 0x0008 != 0) off += 2; // WE_HAVE_A_SCALE
            if (flags_raw & 0x0040 != 0) off += 4; // WE_HAVE_AN_X_AND_Y_SCALE
            if (flags_raw & 0x0080 != 0) off += 8; // WE_HAVE_A_TWO_BY_TWO
            if (flags_raw & 0x0020 == 0) break; // MORE_COMPONENTS
        }
    }

    /// 文本涉及的 gid 集（gid 0 始终保留，升序）
    pub fn collectGids(self: *const Font, alloc: std.mem.Allocator, text: []const u8) SubsetError!std.ArrayList(u16) {
        var gids: std.ArrayList(u16) = .empty;
        errdefer gids.deinit(alloc);
        try gids.append(alloc, 0);
        const glyf = self.findTable("glyf");
        var i: usize = 0;
        while (i < text.len) {
            const n = std.unicode.utf8ByteSequenceLength(text[i]) catch {
                i += 1;
                continue;
            };
            if (i + n > text.len) break;
            const cp = std.unicode.utf8Decode(text[i..][0..n]) catch {
                i += n;
                continue;
            };
            i += n;
            if (self.cmap.get(cp)) |gid| {
                var dup = false;
                for (gids.items) |g| {
                    if (g == gid) dup = true;
                }
                if (!dup) try gids.append(alloc, gid);
                if (glyf) |g| {
                    var tmp: std.ArrayList(u16) = .empty;
                    defer tmp.deinit(alloc);
                    try self.collectComponents(gid, g, &tmp, alloc);
                    for (tmp.items) |cg| {
                        var d2 = false;
                        for (gids.items) |x| {
                            if (x == cg) d2 = true;
                        }
                        if (!d2) try gids.append(alloc, cg);
                    }
                }
            }
        }
        if (gids.items.len <= 1) return error.NoGlyphs;
        std.mem.sort(u16, gids.items, {}, std.sort.asc(u16));
        return gids;
    }
};

pub const SubsetResult = struct {
    bytes: []u8,
};

/// 码点→新 gid 对
const CpPair = struct { cp: u32, gid: u16 };

/// 简单可靠子集化：重写 glyf/loca/cmap/maxp，其余表原样透传（head 强制 short loca）
pub fn subset(alloc: std.mem.Allocator, data: []const u8, text: []const u8) SubsetError!SubsetResult {
    var font = try Font.parse(alloc, data);
    defer font.cmap.deinit();
    var gids = try font.collectGids(alloc, text);
    defer gids.deinit(alloc);

    const keep = gids.items;
    var gid_map = std.AutoHashMap(u16, u16).init(alloc);
    defer gid_map.deinit();
    for (keep, 0..) |old, new| try gid_map.put(old, @intCast(new));

    const glyf = font.findTable("glyf") orelse return error.BadTable;
    var new_glyf = ByteList{ .alloc = alloc };
    defer new_glyf.deinit();
    var new_loca: std.ArrayList(u32) = .empty;
    defer new_loca.deinit(alloc);

    // 码点→新gid，按码点排序
    var cp_pairs: std.ArrayList(CpPair) = .empty;
    defer cp_pairs.deinit(alloc);
    var it = font.cmap.iterator();
    while (it.next()) |e| {
        if (gid_map.get(e.value_ptr.*)) |new_gid| {
            try cp_pairs.append(alloc, .{ .cp = e.key_ptr.*, .gid = new_gid });
        }
    }
    std.mem.sort(CpPair, cp_pairs.items, {}, struct {
        fn f(_: void, a: CpPair, b: CpPair) bool {
            return a.cp < b.cp;
        }
    }.f);

    // 新 glyf + loca（loca 单位 = 2字节，short 格式）
    for (keep) |old_gid| {
        try new_loca.append(alloc, @intCast(new_glyf.bytes().len / 2));
        const range = font.locaRange(old_gid) orelse continue;
        if (range.end > range.start and range.end <= glyf.len) {
            const gdata = glyf[range.start..range.end];
            const nc = if (gdata.len >= 2) std.mem.readInt(i16, gdata[0..2], .big) else 0;
            if (nc < 0) {
                try appendCompositeGlyph(&new_glyf, gdata, &gid_map);
            } else {
                try new_glyf.appendSlice(gdata);
            }
            try new_glyf.pad4();
        }
    }
    try new_loca.append(alloc, @intCast(new_glyf.bytes().len / 2));
    if (new_glyf.bytes().len == 0) return error.NoGlyphs;

    // cmap 子表字节（format 4）
    var cmap_bytes = ByteList{ .alloc = alloc };
    defer cmap_bytes.deinit();
    try writeCmap4(&cmap_bytes, cp_pairs.items, alloc);

    // ===== 输出 sfnt =====
    const OutTable = struct {
        tag: [4]u8,
        checksum: u32,
        src: []const u8, // 透传表原始数据；重写表为空
    };
    var all_tables: std.ArrayList(OutTable) = .empty;
    defer all_tables.deinit(alloc);
    const rewritten = [_][]const u8{ "glyf", "loca", "cmap", "maxp", "post", "hmtx" };
    for (font.tables) |t| {
        var is_rewrite = false;
        for (rewritten) |r| {
            if (std.mem.eql(u8, &t.tag, r)) is_rewrite = true;
        }
        if (!is_rewrite) {
            try all_tables.append(alloc, .{ .tag = t.tag, .checksum = t.checksum, .src = font.data[t.offset .. t.offset + t.length] });
        }
    }
    try all_tables.append(alloc, .{ .tag = .{ 'c', 'm', 'a', 'p' }, .checksum = 0, .src = cmap_bytes.bytes() });
    try all_tables.append(alloc, .{ .tag = .{ 'g', 'l', 'y', 'f' }, .checksum = 0, .src = new_glyf.bytes() });
    try all_tables.append(alloc, .{ .tag = .{ 'l', 'o', 'c', 'a' }, .checksum = 0, .src = &.{} });
    try all_tables.append(alloc, .{ .tag = .{ 'm', 'a', 'x', 'p' }, .checksum = 0, .src = &.{} });
    try all_tables.append(alloc, .{ .tag = .{ 'p', 'o', 's', 't' }, .checksum = 0, .src = &.{} });
    // hmtx 按保留字形裁剪（前 numberOfHMetrics 个是 advance+lsb，其余仅 lsb）
    var new_hmtx = ByteList{ .alloc = alloc };
    defer new_hmtx.deinit();
    if (font.findTable("hmtx")) |hmtx| {
        const hhea = font.findTable("hhea") orelse &[_]u8{};
        const nhm: u32 = if (hhea.len >= 36) std.mem.readInt(u16, hhea[34..36], .big) else 0;
        for (keep) |old_gid| {
            if (old_gid < nhm) {
                const o = @as(usize, old_gid) * 4;
                if (o + 4 <= hmtx.len) try new_hmtx.appendSlice(hmtx[o .. o + 4]);
            } else {
                const o = @as(usize, nhm) * 4 + (@as(usize, old_gid) - nhm) * 2;
                if (o + 2 <= hmtx.len) try new_hmtx.appendSlice(hmtx[o .. o + 2]);
            }
        }
    }
    try all_tables.append(alloc, .{ .tag = .{ 'h', 'm', 't', 'x' }, .checksum = 0, .src = new_hmtx.bytes() });
    std.mem.sort(OutTable, all_tables.items, {}, struct {
        fn f(_: void, a: OutTable, b: OutTable) bool {
            return std.mem.lessThan(u8, &a.tag, &b.tag);
        }
    }.f);

    const num_new: u16 = @intCast(keep.len);
    var out = ByteList{ .alloc = alloc };
    errdefer out.deinit();

    // header
    const total_tables = all_tables.items.len;
    try out.writeInt(u32, 0x00010000);
    try out.writeInt(u16, @intCast(total_tables));
    var sr: u32 = 16;
    var es: u16 = 0;
    while (sr * 2 <= total_tables * 16) : (sr *= 2) es += 1;
    try out.writeInt(u16, @intCast(sr));
    try out.writeInt(u16, es);
    try out.writeInt(u16, @intCast(total_tables * 16 - sr));

    // 计算表体偏移
    const offsets = try alloc.alloc(u32, total_tables);
    defer alloc.free(offsets);
    const lengths = try alloc.alloc(u32, total_tables);
    defer alloc.free(lengths);
    var body_off: u32 = @intCast(12 + total_tables * 16);
    for (all_tables.items, 0..) |t, i| {
        var len: u32 = @intCast(t.src.len);
        if (std.mem.eql(u8, &t.tag, "loca")) len = @intCast(new_loca.items.len * 2); // short loca
        if (std.mem.eql(u8, &t.tag, "maxp")) len = 32;
        if (std.mem.eql(u8, &t.tag, "post")) len = 32; // format 3
        offsets[i] = body_off;
        lengths[i] = len;
        body_off = (body_off + len + 3) & ~@as(u32, 3);
    }

    // 目录条目
    for (all_tables.items, 0..) |t, i| {
        try out.appendSlice(&t.tag);
        try out.writeInt(u32, t.checksum);
        try out.writeInt(u32, offsets[i]);
        try out.writeInt(u32, lengths[i]);
    }

    // 表体
    for (all_tables.items, 0..) |t, i| {
        while (out.bytes().len < offsets[i]) try out.append(0);
        if (std.mem.eql(u8, &t.tag, "loca")) {
            for (new_loca.items) |v| try out.writeInt(u16, @intCast(v));
        } else if (std.mem.eql(u8, &t.tag, "maxp")) {
            // maxp v1.0：version + numGlyphs，其余字段 0（fontTools 校验 v1.0 = 32 字节）
            try out.writeInt(u32, 0x00010000);
            try out.writeInt(u16, num_new);
            var z: usize = 6;
            while (z < 32) : (z += 1) try out.append(0);
        } else if (std.mem.eql(u8, &t.tag, "post")) {
            // post format 3（无字形名），全部填 0 除 version
            try out.writeInt(u32, 0x00030000);
            var z: usize = 4;
            while (z < 32) : (z += 1) try out.append(0);
        } else {
            try out.appendSlice(t.src);
            if (std.mem.eql(u8, &t.tag, "head")) {
                // 强制 indexToLocFormat=0、glyphDataFormat=0（head 尾部 4 字节）
                const mutable = @constCast(out.bytes());
                std.mem.writeInt(u16, mutable[mutable.len - 4 ..][0..2], 0, .big);
                std.mem.writeInt(u16, mutable[mutable.len - 2 ..][0..2], 0, .big);
            }
        }
        try out.pad4();
    }
    return .{ .bytes = try out.owned() };
}

/// 复合字形复制并重映射分量 gid
fn appendCompositeGlyph(out: *ByteList, gdata: []const u8, gid_map: *std.AutoHashMap(u16, u16)) SubsetError!void {
    try out.appendSlice(gdata[0..10]);
    var off: usize = 10;
    var more = true;
    while (more and off + 4 <= gdata.len) {
        const flags_raw = std.mem.readInt(u16, gdata[off..][0..2], .big);
        const comp_gid = std.mem.readInt(u16, gdata[off + 2 ..][0..2], .big);
        const new_gid = gid_map.get(comp_gid) orelse 0;
        var extra: usize = 0;
        if (flags_raw & 0x0008 != 0) extra = 2;
        if (flags_raw & 0x0040 != 0) extra = 4;
        if (flags_raw & 0x0080 != 0) extra = 8;
        const arg_len: usize = if (flags_raw & 0x0001 != 0) 4 else 2;
        const seg_end = off + 4 + arg_len + extra;
        if (seg_end > gdata.len) break;
        try out.writeInt(u16, flags_raw);
        try out.writeInt(u16, new_gid);
        try out.appendSlice(gdata[off + 4 .. seg_end]);
        more = flags_raw & 0x0020 != 0;
        off = seg_end;
    }
}

/// cmap（format 4，平台 3/1），段内 gid 线性（idRangeOffset=0）
fn writeCmap4(out: *ByteList, pairs: []const CpPair, alloc: std.mem.Allocator) SubsetError!void {
    const Seg = struct { start: u32, end: u32, start_gid: u16 };
    var segs: std.ArrayList(Seg) = .empty;
    defer segs.deinit(alloc);
    for (pairs) |p| {
        if (segs.items.len > 0) {
            const last = &segs.items[segs.items.len - 1];
            if (p.cp == last.end + 1 and p.gid == last.start_gid +% @as(u16, @intCast(p.cp - last.start))) {
                last.end = p.cp;
                continue;
            }
        }
        try segs.append(alloc, .{ .start = p.cp, .end = p.cp, .start_gid = p.gid });
    }
    if (segs.items.len == 0) return error.NoGlyphs;
    if (segs.items[segs.items.len - 1].end != 0xFFFF) {
        try segs.append(alloc, .{ .start = 0xFFFF, .end = 0xFFFF, .start_gid = 0 });
    }
    const n = segs.items.len;
    const sub_len: u16 = @intCast(16 + n * 8);
    // cmap header + 子表记录
    try out.writeInt(u16, 0);
    try out.writeInt(u16, 1);
    try out.writeInt(u16, 3);
    try out.writeInt(u16, 1);
    try out.writeInt(u32, 12);
    // format 4
    var sr: u16 = 2;
    var es: u16 = 0;
    while (sr * 2 <= n * 2) : (sr *= 2) es += 1;
    try out.writeInt(u16, 4);
    try out.writeInt(u16, sub_len);
    try out.writeInt(u16, 0); // language
    try out.writeInt(u16, @intCast(n * 2)); // segCountX2
    try out.writeInt(u16, sr);
    try out.writeInt(u16, es);
    try out.writeInt(u16, @intCast(n * 2 - sr));
    for (segs.items) |s| try out.writeInt(u16, @intCast(s.end));
    try out.writeInt(u16, 0); // reservedPad
    for (segs.items) |s| try out.writeInt(u16, @intCast(s.start));
    for (segs.items) |s| try out.writeInt(u16, s.start_gid -% @as(u16, @intCast(s.start)));
    for (segs.items) |_| try out.writeInt(u16, 0); // idRangeOffset=0
}
