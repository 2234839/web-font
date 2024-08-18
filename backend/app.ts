import fs, { readFile } from "fs/promises";
import * as path from "path";
import { fontSubset } from "./font_util/font";
import { mimeTypes } from "./server/mime_type";
import type { cMiddleware } from "./server/req_res";
import { SimpleHttpServer } from "./server/server";
const ROOT_DIR = path.resolve("dist"); // 静态文件目录
const staticFileMiddleware: cMiddleware = async function (req, res, next) {
  if (req.method === "GET") {
    const filePath = path.join(ROOT_DIR, req.url === "/" ? "index.html" : req.url);

    try {
      const stats = await fs.stat(filePath);

      if (stats.isFile()) {
        const fileContent = await fs.readFile(filePath);
        const extname = path.extname(filePath);
        res.statusCode = 200;
        res.headers["Content-Type"] = mimeTypes[extname] || "application/octet-stream";
        res.headers["Content-Length"] = `${stats.size}`;
        res.body = fileContent;
      } else {
        // 文件不存在
        res.statusCode = 404;
        res.headers["Content-Type"] = "text/plain";
        res.body = "404 Not Found";
      }
    } catch (err) {
      // 错误处理
      res.statusCode = 404;
      res.headers["Content-Type"] = "text/plain";
      res.body = `404 Not Found`;
    }
  } else {
    // 返回 405 Method Not Allowed
    res.statusCode = 405;
    res.headers["Content-Type"] = "text/plain";
    res.body = "Method Not Allowed";
  }
  return next(req, res);
};
const logMiddleware: cMiddleware = async (req, res, next) => {
  const t1 = Date.now();
  const r = await next(req, res);
  const t2 = Date.now();
  console.log(`[${t2 - t1}ms] ${req.url}`);
  return r;
};
const corsMiddleware: cMiddleware = async (req, res, next) => {
  // 允许所有域跨域请求
  res.headers["Access-Control-Allow-Origin"] = "*";
  // 如果你只想允许特定域名：
  // res.headers["Access-Control-Allow-Origin"] = "https://example.com";
  // 允许常见的 HTTP 方法
  res.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
  // 允许的请求头
  res.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";

  // 如果是 OPTIONS 请求（预检请求），直接返回成功响应
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.headers["Content-Length"] = "0";
    res.body = "";
    // 直接结束请求，不继续传递到下一个中间件
    return { req, res };
  } else {
    return next(req, res);
  }
};
const fontCache: { [key: string]: any } = {};
const ttfCache: { [key: string]: any } = {};
const fontApiMiddleware: cMiddleware = async (req, res, next) => {
  if (!req.url.startsWith("/api")) return next(req, res);
  res.statusCode = 200;
  res.headers["Content-Type"] = "font/ttf";
  // 创建一个新的 URL 对象（需要一个完整的 URL，必须包含协议和主机）
  const url = new URL(req.url, "http://test.com");
  // 使用 URLSearchParams 来解析查询参数
  const params = new URLSearchParams(url.search);
  // 获取参数的值
  const font = params.get("font") || "";
  const text = params.get("text") || "";
  const path = `font/${font}`;
  const fontType = path.split(".").pop() as "ttf";
  if (ttfCache[req.url]) {
    // @ts-ignore
    res.body = ttfCache[req.url];
    return { req, res };
  }
  const oldFontBuffer = fontCache[path] ?? new Uint8Array(await readFile(path)).buffer;
  fontCache[path] = oldFontBuffer;

  const outType = "ttf";
  const newFont = await fontSubset(oldFontBuffer, text, {
    outType: outType,
    sourceType: fontType,
  });
  // @ts-ignore
  res.body = newFont;
  ttfCache[req.url] = newFont;
  return { req, res };
};
const server = new SimpleHttpServer({ port: 8087 });
server.use(logMiddleware, corsMiddleware, fontApiMiddleware, staticFileMiddleware);

// const main = async () => {
//   // const path = "backend/问藏书房.ttf"; //问藏书房
//   const path = "backend/令东齐伋复刻体.ttf";
//   //   const path = "./backend/GoodHood-2.otf";//英文字体
//   const fontType = path.split(".").pop() as "ttf";
//   const oldFontBuffer = new Uint8Array(await readFile(path)).buffer;
//   const outType = "ttf";
//   const newFont = await fontSubset(oldFontBuffer, "abc问书房令东齐伋复刻体", {
//     outType: outType,
//     sourceType: fontType,
//   });
//   writeFile(`./public/font.${outType}`, newFont);
// };
