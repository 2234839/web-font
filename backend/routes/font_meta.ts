import { extractFontMeta, META_VERSION, type FontUserConfig } from "../font_util/font_meta.js";
import { parseUrl, jsonResponse, findFontPath, readFontBuffer } from "../shared";
import { readFile, writeFile, stat } from "../interface";
import { withMemoryGate } from "../subset_queue";
import { subsetQueueTimeoutSeconds } from "../config";

/**
 * 字体元数据路由 —— 分为两层：
 *
 * 1. 自动提取层（info + coverage + ranges）：从字体二进制解析 cmap、name 表，
 *    结果持久化到 .meta.json。字体文件不变则只需计算一次。
 *
 * 2. 人工配置层（config）：来自 font/font-config.json，用户可随时编辑。
 *    启动时加载一次到内存，每次请求用 stat mtime 廉价检测变更，mtime 变了才重新读取。
 */

/** 进程内缓存（自动提取的元数据），key = fontPath */
const metaCache = new Map<string, ReturnType<typeof extractFontMeta>>();

/** 人工配置缓存状态 */
const CONFIG_PATH = "font/font-config.json";
let userConfigMap: Record<string, FontUserConfig> = {};
let configMtime = 0;

/**
 * 检查并刷新人工配置。
 * 通过 stat mtime 检测文件变更——mtime 不变则直接跳过（零 IO 读取），
 * mtime 变了才重新 readFile。这样编辑 font-config.json 后下个请求即生效。
 */
async function refreshUserConfig(): Promise<void> {
  try {
    const s = await stat(CONFIG_PATH);
    if (s.isFile() && s.size > 0 && s.mtimeMs !== configMtime) {
      configMtime = s.mtimeMs;
      const raw = await readFile(CONFIG_PATH);
      userConfigMap = JSON.parse(new TextDecoder().decode(raw));
    }
  } catch {
    /** 文件不存在或不可访问，使用空配置 */
  }
}

/**
 * 从字体文件名提取 basename（去掉目录前缀），用于匹配 font-config.json 的 key。
 * font-config.json 的 key 是纯文件名，如 "思源黑体.ttf"
 */
function fontBasename(fontPath: string): string {
  const parts = fontPath.split("/");
  return parts[parts.length - 1];
}

/**
 * 获取 .meta.json 缓存文件路径（字体同目录）
 * font/admin/思源黑体.ttf → font/admin/思源黑体.ttf.meta.json
 */
function metaFilePath(fontPath: string): string {
  return fontPath + ".meta.json";
}

/**
 * 尝试从磁盘读取缓存的元数据 JSON。
 * 解析失败返回 null（安全降级，触发重新计算）。
 */
async function loadMetaFromDisk(fontPath: string): Promise<ReturnType<typeof extractFontMeta> | undefined> {
  try {
    const raw = await readFile(metaFilePath(fontPath));
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
}

/**
 * 将元数据写入磁盘缓存。
 * 写入失败不影响请求结果（元数据已计算好，下次还能从进程内存命中）。
 */
async function saveMetaToDisk(fontPath: string, meta: ReturnType<typeof extractFontMeta>): Promise<void> {
  try {
    await writeFile(metaFilePath(fontPath), new TextEncoder().encode(JSON.stringify(meta)));
  } catch {}
}

/** GET /api/font-meta?font=字体名 — 返回字体字符覆盖率、支持的 codepoint 区间、字体基本信息、人工配置 */
export async function handleFontMeta(req: Request, _res: Response) {
  const url = parseUrl(req);
  const params = new URLSearchParams(url.search);
  const fontName = params.get("font") || "";

  if (!fontName) {
    return { req, res: jsonResponse({ error: "缺少 font 参数" }, 400) };
  }

  const fontPath = await findFontPath(fontName);
  if (!fontPath) {
    return { req, res: jsonResponse({ error: `字体不存在: ${fontName}` }, 404) };
  }

  /** 检查人工配置是否有更新（stat mtime 变了才重新读取） */
  await refreshUserConfig();

  /** 1. 进程内存命中 */
  let meta = metaCache.get(fontPath);
  if (!meta) {
    /** 2. 磁盘 .meta.json 命中（版本指纹不匹配则视为 miss，重新计算） */
    meta = await loadMetaFromDisk(fontPath);
    if (meta && meta.metaVersion === META_VERSION) {
      metaCache.set(fontPath, meta);
    } else {
      meta = undefined;
    }
  }

  /** 3. 首次请求 —— 解析 cmap + name 表计算元数据（CPU/内存密集，复用子集化并发闸门） */
  if (!meta) {
    /** 排队超时，返回 503 让客户端重试 */
    const result = await withMemoryGate(
      async () => {
        const fontBuffer = await readFontBuffer(fontPath);
        return extractFontMeta(fontBuffer);
      },
      subsetQueueTimeoutSeconds * 1000,
      fontPath,
    );

    if (result === null) {
      return {
        req,
        res: new Response("Server busy, please retry", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Retry-After": "1",
          },
        }),
      };
    }

    meta = result;
    metaCache.set(fontPath, meta);
    /** 异步写盘，不阻塞响应 */
    saveMetaToDisk(fontPath, meta);
  }

  /** 合并人工配置（实时读取，不缓存——用户随时可能编辑 font-config.json） */
  const config = userConfigMap[fontBasename(fontPath)] ?? undefined;

  return { req, res: jsonResponse({ ...meta, config }) };
}
