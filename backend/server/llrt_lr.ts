/**
 * fs 适配层分发器。
 *
 * 按编译期 __RUNTIME__ 常量选择实现 —— tsdown 会把未命中分支 tree-shake 掉：
 * - LLRT 构建（__RUNTIME__="llrt"）：llrt.ts 生效
 * - Node 构建（__RUNTIME__="node"）与 dev（tsx，__RUNTIME__ 未定义）：node.ts 生效
 *
 * 两个适配器都在模块顶层调用 implInterface 完成注册（副作用 import），
 * ESM import hoisting 保证分发器先于 app.ts 其余 import 执行。
 * 注意：不能用 top-level await import —— tsdown 的 CJS 产物不支持；
 * 条件 require 在打包时同样会被静态分析，未命中分支整块消除。
 */

/** 编译期常量：tsdown define 注入，dev 下未定义 */
declare const __RUNTIME__: string | undefined;

if (typeof __RUNTIME__ !== "undefined" && __RUNTIME__ === "llrt") {
  require("./llrt");
} else {
  require("./node");
}
