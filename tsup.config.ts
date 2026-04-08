import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["backend/app.ts"],
  splitting: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  noExternal: [/.*/],
  outDir: "dist_backend",
});
