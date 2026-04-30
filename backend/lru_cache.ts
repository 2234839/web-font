/**
 * 基于 Map 插入顺序的通用 LRU 缓存
 * 支持两种淘汰策略：按条目数、按字节容量
 */
export class LruCache<V> {
  private cache = new Map<string, V>();

  /** 计算条目字节大小（仅按容量淘汰时需要） */
  private readonly sizeFn?: (value: V) => number;

  /** 最大条目数（按条目淘汰时使用） */
  private readonly maxSize?: number;

  /** 最大字节容量（按容量淘汰时使用） */
  private readonly maxBytes?: number;

  /** 当前已用字节 */
  private usedBytes = 0;

  /** 当前缓存条目数 */
  get size() {
    return this.cache.size;
  }

  constructor(options: { maxSize: number } | { maxBytes: number; sizeFn: (value: V) => number }) {
    if ("maxSize" in options) {
      this.maxSize = options.maxSize;
    } else {
      this.maxBytes = options.maxBytes;
      this.sizeFn = options.sizeFn;
    }
  }

  /** 获取缓存值，命中时移到末尾（LRU） */
  get(key: string): V | undefined {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /** 写入缓存，超限时自动淘汰最久未使用的条目 */
  set(key: string, value: V): void {
    /** 如果 key 已存在，先移除旧值（更新大小） */
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      this.cache.delete(key);
      if (this.sizeFn) {
        this.usedBytes -= this.sizeFn(existing);
      }
    }

    this.cache.set(key, value);
    if (this.sizeFn) {
      this.usedBytes += this.sizeFn(value);
      this.evictByBytes();
    } else if (this.maxSize !== undefined) {
      this.evictByCount();
    }
  }

  /** 按条目数淘汰 */
  private evictByCount() {
    while (this.cache.size > this.maxSize!) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
  }

  /** 按字节容量淘汰 */
  private evictByBytes() {
    while (this.usedBytes > this.maxBytes! && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value!;
      const entry = this.cache.get(oldest)!;
      this.usedBytes -= this.sizeFn!(entry);
      this.cache.delete(oldest);
    }
  }
}
