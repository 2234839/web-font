import { readFile, writeFile, mkdir } from "./interface";

/**
 * 统计数据持久化
 *
 * 目标：累计计数（totalRequests 等）跨进程重启保留，且不拖慢请求热路径。
 *
 * 性能设计：
 *  - 启动时读一次历史值作为计数起点（一次 await，仅在 main() 初始化阶段）
 *  - 请求热路径只增内存计数器，绝不触碰磁盘
 *  - 写盘走防抖定时器：累积变更后每隔 FLUSH_INTERVAL 落盘一次；
 *    即使容器被 SIGKILL，最多丢失 FLUSH_INTERVAL 内的增量
 *  - 无脏数据时不写盘（脏标记），避免空转 IO
 */

/** 持久化文件位置：font/* 已在 .gitignore，且为运行时可写目录 */
const STATS_FILE = "font/.stats.json";

/** 持久化的累计计数字段（不含 startTime——uptime 是进程级，不可叠加） */
export interface PersistedStats {
  totalRequests: number;
  subsetRequests: number;
  subsetCacheHits: number;
  totalChars: number;
  /** 临时文件上传次数（持久化累计） */
  tempUploads: number;
}

/** 落盘防抖间隔（毫秒）：在请求热路径之外的最低频写盘，平衡丢失量与 IO */
const FLUSH_INTERVAL = 30_000;

/** 待落盘的快照；写入完成后才清空，避免写入期间的增量丢失 */
let pending: PersistedStats | null = null;

/** 防抖定时器句柄 */
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动时加载历史累计计数
 *
 * 文件不存在或损坏时安全降级为 0——统计不是关键路径，宁可丢历史也不让服务起不来。
 * 返回的 startTime 始终取当前时刻：uptime 度量的是「本次进程」的运行时长。
 */
export async function loadPersistedStats(): Promise<PersistedStats & { startTime: number }> {
  try {
    const raw = await readFile(STATS_FILE);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<PersistedStats>;
    return {
      totalRequests: parsed.totalRequests ?? 0,
      subsetRequests: parsed.subsetRequests ?? 0,
      subsetCacheHits: parsed.subsetCacheHits ?? 0,
      totalChars: parsed.totalChars ?? 0,
      tempUploads: parsed.tempUploads ?? 0,
      startTime: Date.now(),
    };
  } catch {
    /** 首次启动 / 文件缺失 / JSON 损坏：从 0 起步 */
    return { totalRequests: 0, subsetRequests: 0, subsetCacheHits: 0, totalChars: 0, tempUploads: 0, startTime: Date.now() };
  }
}

/**
 * 标记一次需要落盘的快照
 *
 * 由 stats 模块在计数变化后调用。仅在尚未排队时启动防抖定时器，
 * 避免高频请求每次都重排定时器（保证最长 FLUSH_INTERVAL 内必落盘）。
 */
export function scheduleStatsFlush(snapshot: PersistedStats): void {
  pending = snapshot;
  if (flushTimer !== null) return;
  flushTimer = setInterval(flushStats, FLUSH_INTERVAL);
}

/** 取快照并写盘；无变更时直接跳过 */
async function flushStats(): Promise<void> {
  if (pending === null) return;
  /** 先取走快照再写：写盘期间新到的增量会进下一次 pending，不会丢 */
  const snapshot = pending;
  pending = null;
  try {
    /** font/ 目录通常已由 ensureDirectories 创建，这里兜底以防万一 */
    await mkdir("font");
    await writeFile(STATS_FILE, new TextEncoder().encode(JSON.stringify(snapshot)));
  } catch (err) {
    /** 写盘失败不影响服务：把快照放回 pending，等下个周期重试 */
    console.log("[stats] flush failed:", err);
    pending = snapshot;
  }
}

/**
 * 进程退出前的同步落盘
 *
 * LLRT/容器被 SIGKILL 时不会触发，定时器才是主力。
 * 此钩子仅在优雅退出时减少最后一次增量丢失。
 */
export function flushStatsSyncSafe(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  /** markStatsDirty() 已把最新计数放进 pending；此处尽力触发最后一次异步落盘。
   *  LLRT/容器被 SIGKILL 时不会到达，定时器才是落盘主力。 */
  flushStats();
}
