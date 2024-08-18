import { cMiddleware, cRequest, cResponse } from "./req_res";
import { createTcpServer } from "./tcp_server";
// 配置

// 路由器类
export class cRouter {
  private middleware: cMiddleware[] = [];

  use(middleware: cMiddleware) {
    this.middleware.push(middleware);
    return this
  }

  async handle(req: cRequest, res: cResponse) {
    let index = -1;
    const next = async (req: cRequest, res: cResponse) => {
      index += 1;
      // console.log(`开始执行第 ${index} ${this.middleware[index]?.name} 中间件`);
      const r = (await this.middleware[index]?.(req, res, next)) ?? { req, res };
      // console.log(`执行完毕第 ${index} 中间件`);

      return r;
    };
    return next(req, res);
  }
}

// 实现一个简化的 HTTP 服务器
export class SimpleHttpServer {
  private router: cRouter = new cRouter();

  constructor(options: { port: number; hostname?: string }) {
    const server = createTcpServer((req, res) => {
      const r = this.router.handle(req, res);
      return r;
    });
    server.listen(options.port, options.hostname, () => {
      console.log(`Server is listening on port ${options.port}`);
    });
  }

  use(...middlewares: cMiddleware[]) {
    middlewares.forEach((middleware) => this.router.use(middleware));
    return this;
  }
}
