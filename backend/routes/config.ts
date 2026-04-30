import { jsonResponse } from "../shared";
import { enableTempUpload, adminApiKey } from "../config";

/** GET /api/config — 返回公开配置 */
export async function handleGetConfig(req: Request, res: Response) {
  return {
    req,
    res: jsonResponse({
      enableTempUpload,
      adminUploadEnabled: !!adminApiKey,
      supportedOutTypes: ["woff2", "ttf"],
    }),
  };
}
