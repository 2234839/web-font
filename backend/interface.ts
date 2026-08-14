export let stat: (path: string) => Promise<{
  isFile: () => boolean;
  isDirectory: () => boolean;
  size: number;
  /** 最后修改时间戳（毫秒），用于文件变更检测 */
  mtimeMs: number;
}>;

export let readFile: (path: string) => Promise<Uint8Array>;

export let writeFile: (path: string, data: Uint8Array) => Promise<void>;

export let readdir: (path: string) => Promise<{
  isFile: () => boolean;
  name: string;
}[]>;

export let mkdir: (path: string) => Promise<void>;

export let unlink: (path: string) => Promise<void>;

export let rm: (path: string) => Promise<void>;

/** LLRT 专用：保存 rm 函数引用，避免闭包问题 */
let llrtRm: ((path: string) => Promise<void>) | undefined;

export const implInterface = (options: {
  stat: typeof stat;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  readdir: typeof readdir;
  mkdir: typeof mkdir;
  unlink?: typeof unlink;
  rm?: typeof rm;
}) => {
  stat = options.stat;
  readFile = options.readFile;
  writeFile = options.writeFile;
  readdir = options.readdir;
  mkdir = options.mkdir;
  // 保存 rm 引用到模块级变量
  llrtRm = options.rm;
  /** LLRT 的 fs/promises 没有 unlink，需要用 rm 代替 */
  unlink = async (path) => {
    if (options.unlink) {
      await options.unlink(path);
    } else if (llrtRm) {
      await llrtRm(path);
    }
  };
  /** 同时暴露 rm 方法 */
  rm = async (path) => {
    if (options.rm) {
      await options.rm(path);
    }
  };
};

export function path_join(...paths: string[]) {
  const sep = "/";

  function trimSlashes(p: string) {
    return p.replace(/\/+$/, "").replace(/^\/+/, "");
  }

  /** 将路径按 / 分割并解析 . 和 .. 段 */
  function normalizeSegments(segments: string[]) {
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === "..") {
        resolved.pop();
      } else if (seg !== "." && seg !== "") {
        resolved.push(seg);
      }
    }
    return resolved;
  }

  const isAbsolute = paths[0] && paths[0].startsWith(sep);
  const segments = paths
    .map((path) => trimSlashes(path))
    .join(sep)
    .split(sep);

  const resolved = normalizeSegments(segments);

  if (!resolved.length) return isAbsolute ? sep : ".";

  const result = resolved.join(sep);
  return isAbsolute ? sep + result : result;
}
