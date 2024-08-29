import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
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
