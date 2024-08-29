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
        socket.on("data", (chunk) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        socket.on("error", (err) => {
          controller.error(err);
        });
        socket.on("close", () => {
          controller.close();
        });
      },
      cancel() {
        socket.destroy();
      },
    });

    // 创建 WritableStream
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) => {
          socket.write(chunk, (err) => {
            if (err) reject(err);
            else resolve();
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
