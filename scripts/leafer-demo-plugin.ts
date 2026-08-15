/**
 * 构建时把 packages/leafer-x-webfont/demo/index.html 复制进主站 dist。
 *
 * 该 demo 是零构建的纯静态单文件（依赖全走 jsDelivr CDN），不参与 vite-ssg 管线；
 * 挂到主站 /leafer-demo/ 路径下，后端 staticFileMiddleware 已支持目录 → index.html 解析。
 * 若 demo 未来变成多文件，需改为 copy 整个目录。
 */
import type { Plugin } from "vite";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function leaferDemoPlugin(): Plugin {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = resolve(rootDir, "packages/leafer-x-webfont/demo/index.html");
  const target = resolve(rootDir, "dist/leafer-demo/index.html");

  return {
    name: "copy-leafer-demo",
    apply: "build",
    closeBundle() {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      console.log(`[leafer-demo] copied → dist/leafer-demo/index.html`);
    },
  };
}
