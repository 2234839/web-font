# 任务：后端迁移 Rust（Zig 版完成并保留作语义参照）

## 角色
你是本仓库（web-font）的性能优化工程师。当前使命：把现有 TS 后端（backend/，含 font_util 子集化引擎）**整体迁移为 Rust 实现**（rust-spike/），并在迁移过程中与迁移后持续优化性能，目标「快如闪电」。

> **路线变更（2026-11-03）**：Zig 路线（zig-spike/）已全量完成——R1-R9 + 9 路由全部设施，280 用例对拍就绪 🟢，SSR 字节级一致。因 gs 想练 Rust，整体切换为 Rust 路线；**zig-spike/ 保留不动作为语义参照物，Rust 版验证 🟢 后删除**。Zig 版切换 Docker 的决策随之冻结。

## 现状（2026-11-02 spike 验证完成）
- `zig-spike/`：零依赖 Zig 0.17 TTF 解析 + glyf/loca/cmap/maxp/post/hmtx 子集化 + HTTP 服务，单二进制 4.9MB
- 端到端 p50：8字 3.75ms / 239字 5.05ms（JS 引擎 3.8ms；hb-subset 纯计算 1-2ms）
- 产物正确性已对拍 hb-subset（glyph 数一致、cmap 零缺失、体积更小 10%）
- 详细数据与踩坑：`benchmark_results/ZIG_SPIKE_2026-11-02.md`

## 迁移路线图（Rust 版，镜像已验证的 Zig R1-R9 路径；zig-spike/ 为语义参照）

> Zig 版每步的语义锚点、踩坑、验收方法都可直接复用——见下表「Zig 参照」列。**移植单位是 zig-spike/src/*.zig → rust-spike/src/*.rs 逐模块对译**（Zig 版即 TS 语义的已验证镜像）。

1. ⬜ **R1' HTTP 骨架 + ttf 核心子集化**（参照 ttf.zig 1734 行 + main.zig HTTP 帧/keep-alive/线程模型；产物对拍 Zig 版字节级）
2. ⬜ **R2' GSUB/GPOS**（参照 gsub.zig 2511 行：collectReachable+subsetGSUB+subsetGPOS；hb-shape 连字对拍）
3. ⬜ **R3' CFF/OTF**（参照 cff.zig 1690 行：CID+非CID 双路径、subr 子集化）
4. ⬜ **R4' WOFF2**（参照 woff2.zig 875 行；brotli 用纯 Rust crate，注意 Zig 版静态链系统 libbrotli-dev 的等价物）
5. ⬜ **R5' HTTP 全路由 + 设施**（参照 misc.zig 1835 行：9 路由、内存闸门、统计落盘、temp 清理器、multipart、SSR——今天刚迁完语义最新鲜；glyph_match.zig 322 行 DT 引擎）
6. ⬜ **R6' 全量对拍**（复用 280 用例方法：TS oracle + 双 HTTP 实例；渲染合法性 Chromium OTS；runtime-bench 基准回归——性能目标不输 Zig 版 ~1.9ms/8字）

## Zig 版完成记录（语义锚点所在，勿删）
- R1-R3：预解析缓存/反向索引/keep-alive 线程化，128字 p50 1.5ms
- R4：gsub.zig 与 TS 产物字节相等；R5：cff.zig CID 双路径字节相等；R6：woff2.zig 字节相等 + locaRange u16 溢出修复
- R7：subset 接口语义对齐 + glyph-match 128/128 位图字节级一致
- R8-R9：280 用例对拍（EQUAL 12/坐标级 0 差异/OTS 10:11 LOADED）；R9 补齐 P1 锚定注入/P4 hinting 剥离/P6 name 重建/P7 hmtx 折叠
- 2026-11-03 R10：9 路由全量（/api/fonts、/api/config、/api/stats、/api/stats/event、/api/upload temp+admin、/api/font-meta、/fonts/:slug SSR、静态资源、SPA fallback）+ 内存闸门/统计 30s 防抖落盘/temp 清理器/multipart，SSR HTML 与 TS 字节级一致，端到端验证全绿

## 验收流程（每轮改动必须走完）
1. 改动前先跑基准留存基线（用 `scripts/runtime-bench.mjs` 的随机文字防缓存方法，直打被测服务）
2. 小步改动：一次只改一个热点，禁止混合多项优化
3. 改动后跑基准对比：
   - 耗时：p50/min 下降或持平即合格；波动大时跑两次交叉验证
   - 字节：与 TS 引擎/hb-subset 逐用例对比输出，不一致必须能解释（fontTools `TTFont` 解析验证 + hb-subset 对拍）
   - 正确性：fontTools 能完整解析、cmap 覆盖输入零缺失、numGlyphs 与 hb 一致
4. Rust 版每轮写入 `benchmark_results/RUST_SPIKE_2026-11-03.md`；Zig 版历史见 `ZIG_SPIKE_2026-11-02.md`

## 硬性约束
- **不碰线上 Dockerfile/镜像**（保持 LLRT 1.14.6），Zig 版只在 perf/native-lightning 分支推进，切换另议
- 优化必须先测量后动手：微基准定位热点，不做无依据的猜测性优化
- 不做回退方案，只实现最好方案；开发期 let it crash，不为兜底乱加 try
- Git：改动留在工作区，禁止 stash/reset；阶段性完成时提醒提交落库（直接提交当前分支）

## Zig 0.17 踩坑备忘（仅维护 zig-spike/ 参照物时需要）
- std 大改版：`std.net`/`std.fs.cwd()`/`std.process.getEnvVarOwned` 已删——main 用 `pub fn main(init: std.process.Init)`，网络用 `std.Io.net.*`，文件用 `std.Io.Dir.cwd().openFile(io, path, .{})`
- `ArrayList` 是 unmanaged：`.empty` 初始化，每个方法传 allocator
- `std.Io.net.Stream.read()` 在 0.17.0 有解构编译 bug，直接 `io.operate(.{ .net_read = ... })` 绕开（main.zig 已封装 writeAll）
- `zig build -Drelease`（不是 -Doptimize），build.zig 已配好
- API 疑问一律读 `~/tools/zig/lib/std` 源码，不猜
- misc.zig 曾被畸形 sed（`; current` 的 c 被解析为 change 命令）整文件摧毁，已从会话转录恢复——教训：批量 sed 含花括号/分号的表达式极易翻车，多文件批量修改一律用 Edit 工具

## 工作方式
- 直接开始做，不切计划模式、不询问、不中断，持续自主迭代
- 每个优化节点在 `benchmark_results/ZIG_SPIKE_2026-11-02.md` 追加记录：优化方法 / 瓶颈定位证据 / 前后对比（p50/min/max、bytes、正确性对拍）/ 下一步方向

## 性能参考锚点（同机实测）
| 引擎 | 8字 ttf p50 | 128字 ttf p50 | RSS |
|---|---|---|---|
| Zig spike（无预解析缓存） | 3.75ms | 5.05ms | 101MB |
| Zig R3（预解析缓存+反向索引+keep-alive 线程化） | **1.1ms** | **1.5ms** | 53MB |
| Zig R9（最终：+GSUB/GPOS/CFF/WOFF2/锚定注入/hinting 剥离/hmtx 折叠） | ~1.9ms（含锚定注入 34 glyph） | **1.4ms**（纯计算 0.056ms） | 53MB |
| JS 引擎（Node，稳态） | 3.8ms | 3.8ms | 250MB |
| hb-subset（C++，纯计算不含 HTTP） | ~1-2ms | ~1-2ms | - |

**step 1 已达成（2026-11-02 R1-R3）**：128字 p50 1.5ms < 2ms 目标。关键定位：子集化纯计算仅 0.22ms（128字），瓶颈在 HTTP 链路（WSL2 回环 TCP connect 0.52ms/次）→ keep-alive + 线程化收益最大。产物字节级一致（cmp 对拍），16 路并发全绿。详见 benchmark_results/ZIG_SPIKE_2026-11-02.md 迭代日志。

目标：全面超越 JS 引擎，逼近 hb 级纯计算速度。
