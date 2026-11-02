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
        /**
         * 不等待 write 回调：LLRT 的 net shim 回调会间歇性丢失，
         * promise 永不 resolve 导致响应写出非确定性挂起（0 bytes / 半截）。
         * 响应体均为小帧（KB 级），socket 缓冲足够；错误由 error 事件兜底。
         */
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        socket.write(buffer);
        return Promise.resolve();
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
      /** 只 end 不 destroy：destroy 会立即丢弃写缓冲中未发送的数据，导致响应截断 */
      socket.end();
    }

    onSocket({ readable, writable, close });
  });
  return server;
}
