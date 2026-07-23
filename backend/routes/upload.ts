import { jsonResponse, parseUrl } from "../shared";
import { parseMultipart } from "../multipart";
import { handleTempUpload, handleAdminUpload } from "../upload";

/** POST /api/upload?mode=temp|admin — 上传字体 */
export async function handleUpload(req: Request, _res: Response) {
  const url = parseUrl(req);
  const mode = url.searchParams.get("mode") ?? "temp";

  const contentType = req.headers.get("Content-Type") ?? "";
  console.log("[upload] mode:", mode, "contentType:", contentType);

  const body = (req as Request & { _bodyBuffer?: ArrayBuffer })._bodyBuffer;
  if (!body || body.byteLength === 0) {
    return { req, res: jsonResponse({ success: false, error: "请求体为空" }, 400) };
  }
  console.log("[upload] body size:", body.byteLength);

  let parsed;
  try {
    parsed = parseMultipart(contentType, body);
    console.log("[upload] parsed files:", parsed.files.length);
  } catch (err) {
    console.log("[upload] parse error:", err);
    return { req, res: jsonResponse({ success: false, error: "无效的 multipart 数据" }, 400) };
  }

  if (!parsed.files || parsed.files.length === 0) {
    return { req, res: jsonResponse({ success: false, error: "未提供文件" }, 400) };
  }

  const file = parsed.files[0];
  console.log("[upload] file:", file.name, "filename:", file.filename, "data size:", file.data.length);

  let result;
  if (mode === "admin") {
    const authHeader = req.headers.get("Authorization") ?? "";
    const apiKey = authHeader.replace("Bearer ", "");
    result = await handleAdminUpload({ data: file.data, filename: file.filename }, apiKey);
    console.log("[upload] admin result:", result);
    return { req, res: jsonResponse(result, result.success ? 200 : 403) };
  }

  result = await handleTempUpload({ data: file.data, filename: file.filename });
  console.log("[upload] temp result:", result);
  return { req, res: jsonResponse(result, result.success ? 200 : 400) };
}
