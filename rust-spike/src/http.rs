//! HTTP 响应辅助（对译 zig-spike/src/main.zig 的 sendText/sendFont/sendJson/writeAll/urlDecode）
//! CORS 三头追加语义对齐 backend/app.ts corsMiddleware（OPTIONS 204 例外不带 CORS 头）

use std::io::{self, IoSlice, Write};
use std::net::TcpStream;

/// CORS 三头（顺序对齐 Zig 版，逐头追加）
const CORS: [&str; 3] = [
    "Access-Control-Allow-Origin: *",
    "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers: Content-Type, Authorization",
];

/// 连接关闭头
fn conn_header(close: bool) -> &'static str {
    if close { "close" } else { "keep-alive" }
}

/// iovec 式写出：write_vectored 单次系统调用（对齐 Zig writeAll 单次 net_write 的意图）；
/// 各段零拷贝（IoSlice 借用），部分写时循环补发剩余区间
pub fn write_all(stream: &mut TcpStream, parts: &[&[u8]]) -> io::Result<()> {
    let mut slices: Vec<IoSlice> = parts.iter().map(|p| IoSlice::new(p)).collect();
    let mut total: usize = slices.iter().map(|s| s.len()).sum();
    while total > 0 {
        let n = stream.write_vectored(&slices)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "write_vectored 写入 0 字节"));
        }
        total -= n;
        let mut rem = n;
        for s in slices.iter_mut() {
            let len = s.len();
            if rem >= len {
                rem -= len;
            } else {
                s.advance(rem);
                break;
            }
        }
        slices.retain(|s| !s.is_empty());
    }
    Ok(())
}

/// FNV-1a 64 字节哈希 → 强 ETag（"\"16hex\""）
pub fn etag_of(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("\"{h:016x}\"")
}

/// 纯文本响应（extra 可挂额外头如 Retry-After）
pub fn send_text(
    stream: &mut TcpStream,
    code: u16,
    body: &str,
    close: bool,
    extra: &[&str],
) -> io::Result<()> {
    let mut head = String::with_capacity(256 + body.len());
    head.push_str(&format!(
        "HTTP/1.1 {code} X\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n",
        body.len()
    ));
    for h in extra {
        head.push_str(h);
        head.push_str("\r\n");
    }
    for h in CORS {
        head.push_str(h);
        head.push_str("\r\n");
    }
    head.push_str(&format!("Connection: {}\r\n\r\n", conn_header(close)));
    write_all(stream, &[head.as_bytes(), body.as_bytes()])
}

#[allow(dead_code)] // R5' 路由接入前未用
/// JSON 错误响应（格式对齐 TS jsonResponse：application/json）
pub fn send_json(stream: &mut TcpStream, code: u16, body: &str, close: bool) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    let mut head = head;
    for h in CORS {
        head.push_str(h);
        head.push_str("\r\n");
    }
    head.push_str(&format!("Connection: {}\r\n\r\n", conn_header(close)));
    write_all(stream, &[head.as_bytes(), body.as_bytes()])
}

/// 字体成功响应（强缓存 max-age=86400 + ETag 兜底；命中 If-None-Match 回 304 零字节）
/// 背景：字体子集内容不变，24h 强缓存使浏览器零回源；服务端字节变化靠 ETag 在协商时自愈
pub fn send_font(
    stream: &mut TcpStream,
    bytes: &[u8],
    close: bool,
    content_type: &str,
    extra: &[&str],
    timing: &[&str],
    etag: &str,
    if_none_match: Option<&str>,
) -> io::Result<()> {
    // 弱 ETag 匹配（W/"x" 与 "x" 都认）
    let matched = if_none_match.is_some_and(|v| {
        v.split(',').any(|t| {
            let t = t.trim();
            t == etag
                || t == format!("W/{etag}")
                || (t.starts_with("W/") && &t[2..] == etag)
        })
    });
    if matched {
        let head = format!(
            "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nCache-Control: public, max-age=86400\r\nETag: {etag}\r\n"
        );
        let mut head = head;
        for h in timing.iter() {
            head.push_str(h);
            head.push_str("\r\n");
        }
        head.push_str(&format!("Connection: {}\r\n\r\n", conn_header(close)));
        return write_all(stream, &[head.as_bytes()]);
    }
    let mut head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: public, max-age=86400\r\nETag: {etag}\r\n",
        bytes.len()
    );
    for h in extra.iter().chain(timing.iter()) {
        head.push_str(h);
        head.push_str("\r\n");
    }
    for h in CORS {
        head.push_str(h);
        head.push_str("\r\n");
    }
    head.push_str(&format!("Connection: {}\r\n\r\n", conn_header(close)));
    write_all(stream, &[head.as_bytes(), bytes])
}

/// OPTIONS 预检 204（corsMiddleware 分支：无 CORS 头）
pub fn send_options(stream: &mut TcpStream, close: bool) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: {}\r\n\r\n",
        conn_header(close)
    );
    write_all(stream, &[head.as_bytes()])
}

/// URL 解码（对译 Zig urlDecode：%XX 十六进制 + '+'→空格；非法序列原样保留）
pub fn url_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                }
                _ => {
                    out.push(b[i]);
                    i += 1;
                }
            }
        } else if b[i] == b'+' {            out.push(b' ');
            i += 1;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_decode_basic() {
        assert_eq!(url_decode("%E5%AD%97%E4%BD%93"), "字体".as_bytes());
        assert_eq!(url_decode("a+b"), b"a b");
        assert_eq!(url_decode("100%"), b"100%"); // 截断的 % 原样保留
    }
}
