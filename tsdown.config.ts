import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["backend/app.ts", "基准测试_llrt.ts"],
  format: ["cjs"],
  clean: true,
  sourcemap: true,
  outDir: "dist_backend",
  deps: {
    /** 所有依赖都打进 bundle（LLRT scratch 镜像无 node_modules） */
    alwaysBundle: [/.*/],
  },
});
