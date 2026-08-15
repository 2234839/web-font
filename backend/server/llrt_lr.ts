/**
 * fs 适配层分发器。
 *
 * 按编译期 __RUNTIME__ 常量选择实现 —— tsdown define 常量折叠后未命中分支被消除：
 * - LLRT 构建（__RUNTIME__="llrt"）：require("./llrt")，内联进 bundle
 * - Node 构建（__RUNTIME__="node"）：require("./node")，内联进 bundle
 * - dev（tsx ESM 直跑源码，__RUNTIME__ 未定义）：动态 import("./node")
 *
 * 适配器在模块顶层调用 implInterface 完成注册。
 *
 * 注意：
 * - 构建分支必须保持**裸 require("./xxx")** 字面量——打包器靠静态分析内联适配器，
 *   变量间接调用（createRequire 等）无法被分析；且 native require 与 tsx ESM loader
 *   模块缓存隔离（双实例），implInterface 会注册到另一个实例上，运行时必错。
 * - 不能用 top-level await import —— tsdown 的 CJS 产物不支持。
 * - dev 无全局 require：走动态 import（经 tsx ESM loader，与 app 同模块图），
 *   返回 fsReady 由 app.ts 的 main() 开头 await，保证注册先于任何 fs 调用。
 */

/** 编译期常量：tsdown define 注入，dev 下未定义 */
declare const __RUNTIME__: string | undefined;

let fsReady: Promise<void>;

if (typeof __RUNTIME__ !== "undefined" && __RUNTIME__ === "llrt") {
  require("./llrt");
  fsReady = Promise.resolve();
} else if (typeof __RUNTIME__ !== "undefined") {
  require("./node");
  fsReady = Promise.resolve();
} else {
  fsReady = import("./node").then(() => undefined);
}

export { fsReady };
