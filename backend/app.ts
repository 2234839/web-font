import { fontSubset } from "./font_util/font";
import { mimeTypes } from "./server/mime_type";
import type { cMiddleware } from "./server/req_res";
import { SimpleHttpServer } from "./server/server";
import { path_join, readFile, stat } from "./interface";
let release_name = global.tjs ? "tjs" : globalThis?.process?.release?.name;

if (release_name === "tjs") {
  import("./server/tjs");
} else if (release_name === "node" || release_name === "llrt") {
  import("./server/node");
}
if (release_name === "llrt") {
  import("./server/llrt");
}
const ROOT_DIR = "dist"; // 静态文件目录

const logMiddleware: cMiddleware = async (req, res, next) => {
  const t1 = Date.now();
  const r = await next(req, res);
  const t2 = Date.now();
  console.log(`[${t2 - t1}ms] ${req.url.split("?")[0]}`);
  return r;
};

const staticFileMiddleware: cMiddleware = async function (req, res, next) {
  let newRes: Response;
  if (req.method === "GET") {
    const url = new URL(req.url);
    const filePath = path_join(ROOT_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    try {
      const stats = await stat(filePath);

      if (stats.isFile()) {
        const fileContent = await readFile(filePath);
        const extname = filePath.split(".").pop() ?? "";
        newRes = new Response(fileContent, {
          status: 200,
          headers: {
            "Content-Type": mimeTypes[extname] || "application/octet-stream",
            "Content-Length": `${stats.size}`,
          },
        });
      } else {
        // 文件不存在
        newRes = new Response("404 Not Found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }
    } catch (err) {
      console.log("[err]", err);
      // @ts-ignore
      newRes = new Response(`服务器内部错误 Not Found\n${err}\n${err.stack}`, {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  } else {
    newRes = new Response("Method Not Allowed", {
      status: 405,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
  return next(req, newRes);
};
const corsMiddleware: cMiddleware = async (req, res, next) => {
  // 如果是 OPTIONS 请求（预检请求），直接返回成功响应
  if (req.method === "OPTIONS") {
    // 直接结束请求，不继续传递到下一个中间件
    return {
      req,
      res: new Response("", {
        status: 204,
        headers: {
          "Content-Length": "0",
        },
      }),
    };
  } else {
    const newRes = await next(req, res);
    // 允许所有域跨域请求
    newRes.res.headers.append("Access-Control-Allow-Origin", "*");
    // 如果你只想允许特定域名：
    // res.headers["Access-Control-Allow-Origin"] = "https://example.com";
    // 允许常见的 HTTP 方法
    newRes.res.headers.append("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    // 允许的请求头
    newRes.res.headers.append("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return newRes;
  }
};
const fontApiMiddleware: cMiddleware = async (req, res, next) => {
  // 创建一个新的 URL 对象（需要一个完整的 URL，必须包含协议和主机）
  const url = new URL(req.url, "http://test.com");
  if (!url.pathname.startsWith("/api")) return next(req, res);
  const params = new URLSearchParams(url.search);
  const font = params.get("font") || "";
  const text = params.get("text") || "";
  if (text.length === 0) {
    return { req, res };
  }
  const path = `font/${font}`;
  const fontType = path.split(".").pop() as "ttf";
  const oldFontBuffer = new Uint8Array(await readFile(path)).buffer;

  const outType = "ttf";
  const newFont = await fontSubset(oldFontBuffer, text, {
    outType: outType,
    sourceType: fontType,
  });

  return {
    req,
    res: new Response(newFont, {
      status: 200,
      headers: {
        "Content-Type": "font/ttf",
      },
    }),
  };
};

const server = new SimpleHttpServer({ port: 8087 });
server.use(
  logMiddleware,
  // limitMiddleware,
  corsMiddleware,
  fontApiMiddleware,
  staticFileMiddleware,
);
