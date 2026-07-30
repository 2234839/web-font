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
 * 字体子集化内存水位阈值（MB）
 *
 * RSS 超过此值时，新的子集化请求排队等待，
 * 直到前面的请求完成 + GC 释放内存后 RSS 回落。
 * 默认 600：容器限制 900M 时留 300M 余量给峰值。
 */
export const subsetMemSoftLimitMB = parseInt(env.SUBSET_MEM_SOFT_LIMIT_MB ?? "600", 10) || 600;

/**
 * 队列等待超时（秒）—— 排队超过此时间返回 503，客户端可重试
 */
export const subsetQueueTimeoutSeconds = Math.max(5, parseInt(env.SUBSET_QUEUE_TIMEOUT ?? "30", 10) || 30);

/** 字体搜索目录（按优先级排序：admin > 普通 > 临时） */
export const fontDirs = ["font/admin", "font", "font/temp"] as const;
