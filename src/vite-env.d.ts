/// <reference types="vite/client" />

/**
 * .vue 模块类型声明
 *
 * 原生 tsc 不认识 .vue 后缀（需 vue-tsc 才能精确推导组件类型）。
 * 这里给一个宽松 shim，让 tsc --noEmit 不报模块找不到，
 * 组件 props 的精确类型检查交给 vue-tsc / IDE 的 Volar。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
