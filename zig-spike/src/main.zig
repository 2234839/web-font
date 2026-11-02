//! webfont-zig spike：HTTP 服务 + TTF 子集化（Zig 0.17 Io API）
//! 用法：PORT=8090 FONT_DIR=../font ./webfont-zig
const std = @import("std");
const ttf = @import("ttf.zig");

/// 字体字节缓存（spike：进程级，永不失效；正式版应加 LRU+容量上限）
var font_cache: std.StringHashMap([]const u8) = undefined;
var cache_gpa: std.mem.Allocator = undefined;

pub fn main(init: std.process.Init) !void {
    const alloc = init.gpa;
    cache_gpa = alloc;
    font_cache = std.StringHashMap([]const u8).init(alloc);
    const io = init.io;
    const port = blk: {
        if (init.environ_map.get("PORT")) |p| break :blk std.fmt.parseInt(u16, p, 10) catch 8090;
        break :blk 8090;
    };
    const font_dir: []const u8 = init.environ_map.get("FONT_DIR") orelse "../font";

    const addr = try std.Io.net.IpAddress.parseIp4("0.0.0.0", port);
    var server = try std.Io.net.IpAddress.listen(&addr, io, .{ .reuse_address = true });
    defer server.deinit(io);
    std.debug.print("webfont-zig listening on {d}\n", .{port});

    while (true) {
        const stream = server.accept(io) catch continue;
        handleConn(alloc, io, stream, font_dir) catch {};
    }
}

fn handleConn(alloc: std.mem.Allocator, io: std.Io, stream: std.Io.net.Stream, font_dir: []const u8) !void {
    defer stream.close(io);
    var buf: [8192]u8 = undefined;
    var rbuf = [1][]u8{&buf};
    const rres = (io.operate(.{ .net_read = .{
        .socket_handle = stream.socket.handle,
        .data = &rbuf,
    } }) catch return).net_read catch return;
    const n = rres.data_len;
    if (n == 0) return;
    const req = buf[0..n];
    // 只解析 request line：GET /api?font=..&text=..&outType=ttf
    const line_end = std.mem.indexOf(u8, req, "\r\n") orelse return;
    const line = req[0..line_end];
    if (!std.mem.startsWith(u8, line, "GET /api?")) {
        try sendText(io, stream, 404, "not found");
        return;
    }
    const q = line["GET /api?".len..];
    const q_end = std.mem.indexOfScalar(u8, q, ' ') orelse q.len;
    const query = q[0..q_end];

    var font_name: ?[]const u8 = null;
    var text: ?[]const u8 = null;
    var it = std.mem.splitScalar(u8, query, '&');
    while (it.next()) |kv| {
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        const k = kv[0..eq];
        const v = kv[eq + 1 ..];
        if (std.mem.eql(u8, k, "font")) {
            font_name = try urlDecode(alloc, v);
        } else if (std.mem.eql(u8, k, "text")) {
            text = try urlDecode(alloc, v);
        }
    }
    if (font_name == null or text == null or text.?.len == 0) {
        try sendText(io, stream, 400, "font & text required");
        return;
    }
    // 路径穿越防护
    if (std.mem.indexOf(u8, font_name.?, "..") != null) {
        try sendText(io, stream, 400, "bad font");
        return;
    }
    const font_path = try std.fmt.allocPrint(alloc, "{s}/{s}", .{ font_dir, font_name.? });
    const data = getFont(io, font_path) catch {
        try sendText(io, stream, 404, "font not found");
        return;
    };
    const result = ttf.subset(alloc, data, text.?) catch |e| {
        const msg = switch (e) {
            error.NotTtf => "not a ttf font",
            else => "subset failed",
        };
        try sendText(io, stream, 422, msg);
        return;
    };
    try sendFont(io, stream, result.bytes);
}

// 字体字节缓存读取（命中零 IO；服务为单线程 accept 循环无需锁）
fn getFont(io: std.Io, path: []const u8) ![]const u8 {
    if (font_cache.get(path)) |d| return d;
    const data = try readFileAlloc(io, cache_gpa, path);
    const key = cache_gpa.dupe(u8, path) catch path;
    font_cache.put(key, data) catch {};
    return data;
}

// 读整个文件（spike 用，长度上限 100MB）
fn readFileAlloc(io: std.Io, alloc: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = try std.Io.Dir.cwd().openFile(io, path, .{});
    defer file.close(io);
    const len: usize = @intCast(try file.length(io));
    if (len > 100 * 1024 * 1024) return error.FileTooBig;
    const out = try alloc.alloc(u8, len);
    const got = try file.readPositionalAll(io, out, 0);
    if (got < len) return error.ShortRead;
    return out;
}

fn sendText(io: std.Io, stream: std.Io.net.Stream, code: u16, body: []const u8) !void {
    var hb: [256]u8 = undefined;
    const head = try std.fmt.bufPrint(&hb, "HTTP/1.1 {d} X\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ code, body.len });
    try writeAll(io, stream, head);
    try writeAll(io, stream, body);
}

fn sendFont(io: std.Io, stream: std.Io.net.Stream, bytes: []const u8) !void {
    var hb: [256]u8 = undefined;
    const head = try std.fmt.bufPrint(&hb, "HTTP/1.1 200 OK\r\nContent-Type: font/ttf\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{bytes.len});
    try writeAll(io, stream, head);
    try writeAll(io, stream, bytes);
}

// 底层 net_write 循环写满
fn writeAll(io: std.Io, stream: std.Io.net.Stream, bytes: []const u8) !void {
    var off: usize = 0;
    while (off < bytes.len) {
        const result = try io.operate(.{ .net_write = .{
            .socket_handle = stream.socket.handle,
            .data = &.{bytes[off..]},
        } });
        const n = try result.net_write;
        if (n == 0) return error.BrokenPipe;
        off += n;
    }
}

fn urlDecode(alloc: std.mem.Allocator, s: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == '%' and i + 2 < s.len) {
            const hi = std.fmt.charToDigit(s[i + 1], 16) catch {
                try out.append(alloc, s[i]);
                i += 1;
                continue;
            };
            const lo = std.fmt.charToDigit(s[i + 2], 16) catch {
                try out.append(alloc, s[i]);
                i += 1;
                continue;
            };
            try out.append(alloc, hi * 16 + lo);
            i += 3;
        } else if (s[i] == '+') {
            try out.append(alloc, ' ');
            i += 1;
        } else {
            try out.append(alloc, s[i]);
            i += 1;
        }
    }
    return out.toOwnedSlice(alloc);
}
