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

/** 字体搜索目录（按优先级排序） */
export const fontDirs = ["font", "font/temp", "font/admin"] as const;
