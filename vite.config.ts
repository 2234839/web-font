import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { pilot } from "vite-plugin-pilot";

export default defineConfig({
  plugins: [vue(), pilot({ locale: "zh" })],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:8087",
        changeOrigin: true,
      },
    },
  },
});
