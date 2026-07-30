import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { pilot } from "vite-plugin-pilot";
import { sitemapPlugin } from "./scripts/sitemap-plugin";
/**
 * 引入 vite-ssg 的类型声明 ——
 * vite-ssg 内部通过 declaration merging 给 vite 的 UserConfig 扩展了 ssgOptions 字段，
 * 但只有显式 import 这个模块，TS 才会加载其类型，从而让下面的 ssgOptions 合法。
 */
import type {} from "vite-ssg";

/**
 * Sitemap 路由清单 —— 构建时据此自动生成 sitemap.xml
 *
 * 与 src/main.ts 的 routes 表保持一致，新增页面时两处都追加。
 * 优先级：首页 1.0，核心功能页 0.8，辅助页 0.6。
 */
const sitemapRoutes = [
  { path: "/", changefreq: "weekly" as const, priority: 1.0 },
  { path: "/demo", changefreq: "monthly" as const, priority: 0.6 },
];

export default defineConfig({
  plugins: [vue(), pilot({ locale: "zh" }), sitemapPlugin(sitemapRoutes)],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:8087",
        changeOrigin: true,
      },
    },
  },
  /**
   * vite-ssg 静态站点生成配置
   *
   * 运行 `vite-ssg build`（见 package.json 的 build:ssg 脚本）时，
   * 会对 include 列出的路由做构建期预渲染，生成带初始内容的 HTML。
   * 工具页 / 的交互逻辑在 onMounted 内，预渲染阶段不执行，生成的 HTML
   * 是静态外壳（含 SEO 文案），水合后变为完整 SPA。
   */
  ssgOptions: {
    script: "async",
    dirStyle: "nested",
    formatting: "minify",
    /**
     * 指定要预渲染的路由
     *
     * vite-ssg 默认会过滤掉动态路由、保留静态路由，
     * 这里显式返回需要 SSG 的路由清单，新增内容页（/blog 等）时在此追加。
     */
    includedRoutes: () => ["/", "/demo"],
    /**
     * 构建期（Node 环境）模拟浏览器全局变量，
     * 防止第三方库在 SSG 阶段访问 window/document 时崩溃。
     */
    mock: true,
  },
});
