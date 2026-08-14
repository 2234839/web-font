import { implInterface } from "../interface";
import { stat as fsStat, readFile, writeFile, readdir as fsReaddir, mkdir, unlink, rm } from "fs/promises";

implInterface({
  async stat(path) {
    const r = await fsStat(path);
    return { ...r, isDirectory: () => r.isDirectory() };
  },
  readFile(path) {
    return readFile(path);
  },
  writeFile(path, data) {
    return writeFile(path, data);
  },
  /**
   * readdir 返回 { name, isFile } 适配对象
   *
   * 不用 withFileTypes：LLRT 的 fs.readdir 不支持该选项，
   * 返回的是纯字符串数组而非 Dirent 对象，调用 entry.isFile() 会抛 TypeError。
   * 统一用 stat 判断，Node 和 LLRT 都兼容。
   */
  async readdir(path) {
    const names = await fsReaddir(path);
    const results: { isFile: () => boolean; isDirectory: () => boolean; name: string }[] = [];
    for (const name of names) {
      try {
        const s = await fsStat(path + "/" + name);
        results.push({ name, isFile: () => s.isFile(), isDirectory: () => s.isDirectory() });
      } catch {
        /** stat 失败（符号链接断裂等）跳过 */
      }
    }
    return results;
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  unlink(path) {
    return unlink(path);
  },
  rm(path) {
    return rm(path);
  },
});
