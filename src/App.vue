<script setup lang="ts">
/**
 * 根组件 —— 纯路由出口容器 + 全局 SEO 注入
 *
 * 全局 SEO（站点默认 description/OG/WebApplication JSON-LD）在这里注入，
 * 各页面组件通过 usePageSeo() 覆盖自己的 title/description。
 */
import { useHead } from "@unhead/vue";
import { SITE_NAME, SITE_DESCRIPTION, OG_IMAGE, SITE_URL, ORGANIZATION_JSONLD } from "./seo";

/** 全局默认 SEO：未调用 usePageSeo 的页面会用这些值 */
useHead({
  htmlAttrs: { lang: "zh-CN" },
  meta: [
    { name: "description", content: SITE_DESCRIPTION },
    { name: "keywords", content: "字体裁剪,字体子集,中文字体,web字体,font subset,woff2,按需加载字体,字体压缩,免费商用字体" },
  ],
  /** 全局结构化数据：WebApplication 类型（站点级，每个页面都有） */
  script: [
    {
      type: "application/ld+json",
      innerHTML: JSON.stringify(ORGANIZATION_JSONLD),
    },
  ],
});
</script>

<template>
  <RouterView />
</template>
