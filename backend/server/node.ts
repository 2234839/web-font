import { implInterface } from "../interface";
import { stat, readFile } from "fs/promises";
implInterface({
  async stat(path) {
    const r = await stat(path);
    return r;
  },
  readFile(path) {
    return readFile(path);
  },
});
