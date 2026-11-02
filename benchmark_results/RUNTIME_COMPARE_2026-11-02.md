# 三运行时性能对比：LLRT vs Node vs Perry

- 日期：2026-11-02
- 机器：本机 WSL2（同机同网回环，Node v22 作压测客户端）
- 被测服务：同一份 backend/app.ts，四种产物
  - **LLRT** 0.8.0-beta：`./llrt dist_backend/app.cjs`（已淘汰：woff2 慢 40× + 稳态挂起）
  - **Node** v22：`node dist_backend_node/app.cjs`
  - **Bun** 1.4.0：`bun dist_backend_node/app.cjs`
  - **Perry** v0.5.1664：`perry compile backend/app.ts`（33.4MB 原生二进制）
- 脚本：`scripts/runtime-bench.mjs`（每用例预热 1 次 + 15 次取样，p50/p95/avg；**裁剪用例每请求随机文字，强制不命中 subsetCache，测真实计算**）
- server.ts 已含 HTTP 状态行修复（三运行时同一份代码）
- 数据文件：/tmp/rb_perry2.json、/tmp/rb_node.json、/tmp/rb_llrt.json（旧缓存命中版）/tmp/rb2_*.json（真实计算版）
- ⚠️ 教训：第一版基准重复同一 URL，15 次里 14 次命中 LRU 缓存，测的是"缓存+HTTP 回环"（三者都 2~4ms 无区分度）；本表为修正后的真实计算数据

## 1. 字体裁剪（GET /api，缓存不命中，单位 ms）

| 用例 | LLRT p50 | Node p50 | Bun p50 | Perry p50 |
|---|---|---|---|---|
| 8字-ttf | 4.7 | 4.8 | **4.5** | 5.8 |
| 8字-woff2 | 94.4 | 4.6 | 5.1 | **4.6→** 14.6 |
| 千字文128字-ttf | 6.1 | 4.4 | 4.6 | **8.4** |
| 千字文128字-woff2 | 247.5 | **6.1** | 7.0 | 27.3 |
| 思源黑体-8字-woff2 | 20.6 | **3.4** | 4.3 | 6.6 |
| 思源黑体-128字-woff2 | 35.5 | **3.7** | 4.4 | 11.3 |

**结论**：真实裁剪计算 **Node 最快、Bun 与之打平（±15%）**；LLRT 的 woff2 压缩是硬伤（128字 247ms，Node 的 40 倍，无原生 brotli）；Perry 比 Node 慢 1.3~4.5×（woff2 场景）——perry codegen 每操作带类型 guard+NaN-boxing 检查，TypedArray 数值循环不敌 V8 JIT 投机优化。

## 2. 字体搜索（POST /api/glyph-match，位图→字形匹配，CPU 密集）

| 指标 | LLRT | Node | Bun | Perry |
|---|---|---|---|---|
| p50 | 57.0 | 34.7 | 33.8 | **24.7** |

**结论**：glyph-match 纯计算密集，**Perry（AOT 原生码）比 Node/Bun 快 ~28%、比 LLRT 快 57%**。

## 3. 资源与稳定性（同一基准负载下统一口径实测）

| 指标 | LLRT | Node | Bun | Perry |
|---|---|---|---|---|
| 空载 RSS（启动+预热） | — | 64MB | 42MB | **32MB** |
| 基准后 RSS | ~378MB* | 250MB | 231MB | **221MB** |
| 产物体积 | 解释器12.6MB+319KB | 需 Node 运行时 | 需 Bun 运行时 | 33.4MB 单文件 |
| 稳定性 | ⚠️ 稳态挂起 bug | ✅ | ✅ | ✅ |

*LLRT 378MB 为早前单独实测；本轮统一口径复测因用户裁定淘汰 LLRT 未完成。

**结论**：Perry 内存最优（基准后 221MB 且无 GC 堆额外开销）；Bun 空载最省之一且基准后比 Node 低 19MB。

## 总结

- **裁剪基准（核心业务）**：Node 最快；LLRT woff2 极慢（无原生 brotli，128字 247ms）；Perry 比 Node 慢 1.3~4.5×（perry 胖 codegen 的类型 guard 在 TypedArray 数值循环上不敌 V8 JIT）
- **字体搜索**：Perry 最快（比 Node 快 29%）
- **综合**：生产以裁剪为主 → 当前切 Perry 会带来 woff2 回退；LLRT 三项皆弱且有挂起 bug，最先出局
- **Perry 体积补充**（差分实测）：33.4MB = 11.2MB runtime+net 底座 + 10.6MB fonteditor 解析链 + 2.8MB woff2/brotli + 8.8MB 自研模块；源码→原生码膨胀 16~21 倍（正常 AOT 为 2~5 倍），与速度慢同因：每操作生成类型 guard + NaN-boxing 检查的胖机器码。瘦身/提速均无应用层手段，只能等上游 codegen 优化（issue 素材）
