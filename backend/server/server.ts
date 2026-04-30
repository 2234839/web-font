import { cMiddleware, cRequest, cResponse, type cNext } from "./req_res";
import { createTcpServer } from "./tcp_server";
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
    const release_name = globalThis?.process?.release?.name;
    console.log("[release.name]", release_name);
    if (release_name === "llrt" || release_name === "node") {
      const server = createTcpServer((socket) => {
        connectionHandle(socket, (req, res) => this.router.handle(req, res));
      });
      server.listen(options.port, options.hostname, () => {
        console.log(`Server is listening on port ${options.port}`);
      });
    }
  }
  use(...middlewares: cMiddleware[]) {
    middlewares.forEach((middleware) => this.router.use(middleware));
    return this;
  }
}
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** 合并多个 Uint8Array 为单个 ArrayBuffer */
function mergeChunks(chunks: Uint8Array[], totalLength: number): ArrayBuffer {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength);
}

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
  try {
    const { header, body } = await createStreamAfterTarget(connection.readable, target);
    if (!header) {
      return;
    }
    const httpHeaderText = decoder.decode(header);
    const httpHeader = parseHttpRequest(httpHeaderText);
    const hasBody = httpHeader.method !== "GET" && httpHeader.method !== "HEAD";
    /** 大小写不敏感查找 header */
    const getHeader = (name: string) => {
      const lower = name.toLowerCase();
      for (const key of Object.keys(httpHeader.headers)) {
        if (key.toLowerCase() === lower) return httpHeader.headers[key];
      }
      return undefined;
    };
    /** 读取请求体 */
    let bodyArrayBuffer: ArrayBuffer | undefined;
    if (hasBody && body) {
      const contentLength = parseInt(getHeader("Content-Length") ?? "0", 10);
      if (contentLength > 0) {
        /** 根据 Content-Length 读取指定长度的 body */
        const chunks: Uint8Array[] = [];
        let received = 0;
        for await (const chunk of body) {
          chunks.push(chunk);
          received += chunk.length;
          if (received >= contentLength) break;
        }
        body.cancel?.();
        bodyArrayBuffer = mergeChunks(chunks, received);
      } else if (getHeader("Transfer-Encoding") === "chunked") {
        /** 解码 chunked transfer encoding */
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        const chunkBuf: number[] = [];
        let state: "size" | "data" | "crlf_after_data" = "size";
        let chunkSize = 0;
        let dataRead = 0;
        let goto_done = false;
        for await (const rawChunk of body) {
          for (const byte of rawChunk) {
            switch (state) {
              case "size": {
                if (byte === 13) continue; // \r
                if (byte === 10) {
                  // \n — size 行结束
                  const sizeStr = new TextDecoder().decode(new Uint8Array(chunkBuf)).trim();
                  chunkSize = parseInt(sizeStr, 16);
                  chunkBuf.length = 0;
                  if (chunkSize === 0) {
                    state = "crlf_after_data"; // 最后一个空行
                  } else {
                    state = "data";
                    dataRead = 0;
                  }
                } else {
                  chunkBuf.push(byte);
                }
                break;
              }
              case "data": {
                chunkBuf.push(byte);
                dataRead++;
                if (dataRead >= chunkSize) {
                  const data = new Uint8Array(chunkBuf);
                  chunks.push(data);
                  totalLength += data.length;
                  chunkBuf.length = 0;
                  state = "crlf_after_data";
                }
                break;
              }
              case "crlf_after_data": {
                // 跳过 trailing \r\n
                if (byte === 10) {
                  if (chunkSize === 0) {
                    // 结束标记后的 \n
                    state = "size";
                    goto_done = true;
                  } else {
                    state = "size";
                  }
                }
                break;
              }
            }
            if (goto_done) break;
          }
          if (goto_done) break;
        }
        if (totalLength > 0) {
          bodyArrayBuffer = mergeChunks(chunks, totalLength);
        }
        body.cancel?.();
      } else {
        /** 无 Content-Length 且非 chunked，暂不处理 */
      }
    }
    const rawReq = new Request("http://" + (getHeader("Host") ?? "localhost") + httpHeader.url, {
      method: httpHeader.method,
      headers: httpHeader.headers,
    });
    /** 将 body 数据挂到 request 对象上，供中间件直接读取 */
    (rawReq as Request & { _bodyBuffer?: ArrayBuffer })._bodyBuffer = bodyArrayBuffer;
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
      /** node 运行时 */
      resWriter.releaseLock();
      await res.body?.pipeTo(connection.writable);
    } else {
      /** llrt 运行时 */
      const buffer = new Uint8Array(await (await res.blob()).arrayBuffer());
      await resWriter.write(buffer);
    }
    if (!resWriter.closed) {
      await resWriter.close();
    }
    connection.close();
  } catch (err) {
    console.log("[connectionHandle error]", err);
    try { connection.close(); } catch { /* ignore */ }
  }
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
    if (line === "" || line === "\r") break; // 空行表示头部结束

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    headers[key] = value;
  }

  return {
    method,
    url,
    httpVersion,
    headers,
  };
}
function createStreamAfterTarget(
  originalStream: ReadableStream<Uint8Array>,
  target: Uint8Array,
): Promise<{ header: Uint8Array | null; body: ReadableStream<Uint8Array> }> {
  const reader = originalStream.getReader();
  let buffer = new Uint8Array();

  function containsTarget(buf: Uint8Array, tgt: Uint8Array): number {
    for (let i = 0; i <= buf.length - tgt.length; i++) {
      if (buf.slice(i, i + tgt.length).every((value, index) => value === tgt[index])) {
        return i;
      }
    }
    return -1;
  }

  return new Promise((resolve) => {
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          resolve({ header: null, body: new ReadableStream<Uint8Array>() });
          return;
        }
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        const targetIndex = containsTarget(buffer, target);
        if (targetIndex === -1) {
          pump();
          return;
        }
        const start = targetIndex + target.length;
        const header = buffer.slice(0, start);
        const remainingData = buffer.slice(start);

        /** body stream：先写入剩余数据，然后在后台继续从 originalStream 读取 */
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            if (remainingData.length > 0) {
              controller.enqueue(remainingData);
            }
            /** 后台继续读取 originalStream 并转发到 body stream */
            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) { controller.close(); return; }
                  controller.enqueue(value);
                }
              } catch (err) {
                /** body stream 被消费方 cancel 时预期会抛错 */
                console.log("[createStreamAfterTarget] body stream closed:", err);
              }
            })();
          },
        });
        resolve({ header, body });
      });
    }
    pump();
  });
}
