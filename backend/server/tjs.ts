import { implInterface } from "../interface";

implInterface({
  async stat(path) {
    const r = await global.tjs.stat(path);
    return {
      isFile: () => r.isFile,
      size: r.size,
    };
  },
  readFile(path) {
    return global.tjs.readFile(path);
  },
});
