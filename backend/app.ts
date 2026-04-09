/** 解析请求 URL（req.url 只有路径，需要补全协议和主机才能用 URL API） */
function parseUrl(req: Request): URL {
  return new URL(req.url, "http://localhost");
}

import { fontSubset } from "./font_util/font";
import type { FontEditor } from "../vendor/fonteditor-core/lib/ttf/font.js";
import { mimeTypes } from "./server/mime_type";
import type { cMiddleware } from "./server/req_res";
import { SimpleHttpServer } from "./server/server";
import { path_join, readFile, stat, readdir, mkdir } from "./interface";
import { enableTempUpload, adminApiKey, fontDirs } from "./config";
import { parseMultipart } from "./multipart";
import { handleTempUpload, handleAdminUpload } from "./upload";

let release_name = globalThis?.process?.release?.name;

let runtimeReady: Promise<void>;
if (release_name === "node" || release_name === "llrt") {
  runtimeReady = import("./server/node").then(() => {});
} else {
  runtimeReady = Promise.resolve();
}
if (release_name === "llrt") {
  runtimeReady = runtimeReady.then(() => import("./server/llrt").then(() => {}));
}
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

/**
 * 在所有字体目录中查找字体文件
 * 匹配优先级：精确匹配 > 前缀匹配 > 包含匹配
 * @returns 找到的字体完整路径，未找到则返回 null
 */
async function findFontPath(filename: string): Promise<string | null> {
  // 先尝试精确匹配
  for (const dir of fontDirs) {
    const filePath = path_join(dir, filename);
    try {
      const s = await stat(filePath);
      if (s.isFile()) return filePath;
    } catch {
      // 继续搜索
    }
  }

  // 收集所有字体文件名（不含扩展名）和完整路径
  const allFonts: Array<{ basename: string; path: string }> = [];
  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(entry.name)) {
          allFonts.push({
            basename: entry.name.replace(/\.[^.]+$/, ""),
            path: path_join(dir, entry.name),
          });
        }
      }
    } catch {
      // 目录不存在，跳过
    }
  }

  const query = filename.replace(/\.[^.]+$/, "").toLowerCase();

  // 前缀匹配
  for (const f of allFonts) {
    if (f.basename.toLowerCase().startsWith(query)) return f.path;
  }

  // 包含匹配
  for (const f of allFonts) {
    if (f.basename.toLowerCase().includes(query)) return f.path;
  }

  return null;
}

/** JSON 响应工具 */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const logMiddleware: cMiddleware = async (req, res, next) => {
  const t1 = Date.now();
  const r = await next(req, res);
  const t2 = Date.now();
  const url = parseUrl(req);
  console.log(`[${t2 - t1}ms] ${req.method} ${url.pathname}`);
  return r;
};

const staticFileMiddleware: cMiddleware = async function (req, res, next) {
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

/** GET /api/fonts — 列出所有可用字体 */
async function handleListFonts(req: Request, res: Response) {
  const allFonts: Array<{ name: string; dir: string }> = [];

  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.isFile() && /\.(ttf|otf|woff|woff2)$/i.test(entry.name)) {
          allFonts.push({ name: entry.name, dir });
        }
      }
    } catch {
      // 目录不存在，跳过
    }
  }

  return { req, res: jsonResponse(allFonts) };
}

/** GET /api/config — 返回公开配置 */
async function handleGetConfig(req: Request, res: Response) {
  return {
    req,
    res: jsonResponse({
      enableTempUpload,
      adminUploadEnabled: !!adminApiKey,
    }),
  };
}

/** POST /api/upload?mode=temp|admin — 上传字体 */
async function handleUpload(req: Request, res: Response) {
  const url = parseUrl(req);
  const mode = url.searchParams.get("mode") ?? "temp";

  const contentType = req.headers.get("Content-Type") ?? "";
  console.log("[upload] mode:", mode, "contentType:", contentType);

  const body = (req as Request & { _bodyBuffer?: ArrayBuffer })._bodyBuffer;
  if (!body || body.byteLength === 0) {
    return { req, res: jsonResponse({ success: false, error: "请求体为空" }, 400) };
  }
  console.log("[upload] body size:", body.byteLength);

  let parsed;
  try {
    parsed = parseMultipart(contentType, body);
    console.log("[upload] parsed files:", parsed.files.length);
  } catch (err) {
    console.log("[upload] parse error:", err);
    return { req, res: jsonResponse({ success: false, error: "无效的 multipart 数据" }, 400) };
  }

  if (!parsed.files || parsed.files.length === 0) {
    return { req, res: jsonResponse({ success: false, error: "未提供文件" }, 400) };
  }

  const file = parsed.files[0];
  console.log("[upload] file:", file.name, "filename:", file.filename, "data size:", file.data.length);

  let result;
  if (mode === "admin") {
    const authHeader = req.headers.get("Authorization") ?? "";
    const apiKey = authHeader.replace("Bearer ", "");
    result = await handleAdminUpload({ data: file.data, filename: file.filename }, apiKey);
    console.log("[upload] admin result:", result);
    return { req, res: jsonResponse(result, result.success ? 200 : 403) };
  }

  // 默认：临时上传
  result = await handleTempUpload({ data: file.data, filename: file.filename });
  console.log("[upload] temp result:", result);
  return { req, res: jsonResponse(result, result.success ? 200 : 400) };
}

/** 字体文件 LRU 缓存，最多保留 3 个最近使用的字体 buffer */
const fontBufferCache = new Map<string, ArrayBuffer>();
const FONT_CACHE_MAX = 3;

/** 从缓存或磁盘读取字体 buffer */
async function readFontBuffer(fontPath: string): Promise<ArrayBuffer> {
  const cached = fontBufferCache.get(fontPath);
  if (cached) {
    /** LRU：命中时移到末尾（最近使用） */
    fontBufferCache.delete(fontPath);
    fontBufferCache.set(fontPath, cached);
    return cached;
  }
  const buffer = new Uint8Array(await readFile(fontPath)).buffer;
  if (fontBufferCache.size >= FONT_CACHE_MAX) {
    /** 淘汰最久未使用的条目 */
    const oldest = fontBufferCache.keys().next().value!;
    fontBufferCache.delete(oldest);
  }
  fontBufferCache.set(fontPath, buffer);
  return buffer;
}

/** GET /api?font=...&text=... — 字体裁剪 */
async function handleFontSubset(req: Request, res: Response) {
  const url = parseUrl(req);
  const params = new URLSearchParams(url.search);
  const font = params.get("font") || "";
  const text = params.get("text") || "";
  if (text.length === 0) {
    return { req, res };
  }

  const fontPath = await findFontPath(font);
  if (!fontPath) {
    return {
      req,
      res: new Response(`Font not found: ${font}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  const fontType = fontPath.split(".").pop() as FontEditor.FontType;
  let oldFontBuffer: ArrayBuffer;
  try {
    oldFontBuffer = await readFontBuffer(fontPath);
  } catch {
    return {
      req,
      res: new Response(`Font read error: ${font}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    };
  }

  /** LLRT 不支持 wasm，默认 ttf；Node.js 默认 woff2（体积更小） */
  const isLlrt = release_name === "llrt";
  const outTypeParam = params.get("outType") || "";
  const outType = (outTypeParam === "woff2" || outTypeParam === "ttf")
    ? (isLlrt && outTypeParam === "woff2" ? "ttf" : outTypeParam)
    : (isLlrt ? "ttf" : "woff2");

  const newFont = await fontSubset(oldFontBuffer, text, {
    outType: outType,
    sourceType: fontType,
  });

  const contentTypes: Record<string, string> = {
    ttf: "font/ttf",
    woff2: "font/woff2",
  };

  return {
    req,
    res: new Response(newFont, {
      status: 200,
      headers: {
        "Content-Type": contentTypes[outType] || "font/ttf",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }),
  };
}

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
  await runtimeReady;
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
