import type { Apis } from "../../backend/src/rpc";
import { serverUrl } from "./config";

export const Api = generateApi(serverUrl);

function generateApi(path: string): Apis {
  return new Proxy<Apis>(generateApi as any, {
    get(target, p) {
      if (typeof p === "string") {
        console.log(p);

        return generateApi(path + "/" + p);
      } else {
        throw new Error("错误的 api 属性访问");
      }
    },
    async apply(target, thisArg, argArray) {
      const r = await fetch(path, {
        body: JSON.stringify(argArray),
        method: "POST",
      });
      return r.json();
    },
  });
}
