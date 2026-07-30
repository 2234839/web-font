export let stat: (path: string) => Promise<{
  isFile: () => boolean;
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

export const implInterface = (options: {
  stat: typeof stat;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  readdir: typeof readdir;
  mkdir: typeof mkdir;
  unlink: typeof unlink;
}) => {
  stat = options.stat;
  readFile = options.readFile;
  writeFile = options.writeFile;
  readdir = options.readdir;
  mkdir = options.mkdir;
  unlink = options.unlink;
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
