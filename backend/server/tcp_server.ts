import { createServer } from "net";

// 创建 TCP 服务器
export function createTcpServer(
  onSocket: (socket: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close: () => void;
  }) => void,
) {
  const server = createServer((socket) => {
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        socket.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        socket.on("error", (err) => {
          /** error 后 close 事件仍会触发，这里只终止读取侧 */
          try {
            controller.error(err);
          } catch {
            /** controller 已结束（如 cancel 先到），忽略 */
          }
        });
        socket.on("close", () => {
          /** 客户端断连时 controller 可能已被 error/cancel 关闭，重复 close 会抛未捕获异常打死进程 */
          try {
            controller.close();
          } catch {
            /** 已关闭，忽略 */
          }
        });
      },
      cancel() {
        socket.destroy();
      },
    });

    // 创建 WritableStream
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          socket.write(buffer, (err) => {
            if (err) {
              /** EPIPE：客户端已断开，销毁连接而非让异常向上冒泡打死进程 */
              if ((err as NodeJS.ErrnoException).code === "EPIPE") {
                socket.destroy();
                resolve();
              } else {
                reject(err);
              }
            } else {
              resolve();
            }
          });
        });
      },
      close() {
        socket.end();
      },
      abort(reason) {
        socket.destroy(reason);
      },
    });

    // 实现 close 方法
    function close() {
      socket.end();
      socket.destroy();
    }

    onSocket({ readable, writable, close });
  });
  return server;
}
