/**
 * 从环境变量读取服务配置，启动时一次性加载
 */
const env = globalThis.process?.env ?? {};

/** 临时上传开关 */
export const enableTempUpload = env.ENABLE_TEMP_UPLOAD === "true";

/** 管理员 API Key，为空则管理员上传不可用 */
export const adminApiKey: string = env.ADMIN_API_KEY ?? "";

/** 临时上传目录最大文件数 */
export const tempMaxFiles = parseInt(env.TEMP_MAX_FILES ?? "10", 10) || 10;

/** 临时上传目录总体积上限（字节），默认 200MB */
export const tempMaxTotalSize = parseInt(env.TEMP_MAX_TOTAL_SIZE ?? `${200 * 1024 * 1024}`, 10) || 200 * 1024 * 1024;

/** 临时字体保留时限（秒），超过后若无人使用则自动删除 */
export const tempRetentionSeconds = parseInt(env.TEMP_RETENTION_SECONDS ?? "10800", 10) || 10800;

/** 字体裁剪结果内存缓存容量上限（字节），默认 10MB */
export const subsetCacheMaxSize = parseInt(env.SUBSET_CACHE_MAX_SIZE ?? `${10 * 1024 * 1024}`, 10) || 10 * 1024 * 1024;

/**
 * 字体子集化最大并发数
 *
 * 字体裁剪是 CPU/内存密集操作，并发过多会导致 LLRT OOM 崩溃。
 * 默认 4：在 900M 内存限制下安全运行。
 * 内存充裕可调大，内存紧张可调小到 2。
 */
export const subsetConcurrency = Math.max(1, parseInt(env.SUBSET_CONCURRENCY ?? "4", 10) || 4);

/**
 * 队列等待超时（秒）—— 排队超过此时间返回 503，避免请求无限堆积
 */
export const subsetQueueTimeoutSeconds = Math.max(5, parseInt(env.SUBSET_QUEUE_TIMEOUT ?? "30", 10) || 30);

/** 字体搜索目录（按优先级排序：admin > 普通 > 临时） */
export const fontDirs = ["font/admin", "font", "font/temp"] as const;
