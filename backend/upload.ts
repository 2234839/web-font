import { writeFile, unlink, readdir, stat, path_join } from "./interface";
import { enableTempUpload, adminApiKey, tempMaxFiles, tempMaxTotalSize } from "./config";

/** 允许的字体文件扩展名 */
const ALLOWED_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];

function isAllowedFontFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 清理文件名，移除路径分隔符、危险字符和路径穿越成分 */
function sanitizeFilename(filename: string) {
  let name = filename.replace(/[/\\]/g, "").replace(/[\x00-\x1f]/g, "");
  /** 移除所有 .. 防止路径穿越 */
  name = name.replace(/\.\./g, "");
  /** 取基础文件名，防止以 . 开头的隐藏文件 */
  name = name.replace(/^\./, "");
  if (!name) return "unnamed.ttf";
  return name;
}

/** 确保目录存在，不存在则创建 */
async function ensureDir(dir: string) {
  const { stat, mkdir } = await import("./interface");
  try {
    await stat(dir);
  } catch {
    await mkdir(dir);
  }
}

export interface UploadResult {
  success: boolean;
  error?: string;
}

/**
 * 获取 temp 目录中所有字体文件及其大小
 * 返回按名称排序的列表（文件系统 readdir 顺序近似 FIFO）
 */
async function getTempFontFiles(): Promise<Array<{ name: string; size: number }>> {
  const entries = await readdir("font/temp");
  const files: Array<{ name: string; size: number }> = [];
  for (const entry of entries) {
    if (entry.isFile() && isAllowedFontFile(entry.name)) {
      const s = await stat(path_join("font/temp", entry.name));
      files.push({ name: entry.name, size: s.size });
    }
  }
  return files;
}

/**
 * 按需清理 temp 目录，使文件数量和总体积满足限制
 * @param incomingSize 即将上传的文件大小，用于判断总体积是否超限
 */
async function evictIfNeeded(incomingSize: number) {
  const files = await getTempFontFiles();

  /** 数量超限时删除最早的文件 */
  while (files.length >= tempMaxFiles) {
    const oldest = files.shift();
    if (!oldest) break;
    try { await unlink(path_join("font/temp", oldest.name)); } catch { /* 删除失败不影响上传 */ }
  }

  /** 总体积超限时继续删除，直到腾出足够空间 */
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const needed = totalSize + incomingSize - tempMaxTotalSize;
  if (needed > 0) {
    let freed = 0;
    for (const file of files) {
      if (freed >= needed) break;
      try { await unlink(path_join("font/temp", file.name)); } catch { /* 删除失败不影响上传 */ }
      freed += file.size;
    }
  }
}

export async function handleTempUpload(fileData: { data: Uint8Array; filename: string }): Promise<UploadResult> {
  if (!enableTempUpload) {
    return { success: false, error: "临时上传功能未启用" };
  }

  if (!isAllowedFontFile(fileData.filename)) {
    return { success: false, error: "不支持的字体文件格式，仅支持 ttf/otf/woff/woff2" };
  }

  await ensureDir("font/temp");

  const filename = sanitizeFilename(fileData.filename);
  const filePath = path_join("font/temp", filename);

  /** 同名文件直接覆盖（覆盖不算新增），否则检查限制并清理 */
  try {
    const existing = await stat(filePath);
    /** 覆盖时，新文件可能比旧文件大，仍需检查总体积 */
    await evictIfNeeded(fileData.data.length - existing.size);
  } catch {
    await evictIfNeeded(fileData.data.length);
  }

  await writeFile(filePath, fileData.data);
  return { success: true };
}

export async function handleAdminUpload(
  fileData: { data: Uint8Array; filename: string },
  apiKey: string,
): Promise<UploadResult> {
  if (!adminApiKey) {
    return { success: false, error: "管理员上传功能未启用" };
  }

  if (apiKey !== adminApiKey) {
    return { success: false, error: "API Key 无效" };
  }

  if (!isAllowedFontFile(fileData.filename)) {
    return { success: false, error: "不支持的字体文件格式，仅支持 ttf/otf/woff/woff2" };
  }

  await ensureDir("font/admin");

  const filename = sanitizeFilename(fileData.filename);
  await writeFile(path_join("font/admin", filename), fileData.data);
  return { success: true };
}
