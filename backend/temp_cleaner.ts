/**
 * 临时字体保留机制 —— 定时扫描 font/temp，删除超过保留时限且最近无人使用的字体。
 *
 * "最近使用" = 最后一次被 subset/font-meta/font-detail 请求的时间。
 * 使用记录存在内存 Map 中（进程级），重启后从文件 mtime 重新起步。
 *
 * 清理周期 = 保留时限的一半（最少 5 分钟），避免过于频繁的扫描。
 */
import { readdir, stat, unlink, path_join } from "./interface";
import { tempRetentionSeconds } from "./config";

/** 临时字体目录 */
const TEMP_DIR = "font/temp";

/** 字体最后使用时间戳，key = 文件名（不含目录前缀） */
const lastUsedMap = new Map<string, number>();

/**
 * 记录字体被使用（subset/meta/detail 请求时调用）。
 * 仅记录 font/temp 下的文件，其他目录无需跟踪。
 */
export function markFontUsed(fontPath: string): void {
  /** 仅临时字体需要跟踪 */
  if (!fontPath.startsWith(TEMP_DIR + "/")) return;
  const name = fontPath.split("/").pop()!;
  lastUsedMap.set(name, Date.now());
}

/**
 * 执行一次清理扫描。
 * 遍历 font/temp 中的字体文件，删除：
 *   (now - max(最后使用时间, 文件 mtime)) > 保留时限
 */
async function cleanOnce(): Promise<void> {
  const now = Date.now();
  const retentionMs = tempRetentionSeconds * 1000;

  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdir(TEMP_DIR);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ttf|otf|woff|woff2)$/i.test(entry.name)) continue;

    const filePath = path_join(TEMP_DIR, entry.name);
    try {
      const s = await stat(filePath);
      /** 取"最后使用时间"和"文件修改时间"的较大值作为活跃判定基准 */
      const lastUsed = lastUsedMap.get(entry.name) ?? 0;
      const lastActive = Math.max(lastUsed, s.mtimeMs);
      if (now - lastActive > retentionMs) {
        await unlink(filePath);
        lastUsedMap.delete(entry.name);
        console.log(`[temp-cleaner] 删除过期临时字体: ${entry.name}`);
      }
    } catch {
      /** 文件可能在扫描过程中被删除，忽略 */
    }
  }
}

/** 清理周期：保留时限的一半，最少 5 分钟 */
const CLEAN_INTERVAL = Math.max(tempRetentionSeconds * 500, 300_000);

/**
 * 启动定时清理器。
 * 首次延迟 1 分钟执行（避免启动峰），之后按周期循环。
 */
export function startTempCleaner(): void {
  const intervalSec = Math.round(CLEAN_INTERVAL / 1000);
  console.log(`[temp-cleaner] 启动，保留时限 ${tempRetentionSeconds}s，清理周期 ${intervalSec}s`);

  /** 首次延迟 60 秒 */
  setTimeout(() => {
    cleanOnce().catch(() => {});
    /** 后续按周期循环 */
    setInterval(() => {
      cleanOnce().catch(() => {});
    }, CLEAN_INTERVAL);
  }, 60_000);
}
