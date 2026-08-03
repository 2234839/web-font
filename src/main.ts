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
  { path: "/offline-subset", component: () => import("./pages/OfflineSubset.vue") },
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
  /**
   * DEV 字体预览页 —— 仅 dev 模式注册路由，生产构建不可达
   */
  ...(import.meta.env.DEV
    ? [{ path: "/__dev", component: () => import("./pages/DevPreview.vue") }]
    : []),
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

    /**
     * 路由切换时滚动到顶部
     *
     * 默认 Vue Router 不处理滚动位置，SPA 内导航会保留前一页的滚动偏移，
     * 从详情页→列表→另一个详情页时用户看到的不是页面顶部而是中间位置。
     */
    router.afterEach((_to, _from) => {
      if (typeof window === "undefined") return;
      /** nextTick 确保 DOM 已更新到新页面后再滚动 */
      window.scrollTo({ top: 0 });
    });
  },
);

