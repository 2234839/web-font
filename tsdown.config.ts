import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

/** 构建期读取 package.json 版本号，注入为运行时常量（避免运行时读文件 + LLRT 无 __filename 问题） */
const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const shared = {
  format: "cjs",
  clean: true,
  sourcemap: true,
  outDir: "dist_backend",
  outputOptions: {
    /** 禁用代码拆分，确保单文件输出（tsdown 默认会拆分大依赖为 chunk） */
    codeSplitting: false,
  },
  deps: {
    /** 所有依赖都打进 bundle（LLRT scratch 镜像无 node_modules） */
    alwaysBundle: [/.*/],
  },
} as const;

export default [
  defineConfig({
    ...shared,
    /** LLRT 构建 */
    define: {
      PACKAGE_VERSION: JSON.stringify(packageVersion),
      __RUNTIME__: JSON.stringify("llrt"),
    },
    entry: ["backend/app.ts"],
  }),
  defineConfig({
    ...shared,
    /** Node.js 构建（用于本地开发测试） */
    define: {
      PACKAGE_VERSION: JSON.stringify(packageVersion),
      __RUNTIME__: JSON.stringify("node"),
    },
    /** 第二个配置不 clean，避免清掉第一个的输出 */
    clean: false,
    entry: ["backend/app.ts"],
    outDir: "dist_backend_node",
  }),
  defineConfig({
    ...shared,
    /** 第二个配置不 clean，避免清掉第一个的输出 */
    clean: false,
    entry: ["基准测试_llrt.ts"],
  }),
];
