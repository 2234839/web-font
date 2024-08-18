// 解析请求
export function parseRequest(requestBuffer: string): cRequest {
  const [requestLine] = requestBuffer.split("\r\n");
  const [method, url] = requestLine.split(" ");
  return { method, url };
}
// 请求和响应模型
export interface cRequest {
  method: string;
  url: string;
}

export interface cResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export type cNext = (
  req: cRequest,
  res: cResponse,
) => { req: cRequest; res: cResponse } | Promise<{ req: cRequest; res: cResponse }>;
// 中间件函数类型
export type cMiddleware = (req: cRequest, res: cResponse, next: cNext) => ReturnType<cNext>;
