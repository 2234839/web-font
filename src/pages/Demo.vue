<script setup lang="ts">
/**
 * /demo 路由 —— Before/After 字体效果演示
 *
 * 由原 App.vue 中的 showDemo 状态切换拆分为独立页面。
 * TypographyDemo 需要 onBack 回调，这里用 router 跳回首页。
 */
import TypographyDemo from "../TypographyDemo.vue";
import { useRouter } from "vue-router";
import { usePageSeo } from "../useSeo";

/** Demo 页 SEO：独立 title/description，可被搜索引擎单独索引 */
usePageSeo({
  title: "字体效果演示 | Before / After",
  description: "见证 AI 使用 Chinese Font Skill 后，同一内容在不同字体下的体验差异。字体的力量，一目了然。",
  path: "/demo",
  priority: 0.6,
  changefreq: "monthly",
});

const router = useRouter();
</script>

<template>
  <TypographyDemo :onBack="() => router.push('/')" />
</template>
