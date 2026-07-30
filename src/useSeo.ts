import { useHead, useSeoMeta } from "@unhead/vue";
import type { PageSeo } from "./seo";
import { SITE_URL, SITE_NAME, OG_IMAGE } from "./seo";

/**
 * 应用页面级 SEO —— 每个页面组件 setup 时调用一次
 *
 * 自动设置 title/description/OG/canonical/JSON-LD，
 * 内容在 SSG 构建时渲染进静态 HTML，爬虫直接可读。
 *
 * @example
 * // pages/Blog.vue
 * usePageSeo({
 *   title: "博客",
 *   description: "WebFont 技术博客，分享字体优化实践",
 *   path: "/blog",
 * });
 */
export function usePageSeo(seo: PageSeo) {
  /** 完整标题：页面标题 | 站点名 */
  const fullTitle = `${seo.title} | ${SITE_NAME}`;
  /** canonical 绝对 URL（告诉搜索引擎这是页面唯一权威地址，防重复收录） */
  const canonical = `${SITE_URL}${seo.path}`;
  /** OG image 绝对路径（社交分享需要绝对 URL） */
  const ogImage = `${SITE_URL}${OG_IMAGE}`;

  useSeoMeta({
    title: fullTitle,
    description: seo.description,
    /** canonical 链接 */
    ogTitle: fullTitle,
    ogDescription: seo.description,
    ogImage,
    ogUrl: canonical,
    ogType: "website",
    ogSiteName: SITE_NAME,
    /** Twitter 卡片 */
    twitterCard: "summary_large_image",
    twitterTitle: fullTitle,
    twitterDescription: seo.description,
    twitterImage: ogImage,
  });

  useHead({
    /** canonical link 标签 */
    link: [{ rel: "canonical", href: canonical }],
    /**
     * 页面级 JSON-LD（BreadCrumb 面包屑，帮助搜索引擎理解页面层级）
     * 全局 WebApplication JSON-LD 在 App.vue 里注入
     */
    script: [
      {
        type: "application/ld+json",
        innerHTML: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: SITE_NAME,
              item: SITE_URL,
            },
            {
              "@type": "ListItem",
              position: 2,
              name: seo.title,
              item: canonical,
            },
          ],
        }),
      },
    ],
  });
}
