/**
 * 站点级 SEO 配置 —— 所有页面共享的元信息来源
 *
 * 部署到正式域名时只需修改 SITE_URL，OG 标签、sitemap、canonical 会自动跟随。
 * 每个页面独立的 title/description 在各页面组件里用 useSeoMeta 设置。
 */

/** 站点正式 URL（sitemap/canonical/OG 都依赖它） */
export const SITE_URL = "https://webfont.shenzilong.cn";

/** 站点名称 */
export const SITE_NAME = "WebFont";

/** 站点默认描述（页面未单独设置时使用） */
export const SITE_DESCRIPTION =
  "在线字体裁剪工具 — 服务端按需裁剪字体子集，大小无限制，免费开源。支持自定义裁剪、增量加载 SDK，轻松嵌入任何网站。";

/** 默认 OG 分享图（相对路径，useHead 会拼成绝对 URL） */
export const OG_IMAGE = "/og-image.png";

/**
 * 全局结构化数据（JSON-LD）—— 描述这是一个 Web 应用
 *
 * 让 Google 理解站点类型，有机会在搜索结果展示富摘要
 * （如应用名称、价格、功能列表）。
 */
export const ORGANIZATION_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "CNY",
  },
  featureList: [
    "服务端按需裁剪字体子集",
    "支持 woff2/ttf 输出格式",
    "增量加载 SDK，按需请求字体片段",
    "支持自定义裁剪文本",
    "免费开源",
  ],
};

/** 页面 SEO 元信息类型 */
export interface PageSeo {
  /** 页面标题（不含站点名后缀，useSeoMeta 会自动拼接） */
  title: string;
  /** 页面描述 */
  description: string;
  /** 页面路径（相对站点根，用于 canonical 和 sitemap），如 "/demo" */
  path: string;
  /** 更新频率（sitemap 用），默认 "weekly" */
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  /** 优先级 0-1（sitemap 用），首页 1.0，其他递减 */
  priority?: number;
}
