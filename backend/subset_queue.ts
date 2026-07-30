/**
 * 字体子集化并发队列（带字体分组调度）
 *
 * LLRT 运行时内存受限（~900M），字体裁剪是内存密集操作。
 * 通过固定并发数限制同时执行的子集化任务，防止 OOM 崩溃。
 *
 * 分组优化：排队中的请求按字体（groupKey）分组，同字体的请求优先连续处理，
 * 使字体 buffer / 解析对象在缓存窗口内被下一个请求复用，降低内存峰值。
 */

/** 等待队列项：resolver + groupKey（用于同字体分组连续唤醒） */
interface QueueItem {
  resolve: () => void;
  /** 分组键（通常为 fontPath），同组优先连续处理以复用字体缓存 */
  groupKey: string;
}

/** 等待队列：release 按分组优先级唤醒 */
const waitQueue: QueueItem[] = [];

/** 当前正在执行的子集化数量 */
let activeCount = 0;

/** 最大并发数（由 initConcurrency 设置） */
let maxConcurrency = 4;

/** 最近一次执行的 groupKey——同组请求优先连续唤醒 */
let lastGroupKey = "";

/**
 * 通过并发队列执行子集化任务
 *
 * - active < maxConcurrency → 立即执行
 * - active ≥ maxConcurrency → 排队等待，前面的完成后唤醒（同 groupKey 优先）
 * - 队列超时 → 返回 null（调用方返回 503，客户端可重试）
 *
 * 分组优化：同 groupKey（同一字体）的排队请求优先连续唤醒，
 * 使字体 buffer / 解析对象在缓存窗口内被下一个请求复用，降低内存峰值。
 *
 * 函数名保留 withMemoryGate 以减少调用方改动（subset.ts 等）。
 *
 * @param _softLimitMB 废弃保留（兼容签名），不再使用
 * @param task 实际的子集化异步任务
 * @param queueTimeoutMs 排队超时（毫秒）
 * @param groupKey 分组键（通常为 fontPath），同组连续处理以复用缓存
 * @returns 任务结果，或 null 表示排队超时
 */
export async function withMemoryGate<T>(
  _softLimitMB: number,
  task: () => Promise<T>,
  queueTimeoutMs: number,
  groupKey = "",
): Promise<T | null> {
  /** 并发已满，进入排队 */
  if (activeCount >= maxConcurrency) {
    const acquired = await waitForSlot(queueTimeoutMs, groupKey);
    if (!acquired) return null;
  }

  lastGroupKey = groupKey;
  activeCount++;
  try {
    return await task();
  } finally {
    activeCount--;
    release();
  }
}

/**
 * 排队等待并发槽位
 *
 * 加入队列，等待前面的请求完成后唤醒（同 groupKey 优先）。
 * 超时则从队列移除自己，返回 false。
 */
function waitForSlot(timeoutMs: number, groupKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    const item: QueueItem = {
      resolve: () => resolve(true),
      groupKey,
    };
    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(item);
      if (idx !== -1) waitQueue.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    item.resolve = () => {
      clearTimeout(timer);
      resolve(true);
    };
    waitQueue.push(item);
  });
}

/**
 * 从队列中取出下一个该唤醒的项
 *
 * 策略：优先选与 lastGroupKey 相同的项（同字体连续处理，复用缓存）；
 * 没有同组项则取队首（FIFO 公平）。
 */
function pickNext(): QueueItem | undefined {
  if (waitQueue.length === 0) return undefined;
  if (lastGroupKey) {
    const idx = waitQueue.findIndex((item) => item.groupKey === lastGroupKey);
    if (idx !== -1) return waitQueue.splice(idx, 1)[0];
  }
  return waitQueue.shift();
}

/**
 * 释放一个并发槽位，唤醒下一个等待者（同 groupKey 优先）
 */
function release(): void {
  if (waitQueue.length === 0) return;
  if (activeCount < maxConcurrency) {
    pickNext()?.resolve();
  }
}

/**
 * 初始化并发参数（由 config 设置）
 *
 * 必须在第一次 withMemoryGate 调用前执行。
 * @param _softLimitMB 废弃（兼容签名）
 * @param concurrency 最大并发数
 */
export function initMemoryGate(_softLimitMB: number, concurrency?: number): void {
  if (concurrency && concurrency > 0) {
    maxConcurrency = concurrency;
  }
  console.log(`[subset-queue] maxConcurrency=${maxConcurrency}`);
}

/** 获取当前队列状态（用于 stats / 日志） */
export function getQueueStats() {
  return {
    active: activeCount,
    waiting: waitQueue.length,
  };
}
