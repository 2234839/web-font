import { fontDirs, subsetCacheMaxSize } from "./config";
import { LruCache } from "./lru_cache";
import { path_join, readFile, stat, readdir } from "./interface";
import { loadPersistedStats, scheduleStatsFlush, type PersistedStats } from "./stats_store";

/** 解析请求 URL（req.url 只有路径，需要补全协议和主机才能用 URL API） */
export function parseUrl(req: Request): URL {
  return new URL(req.url, "http://localhost");
}

/** JSON 响应工具 */
export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 运行时统计（累计计数跨重启持久化，startTime 为本次进程启动时刻） */
export const stats = {
  /** 服务启动时间戳（进程级，不持久化） */
  startTime: Date.now(),
  /** 总请求数（持久化累计） */
  totalRequests: 0,
  /** 字体裁剪请求次数（含缓存命中；持久化累计） */
  subsetRequests: 0,
  /** 字体裁剪缓存命中次数（持久化累计） */
  subsetCacheHits: 0,
  /** 累计裁剪文字字符数（持久化累计） */
  totalChars: 0,
};

/**
 * 从持久化文件恢复累计计数
 *
 * 在 main() 最早期 await 一次：让计数器从历史值起步，实现跨重启持久化。
 * startTime 始终重置为当前时刻——uptime 度量的是本次进程。
 */
export async function initStats(): Promise<void> {
  const persisted = await loadPersistedStats();
  stats.startTime = persisted.startTime;
  stats.totalRequests = persisted.totalRequests;
  stats.subsetRequests = persisted.subsetRequests;
  stats.subsetCacheHits = persisted.subsetCacheHits;
  stats.totalChars = persisted.totalChars;
}

/** 取出需要持久化的累计计数字段 */
export function snapshotStats(): PersistedStats {
  return {
    totalRequests: stats.totalRequests,
    subsetRequests: stats.subsetRequests,
    subsetCacheHits: stats.subsetCacheHits,
    totalChars: stats.totalChars,
  };
}

/**
 * 标记统计已变更，触发防抖落盘
 *
 * 请求热路径调用：仅做一次对象赋值 + 幂等的定时器检查，绝不阻塞。
 * 真正的磁盘 IO 由 stats_store 内部按 FLUSH_INTERVAL 批量执行。
 */
export function markStatsDirty(): void {
  scheduleStatsFlush(snapshotStats());
}

/** 字体文件 LRU 缓存，最多保留 3 个最近使用的字体 buffer（按条目数淘汰） */
export const fontBufferCache = new LruCache<ArrayBuffer>({ maxSize: 3 });

/** 字体裁剪结果 LRU 缓存（按字节容量淘汰） */
export const subsetCache = new LruCache<ArrayBuffer>({ maxBytes: subsetCacheMaxSize, sizeFn: (v) => v.byteLength });

/**
 * 在所有字体目录中查找字体文件
 * 匹配优先级：精确匹配 > 前缀匹配 > 包含匹配
 */
export async function findFontPath(filename: string): Promise<string | null> {
  for (const dir of fontDirs) {
    const filePath = path_join(dir, filename);
    try {
      const s = await stat(filePath);
      if (s.isFile()) return filePath;
    } catch {}
  }

  const allFonts: Array<{ basename: string; path: string }> = [];
  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(entry.name)) {
          allFonts.push({
            basename: entry.name.replace(/\.[^.]+$/, ""),
            path: path_join(dir, entry.name),
          });
        }
      }
    } catch {}
  }

  const query = filename.replace(/\.[^.]+$/, "").toLowerCase();

  for (const f of allFonts) {
    if (f.basename.toLowerCase().startsWith(query)) return f.path;
  }

  for (const f of allFonts) {
    if (f.basename.toLowerCase().includes(query)) return f.path;
  }

  return null;
}

/** 从缓存或磁盘读取字体 buffer */
export async function readFontBuffer(fontPath: string): Promise<ArrayBuffer> {
  const cached = fontBufferCache.get(fontPath);
  if (cached) return cached;
  const buffer = new Uint8Array(await readFile(fontPath)).buffer;
  fontBufferCache.set(fontPath, buffer);
  return buffer;
}
