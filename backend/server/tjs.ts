import { implInterface } from "../interface";

implInterface({
  async stat(path) {
    const r = await tjs.stat(path);
    return {
      isFile: () => r.isFile,
      size: r.size,
    };
  },
  readFile(path) {
    return tjs.readFile(path);
  },
  writeFile(path, data) {
    return tjs.writeFile(path, data);
  },
  async readdir(path) {
    const entries: { isFile: () => boolean; name: string }[] = [];
    const dir = await tjs.readDir(path);
    for await (const entry of dir) {
      entries.push({
        isFile: () => entry.isFile,
        name: entry.name,
      });
    }
    await dir.close();
    return entries;
  },
  /** TJS 没有 mkdir，通过写入占位文件来确保目录存在 */
  async mkdir(path) {
    const placeholder = path + "/.keep";
    await tjs.writeFile(placeholder, new Uint8Array(0));
  },
  unlink(path) {
    return tjs.remove(path);
  },
});
