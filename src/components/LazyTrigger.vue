<script setup lang="ts">
/**
 * 懒触发组件 —— 子元素进入视口时触发 @appear 事件（仅一次）。
 *
 * 用途：字体列表卡片懒加载字体子集、图片懒加载等场景。
 * 通过 IntersectionObserver 监听，进入视口（含 rootMargin 预判范围）后回调。
 */
import { ref, onMounted, onUnmounted } from "vue";

const props = withDefaults(
  defineProps<{
    /** 视口预判距离，提前多少像素触发（默认 10px） */
    rootMargin?: string;
  }>(),
  { rootMargin: "10px" },
);

const emit = defineEmits<{
  /** 子元素首次进入视口范围时触发 */
  appear: [];
}>();

const el = ref<HTMLElement>();
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (!el.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          emit("appear");
          observer?.disconnect();
          observer = null;
          break;
        }
      }
    },
    { rootMargin: props.rootMargin },
  );
  observer.observe(el.value);
});

onUnmounted(() => observer?.disconnect());
</script>

<template>
  <!--
    根 div 作为 IntersectionObserver 的观测目标。
    不用 display:contents（会导致无盒模型，observer 无法触发），
    而是让 slot 内容自然撑满。
  -->
  <div ref="el">
    <slot />
  </div>
</template>
