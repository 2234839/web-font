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

  const filename = sanitizeFilename(fileData.filename);
  const filePath = path_join("font/temp", filename);

  /** 同名文件直接覆盖，否则检查文件数量上限 */
  try {
    await (await import("./interface")).stat(filePath);
  } catch {
    const entries = await readdir("font/temp");
    const count = entries.filter((e) => e.isFile() && isAllowedFontFile(e.name)).length;
    if (count >= tempMaxFiles) {
      const toDelete = entries.find((e) => e.isFile() && isAllowedFontFile(e.name));
      if (toDelete) {
        try { await unlink(path_join("font/temp", toDelete.name)); } catch { /* 删除失败不影响上传 */ }
      }
    }
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
