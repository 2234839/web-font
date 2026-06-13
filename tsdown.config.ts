import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

/** 构建期读取 package.json 版本号，注入为运行时常量（避免运行时读文件 + LLRT 无 __filename 问题） */
const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const shared = {
  format: ["cjs"],
  clean: true,
  sourcemap: true,
  outDir: "dist_backend",
  /** 构建期把 PACKAGE_VERSION 替换为字面量字符串，运行时无任何文件读取 */
  define: { PACKAGE_VERSION: JSON.stringify(packageVersion) },
  outputOptions: {
    /** 禁用代码拆分，确保单文件输出（tsdown 默认会拆分大依赖为 chunk） */
    codeSplitting: false,
  },
  deps: {
    /** 所有依赖都打进 bundle（LLRT scratch 镜像无 node_modules） */
    alwaysBundle: [/.*/],
  },
};

export default [
  defineConfig({
    ...shared,
    entry: ["backend/app.ts"],
  }),
  defineConfig({
    ...shared,
    /** 第二个配置不 clean，避免清掉第一个的输出 */
    clean: false,
    entry: ["基准测试_llrt.ts"],
  }),
];
