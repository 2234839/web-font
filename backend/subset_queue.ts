/**
 * 字体子集化内存水位闸门
 *
 * LLRT 运行时内存受限（~900M），字体裁剪是内存密集操作。
 * 不用固定并发数，而是实时监控进程 RSS：
 *  - RSS < softLimit：直接执行（小请求可高并发）
 *  - RSS ≥ softLimit：排队等待，直到前面的请求完成 + GC 释放内存
 *  - 无硬限制/拒绝：所有请求最终都会执行
 *
 * 内存监控通过 /proc/self/statm（Linux 唯一可用方式，LLRT 无 process.memoryUsage）。
 * GC 通过 LLRT 内置的 __gc() 主动触发（请求完成后调用，加速内存回收）。
 */

/** /proc/self/statm 文件描述符（启动时打开，反复读取不需每次 open/close） */
let statmFd: number | null = null;

/**
 * 读取当前进程 RSS（常驻内存），单位 MB
 *
 * Node 环境使用 process.memoryUsage().rss；LLRT 无此 API，改用 /proc/self/statm。
 * /proc/self/statm 格式：size resident shared text lib data dt（单位：页）
 * resident 字段 × 页大小(4096) = RSS 字节数。
 */
function getRssMB(): number {
  try {
    /** Node 环境优先使用 process.memoryUsage() */
    if (typeof process !== "undefined" && process.memoryUsage) {
      return Math.round(process.memoryUsage().rss / 1024 / 1024);
    }
    /** LLRT 环境：读取 /proc/self/statm */
    if (statmFd === null) {
      const { openSync } = require("fs");
      statmFd = openSync("/proc/self/statm", "r");
    }
    const { readSync } = require("fs");
    const buf = new Uint8Array(256);
    const n = readSync(statmFd, buf, 0, 256, 0);
    const parts = new TextDecoder().decode(buf.subarray(0, n)).trim().split(" ");
    return Math.round((parseInt(parts[1]) * 4096) / 1024 / 1024);
  } catch {
    /** 两个方案都不可用，返回 0 表示「无限制」 */
    return 0;
  }
}

/**
 * 主动触发垃圾回收
 *
 * LLRT 内置 __gc()，请求完成后调用可立即释放字体解析产生的大对象，
 * 而非等待 LLRT 引擎自动 GC（可能延迟数秒）。
 */
function gc(): void {
  try {
    (globalThis as any).__gc?.();
  } catch {
    /** __gc 不存在（Node 环境）时静默跳过 */
  }
}

/** 等待队列（FIFO）：softLimit 内的请求完成后依次唤醒 */
const waitQueue: Array<() => void> = [];

/** 当前正在执行的子集化数量（用于 stats 展示） */
let activeCount = 0;

/** softLimit 引用（checkAndNotify 需要用） */
let softLimitRef = 0;

/**
 * 通过内存水位闸门执行子集化任务
 *
 * - RSS 未超 softLimit → 立即执行
 * - RSS 超 softLimit → 排队等待，前面的请求完成后 GC → RSS 回落 → 唤醒
 * - 队列超时 → 返回 null（调用方返回 503，客户端可重试）
 *
 * @param softLimitMB 内存软限制（MB），RSS 超过此值时新请求排队
 * @param task 实际的子集化异步任务
 * @param queueTimeoutMs 排队超时（毫秒）
 * @returns 任务结果，或 null 表示排队超时
 */
export async function withMemoryGate<T>(
  softLimitMB: number,
  task: () => Promise<T>,
  queueTimeoutMs: number,
): Promise<T | null> {
  /** RSS=0 表示无法读取（开发环境），跳过闸门直接执行 */
  if (softLimitMB > 0 && getRssMB() >= softLimitMB) {
    /** 内存超阈值，进入排队 */
    const acquired = await waitForSlot(queueTimeoutMs);
    if (!acquired) return null;
  }

  activeCount++;
  try {
    return await task();
  } finally {
    activeCount--;
    /**
     * 任务完成后主动 GC，加速释放字体解析的大对象。
     * 然后检查队列：如果 RSS 已回落，唤醒下一个等待者。
     */
    gc();
    checkAndNotify();
  }
}

/**
 * 排队等待内存释放
 *
 * 加入 FIFO 队列，等待前面的请求完成后唤醒。
 * 超时则从队列移除自己，返回 false。
 */
function waitForSlot(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(resolver);
      if (idx !== -1) waitQueue.splice(idx, 1);
      resolve(false);
    }, timeoutMs);

    const resolver = () => {
      clearTimeout(timer);
      resolve(true);
    };
    waitQueue.push(resolver);
  });
}

/**
 * 检查内存并唤醒队列
 *
 * 每个子集化任务完成后调用：
 * 1. 如果 RSS < softLimit 且队列非空 → 唤醒下一个
 * 2. RSS 仍超限 → 不唤醒（等待引擎自动 GC 后下次再检查）
 * 3. 兜底：5 秒后如果 RSS 没超 softLimit×1.2，强制唤醒（防饿死）
 */
function checkAndNotify(): void {
  if (waitQueue.length === 0) return;
  /** RSS 未知（开发环境）→ 直接唤醒 */
  if (softLimitRef === 0) {
    waitQueue.shift()?.();
    return;
  }
  /** RSS 已回落到阈值以下 → 唤醒下一个 */
  if (getRssMB() < softLimitRef) {
    waitQueue.shift()?.();
    /** 唤醒后递归检查：可能还有内存余量给更多等待者 */
    checkAndNotify();
    return;
  }
  /**
   * RSS 仍超限时不立即唤醒——设置兜底定时器：
   * 5 秒后如果 RSS 降到 softLimit×1.2 以内，唤醒一个（防极端饿死）。
   */
  setTimeout(() => {
    if (waitQueue.length > 0 && getRssMB() < softLimitRef * 1.2) {
      waitQueue.shift()?.();
    }
  }, 5000);
}

/**
 * 初始化闸门参数（由 config.ts 的值设置）
 *
 * 必须在第一次 withMemoryGate 调用前执行。
 * @param softLimitMB 内存软限制（MB）
 */
export function initMemoryGate(softLimitMB: number): void {
  softLimitRef = softLimitMB;
  const rss = getRssMB();
  if (rss > 0) {
    console.log(`[memgate] RSS=${rss}MB, softLimit=${softLimitMB}MB`);
  }
}

/** 获取当前队列状态（用于 stats / 日志） */
export function getQueueStats() {
  return {
    active: activeCount,
    waiting: waitQueue.length,
    rssMB: getRssMB(),
  };
}
