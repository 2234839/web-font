import { ViteSSG } from "vite-ssg";
import { createWebHistory } from "vue-router";
import App from "./App.vue";

/**
 * 路由表
 *
 * - `/`      工具页（SPA 行为，交互为主，SSG 仅预渲染静态外壳）
 * - `/demo`  字体效果演示（独立页面，可分享直链、被爬虫索引）
 *
 * 后续新增内容页（博客 /fonts 等）在此追加，
 * 并在 vite.config.ts 的 ssgOptions.include 里登记以纳入预渲染。
 */
const routes = [
  { path: "/", component: () => import("./pages/Home.vue") },
  { path: "/demo", component: () => import("./pages/Demo.vue") },
  { path: "/fonts", component: () => import("./pages/FontList.vue") },
  /**
   * 字体详情页 —— SSG 构建时以 __FONT_NAME__ 占位符渲染模板 HTML，
   * 后端对 /fonts/* 请求做字符串替换返回动态页面。
   */
  {
    path: "/fonts/:slug",
    component: () => import("./pages/FontDetail.vue"),
  },
];

export const createApp = ViteSSG(
  App,
  {
    routes,
    base: import.meta.env.BASE_URL,
  },
  ({ router }) => {
    /** 显式使用 history 模式，避免 hash 模式下 SSG 路由不生效 */
    router.options.history = createWebHistory(import.meta.env.BASE_URL);
  },
);

