import { freemem, totalmem } from "os";
import { readFile } from "./interface";

/** 内存快照：同时考虑宿主机空闲内存和容器 cgroup 剩余额度 */
interface MemorySnapshot {
  limit: number;
  free: number;
  reserve: number;
}

const MIB = 1024 * 1024;
const decoder = new TextDecoder();
let activeCount = 0;
let waitingCount = 0;
let reservedBytes = 0;
let maxConcurrency = 4;

/** 读取一个内核数值文件；memory.max 在未限制时为 max，会返回 NaN 并被忽略 */
async function readMemoryNumber(path: string): Promise<number> {
  return Number(decoder.decode(await readFile(path)).trim());
}

/** 优先读取 cgroup v2，再兼容 v1；非容器环境没有这些文件 */
async function readCgroupMemory(): Promise<{ limit: number; free: number } | null> {
  const candidates = [
    ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "/sys/fs/cgroup/memory/memory.usage_in_bytes"],
  ] as const;
  for (const [limitPath, usedPath] of candidates) {
    try {
      const [limit, used] = await Promise.all([readMemoryNumber(limitPath), readMemoryNumber(usedPath)]);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used >= 0) {
        return { limit, free: Math.max(0, limit - used) };
      }
    } catch {
      /** 当前运行环境没有这一版 cgroup 接口，继续探测下一版 */
    }
  }
  return null;
}

/** 每次准入都读取当前值，不缓存内存水位 */
async function readMemorySnapshot(): Promise<MemorySnapshot> {
  const hostLimit = totalmem();
  const hostFree = freemem();
  const cgroup = await readCgroupMemory();
  /**
   * 容器内 os.freemem() 反映的是宿主机水位（与容器自身额度无关），
   * 宿主机内存紧张会误杀容器内任务。检测到 cgroup 限额时以 cgroup 为唯一权威：
   * limit/limit/free 都取容器自身额度。
   */
  const limit = cgroup ? cgroup.limit : hostLimit;
  const free = cgroup ? cgroup.free : hostFree;
  /** 给运行时和静态请求保留内存，绝不把水位用满 */
  const reserve = Math.max(32 * MIB, Math.min(128 * MIB, limit * 0.1));
  return { limit, free, reserve };
}

/**
 * 容器内存压力判定：可用（cgroup 优先）低于限额的 15%。
 * 供缓存压力卸载循环使用，与 withMemoryGate 的准入判断相互独立。
 */
export async function memoryUnderPressure(): Promise<boolean> {
  const { limit, free } = await readMemorySnapshot();
  return free < limit * 0.15;
}

/** 小内存机器最多同时执行两个重任务；大内存机器仍受配置上限约束 */
function concurrencyLimit(memory: MemorySnapshot): number {
  return memory.limit <= 2 * 1024 * MIB ? Math.min(maxConcurrency, 2) : maxConcurrency;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 所有字体重任务共用的内存闸门。
 *
 * 在读取完整字体之前按源文件预估内存；并发槽位和实际可用内存任一不足都排队。
 * 没有任务运行时允许启动一个大任务，避免小内存机器因预估值偏大而永久饥饿。
 * 任务超时返回 null，由调用方按现有接口语义返回 503 或流式错误。
 */
export async function withMemoryGate<T>(
  task: () => Promise<T>,
  queueTimeoutMs: number,
  estimatedBytes = 64 * MIB,
): Promise<T | null> {
  const deadline = Date.now() + queueTimeoutMs;
  let queued = false;
  while (true) {
    const memory = await readMemorySnapshot();
    const hasSlot = activeCount < concurrencyLimit(memory);
    const available = memory.free - memory.reserve - reservedBytes;
    const hasMemory = activeCount === 0 ? available > 0 : available >= estimatedBytes;
    if (hasSlot && hasMemory) {
      if (queued) waitingCount--;
      activeCount++;
      reservedBytes += estimatedBytes;
      try {
        return await task();
      } finally {
        activeCount--;
        reservedBytes -= estimatedBytes;
      }
    }
    if (!queued) {
      queued = true;
      waitingCount++;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      waitingCount--;
      return null;
    }
    await delay(Math.min(50, remaining));
  }
}

/** 初始化最大并发数；实际并发还会随每次任务的内存水位进一步降低 */
export function initMemoryGate(concurrency?: number): void {
  if (concurrency && concurrency > 0) maxConcurrency = concurrency;
  console.log(`[subset-queue] maxConcurrency=${maxConcurrency}, memoryAware=true`);
}

/** 获取当前队列状态（用于 stats / 日志） */
export function getQueueStats() {
  return {
    active: activeCount,
    waiting: waitingCount,
    reservedBytes,
    maxConcurrency,
  };
}
