import { jsonResponse } from "../shared";
import { enableTempUpload, adminApiKey, tempRetentionSeconds, subsetConcurrency } from "../config";

/** GET /api/config — 返回公开配置 */
export async function handleGetConfig(req: Request, _res: Response) {
  return {
    req,
    res: jsonResponse({
      enableTempUpload,
      adminUploadEnabled: !!adminApiKey,
      supportedOutTypes: ["woff2", "ttf"],
      /** 临时字体保留时限（秒） */
      tempRetentionSeconds,
      /** 字体子集化最大并发数 */
      subsetConcurrency,
    }),
  };
}
