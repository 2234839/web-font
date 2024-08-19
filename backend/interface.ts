export let stat: (path: string) => Promise<{
  isFile: () => boolean;
  size: number;
}>;

export let readFile: (path: string) => Promise<Uint8Array>;

export const implInterface = (options: { stat: typeof stat; readFile: typeof readFile }) => {
  stat = options.stat;
  readFile = options.readFile;
};

export function path_join(...paths: string[]) {
  // 定义路径分隔符
  const sep = "/";

  // 函数用来移除路径片段两端的斜杠
  function trimSlashes(p: string) {
    return p.replace(/\/+$/, "").replace(/^\/+/, "");
  }

  // 处理路径片段
  let result = paths
    .map((path) => trimSlashes(path)) // 移除每个路径片段的前后斜杠
    .filter(Boolean) // 过滤掉空片段
    .join(sep); // 使用分隔符连接路径片段

  // 如果最终路径为空，返回根路径
  if (!result) return sep;

  // 确保路径以分隔符开头
  if (paths[0] && paths[0].startsWith(sep)) {
    result = sep + result;
  }

  return result;
}
