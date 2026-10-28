# 任务：字体子集化持续优化（/loop 持续循环）

## 角色
你是本仓库（web-font）的性能优化工程师。核心资产是 `backend/font_util/font.ts` 的 `fontSubset`（含 TTF/CFF/GSUB/GPOS 子集化与纯 JS WOFF2 编码器），前端 SDK 在 `packages/`，基准测试为 `基准测试.test.ts`（puppeteer 无头渲染 + SSIM）。

## 目标（按优先级）
1. **正确性不可破**：任何改动后基准必须全 PASS，且与改动前基线对比——输出字节应逐字节一致或差异可解释，SSIM 不低于该用例历史值
2. **性能**：继续压缩子集化耗时（avg 与 min 都要看，min 才是真本事，avg 含噪声），以及输出体积
3. **能力扩展**：见「待探索方向」，完成一项验证一项

## 验收流程（每轮改动必须走完）
1. 改动前先跑一次基准留存基线：`pnpx tsx ./基准测试.test.ts`
2. 小步改动：一次只改一个热点，禁止混合多项优化
3. 改动后再跑基准，与步骤 1 结果逐用例对比：
   - 耗时：avg 下降或持平即合格；波动大时跑两次交叉验证（参考 `benchmark_results/BASELINE_2026-08-27.md` 的 min1/min2 对照法）
   - 字节：逐用例对比输出 bytes，不一致必须能解释（如重映射后序列化更紧凑）并写进日志
   - SSIM：不得低于该用例历史值。注意：篆体用例历史 min=0.9876 是原字体光栅化固有差异（已三重验证），**不是回归**，不要试图"修"它
4. TS 改动执行 `pnpm tsc --noEmit` 确认无类型错误（类型错误≈逻辑错误）
5. 全部通过后才写入 `benchmark_results/OPTIMIZATION_LOG.md`

## 硬性约束
- **禁止修改基准测试中 full 的生成方案**；基准结果异常 = 你的代码改动有问题，先自查，不要归咎于浏览器渲染等外部因素
- 优化必须先测量后动手：用 `node --prof` 或微基准定位热点，不做无 profile 支撑的猜测性优化
- 不做回退方案，只实现最好方案；开发期 let it crash，不为兜底乱加 try
- Git：改动留在工作区，禁止 stash/reset；阶段性完成时提醒提交落库

## 工作方式
- 直接开始做，不切计划模式、不询问、不中断，持续自主迭代
- 每个优化节点在 `benchmark_results/OPTIMIZATION_LOG.md` 追加记录：优化方法 / 瓶颈定位证据（profile 数据）/ 前后对比（各用例 avg/min/max、bytes、ssim）/ 下一步方向

## 当前状态（2026-08-27 基线，30/30 用例全 PASS）
耗时已到亚毫秒~毫秒级（ttf 千字文 min 0.3ms、woff2 千字文 min 2.3ms），继续优化需靠 profile 找剩余热点，不要凭旧数据判断瓶颈。详细数据：`benchmark_results/BASELINE_2026-08-27.md`。已完成大项：GSUB 子集化 33×、WOFF2 纯 JS 编码器重构、glyf triplet inline、共享 gidLookup。

## 待探索方向
1. ~~前端 SDK 扫描策略可配置化~~ **已达成（2026-10-25 核验）**：`WebFontCSSMode` 现有 API 即三种模式——`loadFont`（定时轮询，setInterval 默认 1000ms）/ `observeFont`（MutationObserver+input 事件触发，debounce 50ms）/ `loadText`（用户直接传文本，零扫描返回 ITextLoader）；三者共享 IncrementalEngine 的去重/并发池/失败记忆。无需再造 mode 枚举配置项，按场景选 API 即可
2. **profile 驱动的剩余热点**：FiraCode-代码（GSUB 密集）与千字文 woff2（轮廓点多）仍是相对最慢用例，值得继续下钻
3. **输出体积**：表级体积分析工具 `scripts/table-size-analysis.ts`（第 15 轮借此发现 hinting 死表 -36%）。OTF/CFF 侧已测（2026-10-26）：CFF 占 66% brotli 硬下限、GSUB/GPOS 已深度优化、**BASE/vmtx/vhea 是活功能不可删**（竖排 vertical-rl 真实消费，与浏览器不走的 hinting 有本质区别）——OTF 侧无结构性死重，方向饱和
4. **多字体鲁棒性扫描补测试覆盖**（注意区分原字体缺字与真回归）——**已完成（2026-10-26 第 18 轮）**：`scripts/robustness-scan.ts`（24 字体 × 5 文本 × ttf/woff2，头合法性+确定性），首跑揪出 4 个空子集非法输出 bug 并双层修复（ttf writeZeroContoursGlyfData 12B header + tofu .notdef 注入救 woff2 spec 盲区），120/120 PASS。**遗留**：白狐 OTF（font/temp）被 temp_cleaner 清除，下载源全反爬，需人工恢复后补跑全量基准
5. ~~scripts/ 侧遗留维护~~ **已清零（2026-10-26 第 19 轮）**：test-leafer-node.mts 2 类型错误已修（Buffer.from + @types/pngjs），`pnpm exec tsc -p tsconfig.scripts.json` 首次全净；robustness-scan 升级三层校验（头合法性+确定性+OTS 真实加载，puppeteer FontFace），240 产物全过。**唯一遗留**：白狐 OTF 人工恢复（font/temp/BaiHuOTFJiaoYuHanZi-2.otf）→ 补跑第 18 轮欠的全量基准（writeZeroContoursGlyfData + tofu .notdef，字节影响已可解释，SSIM 预期不变）

## vendor js→ts 迁移路线（2026-10-25 启动）→ **已全部完成（2026-10-27 终结）**
vendor/fonteditor-core 全部 131 个 js 已迁为 TS + 原生 ESM（4 个 sub agent 并行批次：common/graphics/math 叶子、ttf/util+svg、ttf/table+cff、reader/writer/facade/woff2）。**零 js 残留**（含 main.js→main.ts ESM 重写）。

**迁移中发现并修复的坑（重要）**：
- **tsx/node ESM 对 CJS 的 interop 不识别 `__esModule`**：ESM 入口 `import X from './cjs.js'` 拿到整个 module.exports 而非 `exports.default`，报 "X is not a constructor"。此前指纹验证（/tmp 下 CJS 入口跑）与 vite build（打包器 interop 正确）都测不出，只有仓库 ESM 入口（基准测试/后端 dev）会崩——**验证必须覆盖 ESM 直跑路径**。中间态曾用 interopDefault 包装层过渡，全迁完已整体删除。
- 运行时 `require()`（DOMParser 的 @xmldom/xmldom、woff2 的 zlib）在 ESM 下全部改为 `import * as`（zlib LLRT 内置同名 API，静态 import 安全；@xmldom 走 createRequire 惰性 Proxy）。
- 迁移会引入新类型错误（BoundBox|false 联合、let 变 const 改坏循环变量等）：批次C 曾把 readWindowsAllCodes 的 startId 误改 const（format12 字体必崩），靠字节级双管线对比脚本（scripts/verify_table_migration.ts，108 断言）抓回。
- vite 的 commonjs 转译插件与 patch-interop 插件（vite.config.ts）现已无消费对象，可择机删除简化。

**终验（2026-10-27）**：tsconfig.scripts/app 两项目 tsc 0 错误；指纹 4/4 逐字节一致；基准 22 个现存字体用例全 PASS（30 用例中 8 个依赖 font/temp 易失字体被清，含白狐 OTF——恢复后需补跑）；vite-ssg build 通过；ESM 直跑（tsx 仓库根入口）正常。

## 性能候选点备忘（2026-10-25 profile 实测，FiraCode-代码 woff2 avg 1.43ms 微基准）
- `processChunkSync`（node:zlib brotli q2）：14.8% 自耗时——已到拐点，q1/q0 体积损失不值，**不动**
- `collectReachableGsubTargets` 系列（gsub-reachable.ts）：合计 ~12.4%，已是 TS 且多轮深挖；剩余空间可能在 lookups 解析阶段的 dv 读取合并
- `read @glyf.js`（5.7%）+ `dump @ttfwriter.js`（2.0%）+ `write @write.js`（1.9%）：vendor js 解析/序列化主链，**js→ts 重写时顺带优化**（如热路径去对象分配）
- `ceilReduceAndSizeFlat @optimizettf.js`（2.2%）：null 检查/取整逻辑可尝试位运算化
- `__name @gsub-subset.ts`（2.4%）：tsx 的 CJS/ESM interop 包装开销，构建产物无此问题，仅 dev 现象，**不修**
