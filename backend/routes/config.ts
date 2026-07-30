import { jsonResponse } from "../shared";
import { enableTempUpload, adminApiKey, tempRetentionSeconds, subsetMemSoftLimitMB, subsetQueueTimeoutSeconds } from "../config";

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
      /** 子集化内存水位阈值（MB），RSS 超此值时排队 */
      subsetMemSoftLimitMB,
      /** 队列等待超时（秒） */
      subsetQueueTimeoutSeconds,
    }),
  };
}
