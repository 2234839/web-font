import { implInterface } from "../interface";
import * as fs from "fs/promises";

/**
 * 不再引入 web-streams-polyfill：polyfill 覆盖原生 ReadableStream/WritableStream
 * 后，与 LLRT 原生 socket/net 的组合会出现非确定性写挂起、数据串扰
 * （响应 body 混入别的连接的 HTTP 头）等问题；LLRT 自带 WHATWG streams。

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
