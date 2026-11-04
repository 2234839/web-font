//! 进程级缓存（对译 zig-spike/src/main.zig 的 parsed_cache + subset_cache）
//!
//! - 预解析字体缓存：永不失效，get-or-parse 串行在锁内
//! - 子集产物 LRU：按字节容量淘汰，语义对齐 TS subsetCache（LruCache evictByBytes）

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::ttf::Font;

/// 子集缓存默认容量 10MB（SUBSET_CACHE_MAX_SIZE 可覆盖，语义对齐 TS）
pub const DEFAULT_SUBSET_CACHE_MAX_BYTES: usize = 10 * 1024 * 1024;

/// 缓存条目：解析体 + 最后使用时间（空闲卸载判定用）
struct FontEntry {
    font: Arc<Font>,
    last_used: Instant,
}

/// 预解析字体缓存：path → 解析好的 Font（只读共享，Arc 派发）
/// 空闲超过阈值的条目由后台线程卸载释放内存（再次访问重付一次读盘+解析）
pub struct FontCache {
    map: Mutex<HashMap<String, FontEntry>>,
}

impl FontCache {
    pub fn new() -> Self {
        FontCache { map: Mutex::new(HashMap::new()) }
    }

    /// 命中零 IO + 零解析；未命中在锁内读文件并解析（二次检查避免重复解析，对齐 Zig getFont）
    /// 命中同时刷新 last_used
    pub fn get_or_parse(&self, path: &str) -> Result<Arc<Font>, FontCacheError> {
        let mut map = self.map.lock().unwrap();
        if let Some(e) = map.get_mut(path) {
            e.last_used = Instant::now();
            return Ok(e.font.clone());
        }
        let data = std::fs::read(path).map_err(|_| FontCacheError::NotFound)?;
        if data.len() > 100 * 1024 * 1024 {
            return Err(FontCacheError::NotFound);
        }
        let font = Arc::new(Font::parse(data).map_err(|_| FontCacheError::ParseFailed)?);
        map.insert(path.to_string(), FontEntry { font: font.clone(), last_used: Instant::now() });
        Ok(font)
    }

    /** 卸载空闲超过阈值的条目，返回卸载数。正在写出的响应持有 Arc 快照，卸载不影响它 */
    pub fn evict_idle(&self, max_idle: Duration) -> usize {
        let mut map = self.map.lock().unwrap();
        let before = map.len();
        map.retain(|_, e| e.last_used.elapsed() < max_idle);
        before - map.len()
    }

    /// 条目数（/api/stats 的 fontBufferCacheEntries 同位字段，口径注释见 Zig 版）
    #[allow(dead_code)] // /api/stats 接入前未用
    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

#[derive(Debug)]
pub enum FontCacheError {
    /// 文件缺失 / 超过 100MB 上限（对外同 404）
    NotFound,
    /// 解析失败（对外 422）
    ParseFailed,
}

/// LRU（按字节容量）：读命中移到最新端；插入超容量从最旧端淘汰。
/// 值存 `Arc<[u8]>`——命中返回 Arc 快照，淘汰不影响正在写出的响应
/// （语义等价 Zig 版「HIT 响应期间持锁」，锁粒度更小）。
/// 顺序表用 VecDeque（条目量级 ~200，O(n) 触碰移动可忽略），对齐 scLookup 的 unlink+append。
pub struct SubsetCache {
    inner: Mutex<SubsetCacheInner>,
}

struct SubsetCacheInner {
    map: HashMap<String, Arc<[u8]>>,
    /// 键的访问序：front = 最旧，back = 最新
    order: VecDeque<String>,
    used_bytes: usize,
    max_bytes: usize,
}

impl SubsetCache {
    pub fn new(max_bytes: usize) -> Self {
        SubsetCache {
            inner: Mutex::new(SubsetCacheInner {
                map: HashMap::new(),
                order: VecDeque::new(),
                used_bytes: 0,
                max_bytes,
            }),
        }
    }

    /// 查询：命中把键移到最新端并返回 Arc 快照
    pub fn get(&self, key: &str) -> Option<Arc<[u8]>> {
        let mut g = self.inner.lock().unwrap();
        if !g.map.contains_key(key) {
            return None;
        }
        Self::touch(&mut g, key);
        g.map.get(key).cloned()
    }

    /// 插入：覆盖同键旧值；超容量从最旧端淘汰
    pub fn insert(&self, key: &str, bytes: Vec<u8>) {
        let mut g = self.inner.lock().unwrap();
        let bytes: Arc<[u8]> = bytes.into();
        if let Some(old) = g.map.insert(key.to_string(), bytes) {
            g.used_bytes -= old.len();
        } else {
            g.order.push_back(key.to_string());
        }
        g.used_bytes += g.map.get(key).unwrap().len();
        while g.used_bytes > g.max_bytes {
            let Some(oldest) = g.order.pop_front() else { break };
            if let Some(v) = g.map.remove(&oldest) {
                g.used_bytes -= v.len();
            }
        }
    }

    /// 把键移到最新端（命中语义）
    fn touch(g: &mut SubsetCacheInner, key: &str) {
        if let Some(pos) = g.order.iter().position(|k| k == key) {
            g.order.remove(pos);
            g.order.push_back(key.to_string());
        }
    }

    #[allow(dead_code)] // /api/stats 接入前未用
    /// 条目数（/api/stats 的 subsetCacheEntries）
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().map.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_by_bytes() {
        let c = SubsetCache::new(100);
        c.insert("a", vec![0u8; 60]);
        c.insert("b", vec![0u8; 30]);
        assert_eq!(c.len(), 2);
        c.insert("c", vec![0u8; 20]); // 90 → 110 > 100，淘汰 a
        assert_eq!(c.len(), 2);
        assert!(c.get("a").is_none());
        assert!(c.get("b").is_some() && c.get("c").is_some());
    }

    #[test]
    fn lru_touch_prevents_eviction() {
        let c = SubsetCache::new(100);
        c.insert("a", vec![0u8; 60]);
        c.insert("b", vec![0u8; 30]);
        c.get("a"); // a 变最新，b 最旧
        c.insert("c", vec![0u8; 20]); // 淘汰 b
        assert!(c.get("a").is_some() && c.get("b").is_none());
    }

    #[test]
    fn insert_over_same_key_replaces_bytes() {
        let c = SubsetCache::new(100);
        c.insert("k", vec![0u8; 80]);
        c.insert("k", vec![0u8; 10]); // 覆盖，不新增顺序位
        assert_eq!(c.len(), 1);
        assert_eq!(c.get("k").unwrap().len(), 10);
    }
}
