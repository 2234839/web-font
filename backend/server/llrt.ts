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
        return { name, isFile: () => s.isFile(), isDirectory: () => s.isDirectory() };
      })
    );
  },
  mkdir: async (path) => {
    await fs.mkdir(path, { recursive: true });
  },
  /** LLRT 没有 unlink，用 rm 代替，忽略返回值 */
  rm: async (path: string) => {
    await fs.rm(path);
  },
});
