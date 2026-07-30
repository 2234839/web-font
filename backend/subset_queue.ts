/**
 * 字体子集化并发队列控制器
 *
 * 字体裁剪是 CPU/内存密集操作（尤其大字集 woff2 brotli 压缩），
 * LLRT 运行时内存受限（~900M），并发过多会导致 brotli decoder OOM 崩溃。
 *
 * 通过 Semaphore 限制同时执行的子集化数量，超出并发的请求排队等待，
 * 等待超时则返回 503，避免请求无限堆积。
 */

/**
 * 等待队列中的请求超时时间（秒），由 config.ts 通过环境变量控制
 *
 * 在 subset.ts 中通过参数传入，不在此处硬编码。
 */

/** 当前正在执行的子集化数量 */
let activeCount = 0;
/** 当前排队等待的数量 */
let waitingCount = 0;

/**
 * 通过 Semaphore 执行子集化任务
 *
 * - 并发未满时立即执行
 * - 并发已满时排队等待，超时返回 null（调用方应返回 503）
 * - 返回任务结果，或 null 表示排队超时
 *
 * @param maxConcurrency 最大并发数
 * @param task 实际的子集化异步任务
 * @param queueTimeoutMs 排队等待超时（毫秒），超时返回 null
 * @returns 任务结果，或 null 表示排队超时
 */
export async function withConcurrencyLimit<T>(
  maxConcurrency: number,
  task: () => Promise<T>,
  queueTimeoutMs: number,
): Promise<T | null> {
  /** 并发未满，直接执行 */
  if (activeCount < maxConcurrency) {
    activeCount++;
    try {
      return await task();
    } finally {
      activeCount--;
      /** 唤醒一个等待者（如果有）—— 通过 resolve 触发 */
      notifyNext();
    }
  }

  /** 并发已满，进入排队 */
  waitingCount++;
  try {
    /** 等待获取许可，或超时 */
    const acquired = await waitForSlot(queueTimeoutMs);
    if (!acquired) {
      /** 排队超时，返回 null 让调用方返回 503 */
      return null;
    }
    activeCount++;
    try {
      return await task();
    } finally {
      activeCount--;
      notifyNext();
    }
  } finally {
    waitingCount--;
  }
}

/** 等待队列（FIFO） */
const waitQueue: Array<() => void> = [];

/**
 * 等待获取一个并发许可
 *
 * @param timeout 超时时间（毫秒）
 * @returns true=获得许可，false=超时
 */
function waitForSlot(timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    /** 超时定时器 */
    const timer = setTimeout(() => {
      /** 从队列中移除自己 */
      const idx = waitQueue.indexOf(resolver);
      if (idx !== -1) waitQueue.splice(idx, 1);
      resolve(false);
    }, timeout);

    /** resolve 包装：清除定时器再 resolve */
    const resolver = () => {
      clearTimeout(timer);
      resolve(true);
    };
    waitQueue.push(resolver);
  });
}

/**
 * 唤醒队列中下一个等待者
 *
 * 在 activeCount 减少后调用，让排队中的请求依次进入。
 */
function notifyNext() {
  /** 仍有空位且有人在等 */
  const resolver = waitQueue.shift();
  if (resolver) {
    resolver();
  }
}

/** 获取当前队列状态（用于 stats / 日志） */
export function getQueueStats() {
  return {
    active: activeCount,
    waiting: waitingCount,
  };
}
