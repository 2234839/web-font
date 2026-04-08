import { implInterface } from "../interface";
import { stat, readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
implInterface({
  async stat(path) {
    const r = await stat(path);
    return r;
  },
  readFile(path) {
    return readFile(path);
  },
  writeFile(path, data) {
    return writeFile(path, data);
  },
  async readdir(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      isFile: () => entry.isFile(),
      name: entry.name,
    }));
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  unlink(path) {
    return unlink(path);
  },
});
