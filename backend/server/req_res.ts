// 请求和响应模型
export type cRequest = Request;

export type cResponse = Response;
export type cNext = (
  req: cRequest,
  res: cResponse,
) => { req: cRequest; res: cResponse } | Promise<{ req: cRequest; res: cResponse }>;
// 中间件函数类型
export type cMiddleware = (req: cRequest, res: cResponse, next: cNext) => ReturnType<cNext>;
