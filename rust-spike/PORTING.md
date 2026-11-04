# rust-spike 移植规范（所有 Zig→Rust 对译代理必读）

## 使命
把 `zig-spike/src/*.zig` 逐模块对译为 `rust-spike/src/*.rs`。zig-spike 是 TS 后端子集化引擎的**已验证镜像**（280 用例对拍 🟢），语义疑问一律以对应 .zig 源码为准，**不要去读 backend/ TS 源码重新推导**。

## 字节级等价是验收标准
相同输入下，Rust 版输出必须与 Zig 版逐字节相同（差异须能解释并经确认）。Zig 版已含全部修复（locaRange u16 溢出、P1 锚定注入、P4 hinting 剥离、P6 name 重建、P7 hmtx 折叠、cmap BMP format12 修复等）。

## 只移植自己的模块
- 每个代理只写自己负责的一个 .rs 文件（可在 rust-spike/src/ 下建同名子目录组织子模块，如 src/gsub/）
- 不得修改：zig-spike/、backend/、rust-spike/src/main.rs、src/http.rs、src/cache.rs、其他代理的模块
- 桩接口签名是跨模块契约，**不得更改**（需要新增能力时在最终报告里提出，由主会话协调）
- 禁止任何 git stash/reset/checkout/commit 操作

## Rust 编码规范（gs 全局规范）
- `///` doc 注释放 item 上方，内容从 Zig 版 `///` 直接翻译；`//` 普通注释同样翻译
- snake_case 命名，与 Zig 对应关系肉眼可查（collectGids→collect_gids）
- 禁 `unsafe`、禁外部 crate（**例外：woff2.rs 允许 brotli crate**，选型见下）
- 整数转换：无损用 `as`/`try_from`；有损截断必须与 Zig `@intCast`/`@truncate` 语义逐一对齐并加注释
- let it crash：不变量违反直接 panic（对齐 Zig），预期失败走 Result
- 迭代优于手写下标（字节解析游标类代码可保留下标游标，与 Zig 对译一致优先）

## 工程约定
- `cargo build --release` 必须零错误零警告；`cargo test --release` 全绿
- 死代码警告：桩阶段未接线的 pub 能力用 `#[allow(dead_code)] // 原因` 标注
- 并行代理共用同一 cargo 工程，cargo 有文件锁会自动排队，放心构建

## 验证层级（按你能做的做到最深处）
1. cargo 编译零警告 + 单元测试
2. 模块级对拍（能独立测就测：如 woff2 可拿 Zig 服务产的 ttf 做 fixture，与 Zig 产的 woff2 字节比）
3. 端到端对拍由主会话在 ttf.rs 落地后统一做（HTTP 双实例字节 cmp，工具 rust-spike/verify-parity.sh）

## Zig 模块语义备忘（前人确认，勿踩）
- gsub：collect_reachable 返回空 Vec ≠ 错误（版本不支持退 seed 序）；keep 列表必须保持插入序不可排序；subsetGPOS 返回 null = 透传原始字节
- cff：subsetCFF 返回 null = 非 CID CFF 不支持时的降级路径（透传）
- woff2：Zig 版静态链系统 libbrotli-dev（C brotli）；TS 生产同样 C brotli；brotli 质量/参数以 woff2.zig 实际调用为准
