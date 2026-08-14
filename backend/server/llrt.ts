import "web-streams-polyfill/polyfill";
import { implInterface } from "../interface";
import * as fs from "fs/promises";

/**
 * LLRT 的 fs 适配层
 *
 * LLRT 的 fs.readdir 返回字符串数组，需要转换为 { name, isFile } 对象。
 * LLRT 的 fs/promises 没有 unlink 方法，implInterface 中会自动用 rm 代替。
 */
implInterface({
  stat: fs.stat,
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  async readdir(path) {
    const names = await fs.readdir(path);
    return Promise.all(
      names.map(async (name) => {
        const s = await fs.stat(`${path}/${name}`);
        return { name, isFile: () => s.isFile() };
      })
    );
  },
  mkdir: (path) => fs.mkdir(path, { recursive: true }),
  /** LLRT 没有 unlink，用箭头函数包装 rm 避免 this 问题 */
  rm: (path: string) => fs.rm(path),
});
