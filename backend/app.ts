import { mimeTypes } from "./server/mime_type";
import type { cMiddleware } from "./server/req_res";
import { SimpleHttpServer } from "./server/server";
import { path_join, readFile, stat, mkdir } from "./interface";
import { parseUrl, jsonResponse, stats, initStats, markStatsDirty } from "./shared";
import { flushStatsSyncSafe } from "./stats_store";
import { enableTempUpload, adminApiKey } from "./config";
import { handleListFonts } from "./routes/fonts";
import { handleGetConfig } from "./routes/config";
import { handleStats } from "./routes/stats";
import { handleUpload } from "./routes/upload";
import { handleFontSubset } from "./routes/subset";
import "./server/node";
import "./server/llrt";

const ROOT_DIR = "dist";

/** 启动时确保必要目录存在 */
async function ensureDirectories() {
  for (const dir of ["font/temp", "font/admin"]) {
    try {
      await stat(dir);
    } catch {
      await mkdir(dir);
    }
  }
}

const logMiddleware: cMiddleware = async (req, res, next) => {
  stats.totalRequests++;
  markStatsDirty();
  const t1 = Date.now();
  const r = await next(req, res);
  const t2 = Date.now();
  const url = parseUrl(req);
  console.log(`[${t2 - t1}ms] ${req.method} ${url.pathname}`);
  return r;
};

const staticFileMiddleware: cMiddleware = async function (req, _res, next) {
  let newRes: Response;
  if (req.method === "GET") {
    const url = parseUrl(req);
    const filePath = path_join(ROOT_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    /** 防止路径穿越：规范化后必须仍在 dist 目录内 */
    if (!filePath.startsWith(ROOT_DIR + "/") && filePath !== ROOT_DIR) {
      newRes = new Response("403 Forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
      return next(req, newRes);
    }
    try {
      const fileStat = await stat(filePath);

      if (fileStat.isFile()) {
        const fileContent = await readFile(filePath);
        const extname = filePath.split(".").pop() ?? "";
        newRes = new Response(fileContent, {
          status: 200,
          headers: {
            "Content-Type": mimeTypes[extname] || "application/octet-stream",
            "Content-Length": `${fileStat.size}`,
          },
        });
      } else {
        newRes = new Response("404 Not Found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      }
    } catch (err) {
      console.log("[err]", err);
      newRes = new Response("500 Internal Server Error", {
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
  if (req.method === "OPTIONS") {
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
    newRes.res.headers.append("Access-Control-Allow-Origin", "*");
    newRes.res.headers.append("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    newRes.res.headers.append("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return newRes;
  }
};

/** 统一的 API 路由中间件 */
const fontApiMiddleware: cMiddleware = async (req, res, next) => {
  const url = parseUrl(req);
  if (!url.pathname.startsWith("/api")) return next(req, res);

  if (url.pathname === "/api/fonts" && req.method === "GET") {
    return handleListFonts(req, res);
  }
  if (url.pathname === "/api/config" && req.method === "GET") {
    return handleGetConfig(req, res);
  }
  if (url.pathname === "/api/stats" && req.method === "GET") {
    return handleStats(req, res);
  }
  if (url.pathname === "/api/upload" && req.method === "POST") {
    return handleUpload(req, res);
  }
  if (url.pathname === "/api" && req.method === "GET") {
    return handleFontSubset(req, res);
  }

  return next(req, res);
};

/** 上传文件大小限制 50MB */
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

const uploadSizeMiddleware: cMiddleware = async (req, res, next) => {
  if (req.method === "POST" && parseUrl(req).pathname === "/api/upload") {
    const contentLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
    if (contentLength > MAX_UPLOAD_SIZE) {
      return {
        req,
        res: jsonResponse({ success: false, error: "文件过大，最大 50MB" }, 413),
      };
    }
  }
  return next(req, res);
};

async function main() {
  /** 最早期恢复累计计数：之后的请求计数会累加在历史值之上 */
  await initStats();

  /** 优雅退出时尽力落盘最后一次增量（SIGKILL 时由定时器兜底） */
  globalThis.process?.on?.("beforeExit", () => {
    markStatsDirty();
    flushStatsSyncSafe();
  });

  await ensureDirectories();

  const server = new SimpleHttpServer({ port: 8087 });
  server.use(
    logMiddleware,
    corsMiddleware,
    uploadSizeMiddleware,
    fontApiMiddleware,
    staticFileMiddleware,
  );
  console.log("[config] temp upload:", enableTempUpload);
  console.log("[config] admin upload:", !!adminApiKey);
}

main();
