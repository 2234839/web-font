import { cMiddleware, cRequest, cResponse, type cNext } from "./req_res";
// 配置
// 路由器类
export class cRouter {
  private middleware: cMiddleware[] = [];

  use(middleware: cMiddleware) {
    this.middleware.push(middleware);
    return this;
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
    let release_name = global.tjs ? "tjs" : globalThis?.process?.release?.name;
    console.log("[release.name]", release_name);
    if (global.tjs) {
      this.tjsServer(options);
      return this;
    }
    if (release_name === "llrt" || release_name == "node") {
      import("./tcp_server").then((m) => {
        const server = m.createTcpServer((socket) => {
          connectionHandle(socket, (req, res) => this.router.handle(req, res));
        });
        server.listen(options.port, options.hostname, () => {
          console.log(`Server is listening on port ${options.port}`);
        });
      });
    }
  }
  private async tjsServer(options: { port: number; hostname?: string }) {
    const listener = (await global.tjs.listen(
      "tcp",
      options.hostname ?? "::",
      options.port,
      {},
    )) as tjs.Listener;
    console.log(`Server is listening on port ${options.port}`);
    for await (const connection of listener) {
      connectionHandle(connection, this.router.handle.bind(this.router));
    }
  }
  use(...middlewares: cMiddleware[]) {
    middlewares.forEach((middleware) => this.router.use(middleware));
    return this;
  }
}
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
// 请求头终止符
const target = encoder.encode("\r\n\r\n");
async function connectionHandle(
  connection: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close: () => void;
  },
  handle: cNext,
) {
  // connection.readable.
  const { header, body } = await createStreamAfterTarget(connection.readable, target);
  if (!header) {
    return;
  }
  const httpHeaderText = decoder.decode(header);
  const httpHeader = parseHttpRequest(httpHeaderText);
  const rawReq = new Request("http://" + httpHeader.headers["Host"] + httpHeader.url, {
    method: httpHeader.method,
    body: httpHeader.method === "GET" || httpHeader.method === "HEAD" ? undefined : body,
    headers: httpHeader.headers,
  });
  const rawRes = new Response();

  const { req, res } = await handle(rawReq, rawRes);
  const resWriter = connection.writable.getWriter();
  let headerText: string[] = [];
  res.headers.forEach((value, key) => {
    headerText.push(`${key}: ${value}`);
  });
  const resHeaertText = `HTTP/1.1 ${res.status} OK\r\n${headerText.join("\r\n")}\r\n\r\n`;
  await resWriter.write(encoder.encode(resHeaertText));
  if (res.body) {
    // node 运行时
    // 释放写入器的锁定
    resWriter.releaseLock();
    console.log("[connection.writable.locked]", connection.writable.locked);
    // https://github.com/saghul/txiki.js/issues/646
    await res.body?.pipeTo(connection.writable);
  } else {
    // @ts-expect-error
    if (res._bodyInit) {
      // tjs 运行时
      // @ts-expect-error
      await resWriter.write(res._bodyInit);
    } else {
      // llrt 运行时
      const buffer = new Uint8Array(await (await res.blob()).arrayBuffer());
      await resWriter.write(buffer);
    }
  }
  if (!resWriter.closed) {
    await resWriter.close();
  }
  connection.close();
}

function parseHttpRequest(requestText: string) {
  const lines = requestText.trim().split("\n");
  if (lines.length === 0) {
    throw new Error("Invalid HTTP request");
  }

  // 解析请求行
  const [method, url, httpVersion] = lines[0].split(" ");

  // 解析头部
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") break; // 空行表示头部结束

    const [key, ...valueParts] = line.split(":");
    const value = valueParts.join(":").trim();
    headers[key.trim()] = value;
  }

  return {
    method,
    url,
    httpVersion,
    headers,
  };
}
async function createStreamAfterTarget(
  originalStream: ReadableStream<Uint8Array>,
  target: Uint8Array,
) {
  const reader = originalStream.getReader();
  let buffer = new Uint8Array();

  // Function to check if target is found in the buffer
  function containsTarget(buffer: Uint8Array, target: Uint8Array): number {
    for (let i = 0; i <= buffer.length - target.length; i++) {
      if (buffer.slice(i, i + target.length).every((value, index) => value === target[index])) {
        return i;
      }
    }
    return -1;
  }
  let controller = null as unknown as ReadableStreamDefaultController<Uint8Array>;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      controller.close();
      break; // Stream ended
    }
    if (controller) {
      controller.enqueue(value);
      continue;
    }
    // Append the new chunk to the buffer
    const newBuffer = new Uint8Array(buffer.length + value.length);
    newBuffer.set(buffer);
    newBuffer.set(value, buffer.length);
    buffer = newBuffer;

    // Check if the target is found in the buffer
    const targetIndex = containsTarget(buffer, target);
    if (targetIndex !== -1) {
      // Found the target data, return the remaining buffer after the target data
      const start = targetIndex + target.length;
      const header = buffer.slice(0, start);
      const remainingData = buffer.slice(start);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          controller.enqueue(remainingData);
        },
      });
      // Create a new stream from the remaining data
      return {
        header,
        body,
      };
    }
  }
  return { header: null, body: new ReadableStream<Uint8Array>() }; // Return an empty stream if the target is not found
}
