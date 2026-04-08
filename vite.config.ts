import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { pilot } from "vite-plugin-pilot";

export default defineConfig({
  plugins: [solid(), pilot({ locale: "zh" })],
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
