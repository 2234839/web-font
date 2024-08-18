import { createServer } from "net";
import { cNext, cResponse, parseRequest } from "./req_res";
// 状态码文本映射
const statusCodes: Record<number, string> = {
  200: "OK",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
};
// 创建 TCP 服务器
export function createTcpServer(handle: cNext) {
  const server = createServer((socket) => {
    let requestBuffer = "";
    socket.on("data", async (data) => {
      requestBuffer += data.toString();

      // 如果收到请求头的结束标志，则处理请求
      if (requestBuffer.includes("\r\n\r\n")) {
        const req = parseRequest(requestBuffer);
        const res: cResponse = { statusCode: 200, headers: {}, body: "" };
        try {
          // 处理请求
          const { res: newRes } = await handle(req, res);
          // 发送响应
          socket.write(`HTTP/1.1 ${newRes.statusCode} ${statusCodes[newRes.statusCode]}\r\n`);
          Object.entries(newRes.headers).forEach(([key, value]) => {
            socket.write(`${key}: ${value}\r\n`);
          });
          socket.write("\r\n");
          if (typeof newRes.body === "string") {
            socket.write(newRes.body);
          } else {
            socket.write(newRes.body);
          }
          socket.end();
        } catch (error) {
          console.error("[err]", error);
          socket.write("HTTP/1.1 500 Internal Server Error\r\n");
          socket.write("Content-Type: text/plain\r\n");
          socket.write("\r\n");
          socket.write("500 Internal Server Error");
          socket.end();
        } finally {
          requestBuffer = ""; // 重置请求缓冲区
        }
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
    });
  });
  return server;
}
