import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { pilot } from "vite-plugin-pilot";
import commonjs from "vite-plugin-commonjs";
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
  { path: "/offline-subset", changefreq: "weekly" as const, priority: 0.8 },
  { path: "/demo", changefreq: "monthly" as const, priority: 0.6 },
];

export default defineConfig({
  plugins: [
    vue(),
    pilot({ locale: "zh" }),
    /**
     * 处理 vendor/fonteditor-core 的 CJS 文件
     *
     * fonteditor-core 是 Babel 编译输出的 CJS 格式（exports.xxx / require），
     * vite dev 对项目内非 node_modules 的 CJS 不自动 interop。
     * 此插件在转译阶段把 vendor 目录下的 CJS 即时转为 ESM，
     * 使 `import { Font } from "vendor/..."` 能正确识别命名导出。
     */
    commonjs({
      filter(id) {
        return id.includes("/vendor/fonteditor-core/");
      },
      advanced: {
        /**
         * merge 模式：require() 转换后的 import 表达式合并 default 和命名导出，
         * 生成 Object.assign(ns.default, ns)，使后续的 .namedExport 访问可行。
         * 配合 patch-interop 插件增强 _interopRequireDefault 函数。
         */
        importRules: "merge",
      },
    }),
    /**
     * Patch vendor 文件中的 _interopRequireDefault 函数
     *
     * fonteditor-core 使用 Babel 编译输出的 CJS 格式，大量使用如下模式：
     *   var _x = _interopRequireDefault(require("./x")).namedExport;
     *
     * vite-plugin-commonjs 把 require() 转为 import * as __CJS__import__N__，
     * 但 ESM 命名空间没有 __esModule 标记，
     * _interopRequireDefault 返回 { default: ns } 而非 ns 本身，
     * 导致 .namedExport 访问失败（_checkSumArrayBuffer is not a function）。
     *
     * 本插件在 transform 阶段替换 _interopRequireDefault 的函数体，
     * 让它将 default 属性展开合并到返回对象上，
     * 使 .namedExport 能直接访问。
     */
    {
      name: "patch-interop",
      enforce: "post",
      transform(code, id) {
        if (!id.includes("/vendor/fonteditor-core/") || !code.includes("_interopRequireDefault")) {
          return null;
        }
        /** 增强版 _interopRequireDefault：合并 default 属性到对象本身 */
        const patched =
          "function _interopRequireDefault(obj) { " +
          "if (obj && obj.__esModule) return obj; " +
          "var result = obj && obj.default ? Object.assign({}, obj.default, obj) : (obj || {}); " +
          "result.default = obj; " +
          "result.__esModule = true; " +
          "return result; " +
          "}";
        /**
         * 匹配 Babel 生成的标准 _interopRequireDefault 函数定义。
         * fonteditor-core 所有文件的此函数体完全一致：
         *   function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
         */
        return code.replace(
          /function _interopRequireDefault\(obj\)\s*\{\s*return obj && obj\.__esModule \? obj : \{ default: obj \};\s*\}/,
          patched,
        );
      },
    },
    /**
     * 拦截 woff2 模块 —— 浏览器端空实现
     *
     * fonteditor-core 的 woff2/index.js 和 woff2/woff2-encode.js 依赖 Node.js zlib，
     * 浏览器无法加载。在 resolveId 钩子中将这两个模块重定向到 src/shims/woff2-shim.ts，
     * 使 import 链不断裂。离线裁剪只产出 TTF，不触发 woff2 编码路径。
     */
    {
      name: "woff2-browser-shim",
      enforce: "pre",
      resolveId(id, importer) {
        /**
         * 匹配多种路径形式：
         * - 绝对路径：/home/.../vendor/fonteditor-core/woff2/index.js
         * - 相对路径：../../woff2/index（来自 ttftowoff2.js 等）
         * - 带前缀：fonteditor-core/woff2/index
         */
        const isWoff2Module =
          (id.includes("fonteditor-core/woff2/") ||
            (id.includes("woff2/index") && importer?.includes("fonteditor-core")) ||
            (id.includes("woff2/woff2-encode") && importer?.includes("fonteditor-core"))) &&
          !id.includes("woff2-shim");
        if (isWoff2Module) {
          return fileURLToPath(new URL("./src/shims/woff2-shim.ts", import.meta.url));
        }
        return null;
      },
      load(id) {
        if (
          (id.includes("fonteditor-core/woff2/index") ||
            id.includes("fonteditor-core/woff2/woff2-encode")) &&
          !id.includes("woff2-shim")
        ) {
          return `export function encodeTTFToWOFF2() { throw new Error("WOFF2 encoding is not supported in browser."); }
export function decodeWOFF2ToTTF() { throw new Error("WOFF2 decoding is not supported in browser shim."); }
export default { isInited: () => false, init: () => Promise.resolve(), encode: () => { throw new Error("not supported"); }, decode: () => { throw new Error("not supported"); } };`;
        }
        return null;
      },
    },
    sitemapPlugin(sitemapRoutes),
    /**
     * 构建时替换 index.html 中的时间戳占位符
     *
     * webfont-sdk.js 在 public/ 下是静态文件，不走 Vite 哈希机制。
     * 加时间戳查询参数确保每次发版用户浏览器拉到最新版而非缓存旧版。
     */
    {
      name: "html-build-timestamp",
      transformIndexHtml(html) {
        return html.replace(/%BUILD_TIME%/g, Date.now().toString());
      },
    },
  ],
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
    includedRoutes: () => ["/", "/offline-subset", "/demo", "/fonts", "/fonts/__FONT_NAME__"],
    /**
     * 构建期（Node 环境）模拟浏览器全局变量，
     * 防止第三方库在 SSG 阶段访问 window/document 时崩溃。
     */
    mock: true,
  },
});
