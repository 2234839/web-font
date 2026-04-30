import { defineConfig } from "tsdown";

const shared = {
  format: ["cjs"],
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
