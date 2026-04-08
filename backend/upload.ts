import { writeFile, unlink, readdir, path_join } from "./interface";
import { enableTempUpload, adminApiKey, tempMaxFiles } from "./config";

/** 允许的字体文件扩展名 */
const ALLOWED_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];

function isAllowedFontFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 清理文件名，移除路径分隔符和危险字符 */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\]/g, "").replace(/[\x00-\x1f]/g, "");
}

/** 生成带时间戳前缀的文件名，用于 FIFO 排序 */
function generateTempFilename(originalName: string): string {
  const ts = Date.now().toString(36);
  const ext = originalName.includes(".") ? "." + originalName.split(".").pop() : ".ttf";
  const base = originalName.replace(/\.[^.]+$/, "");
  return `${ts}_${base}${ext}`;
}

/** 获取临时目录中的字体文件列表 */
async function getTempFiles(): Promise<string[]> {
  const entries = await readdir("font/temp");
  return entries
    .filter((e) => e.isFile() && isAllowedFontFile(e.name))
    .map((e) => e.name)
    .sort();
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

export async function handleTempUpload(fileData: { data: Uint8Array; filename: string }): Promise<UploadResult> {
  if (!enableTempUpload) {
    return { success: false, error: "临时上传功能未启用" };
  }

  if (!isAllowedFontFile(fileData.filename)) {
    return { success: false, error: "不支持的字体文件格式，仅支持 ttf/otf/woff/woff2" };
  }

  await ensureDir("font/temp");

  const existingFiles = await getTempFiles();

  // FIFO: 超出上限时删除最早的文件
  if (existingFiles.length >= tempMaxFiles) {
    const toDelete = existingFiles[0];
    try {
      await unlink(path_join("font/temp", toDelete));
    } catch {
      // 删除失败不影响上传
    }
  }

  const filename = generateTempFilename(sanitizeFilename(fileData.filename));
  await writeFile(path_join("font/temp", filename), fileData.data);
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
