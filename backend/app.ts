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
import { handleFontDetail } from "./routes/font_detail";
import { handleFontMeta } from "./routes/font_meta";
import { startTempCleaner } from "./temp_cleaner";
import { initMemoryGate } from "./subset_queue";
import { subsetConcurrency } from "./config";
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
    const pathname = url.pathname;
    const filePath = path_join(ROOT_DIR, pathname === "/" ? "index.html" : pathname);
    /** 防止路径穿越：规范化后必须仍在 dist 目录内 */
    if (!filePath.startsWith(ROOT_DIR + "/") && filePath !== ROOT_DIR) {
      newRes = new Response("403 Forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
      return next(req, newRes);
    }
    try {
      /**
       * 解析静态文件路径，处理三种情况：
       * 1. 精确文件（如 /assets/app.js）→ 直接返回
       * 2. 目录（如 /demo）→ 尝试 目录/index.html（SSG 子路由预渲染产物）
       * 3. 不存在（如 SPA 动态路由 /blog/123）→ fallback 到根 index.html
       */
      let resolvedPath = filePath;
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        resolvedPath = path_join(filePath, "index.html");
        await stat(resolvedPath);
      }
      const fileContent = await readFile(resolvedPath);
      const extname = resolvedPath.split(".").pop() ?? "";
      newRes = new Response(fileContent, {
        status: 200,
        headers: {
          "Content-Type": mimeTypes[extname] || "application/octet-stream",
          "Content-Length": `${fileContent.byteLength}`,
        },
      });
    } catch {
      /**
       * 字体详情页 SSR：/fonts/xxx 路径无预渲染文件时，
       * 读取 SSG 模板替换占位符后返回完整 HTML。
       * handleFontDetail 返回 null 时继续走 SPA fallback。
       */
      if (pathname.startsWith("/fonts/")) {
        const ssrResponse = await handleFontDetail(pathname);
        if (ssrResponse) {
          newRes = ssrResponse;
          return next(req, newRes);
        }
      }
      /**
       * 文件/目录不存在 → SPA fallback：返回根 index.html，
       * 交给前端 vue-router 接管路由（支持未预渲染的动态路由）。
       * 带后缀的请求（.js/.css 等静态资源）不 fallback，直接 404。
       */
      const hasExt = /\.[^/]+$/.test(pathname);
      if (hasExt) {
        newRes = new Response("404 Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } else {
        const fallbackContent = await readFile(path_join(ROOT_DIR, "index.html"));
        newRes = new Response(fallbackContent, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": `${fallbackContent.byteLength}`,
          },
        });
      }
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
  if (url.pathname === "/api/font-meta" && req.method === "GET") {
    return handleFontMeta(req, res);
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

  /** 初始化子集化并发队列（含字体分组调度） */
  initMemoryGate(subsetConcurrency);

  /** 启动临时字体定时清理器 */
  startTempCleaner();
}

main();
