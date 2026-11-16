---
name: verification
description: 第一版构建、隔离、端到端和开销验证的实测记录；评估验证覆盖与性能限制时查
metadata:
  type: doc
  status: 已交付
---

# 验证与开销记录

## 2026-11-16 v0.2.0 升级回归（macOS arm64 · Node 22.23.2 · Chrome 157 · Perfetto v58.2）

针对 NextWorld 接入实测与仓库复评暴露的跨场令牌碰撞、串行停机、忙主线程时间轴退回、4 场会话上限、8MiB 仅 8162 条容量、$O(N^2)$ 分析、展开运算符栈溢出及缺少自动采集源等问题，在本仓独立合成宿主与自动化回归套件中完成升级核验（仅修改本仓，未改其他仓库）：

| 命令 | 实际结果 |
| --- | --- |
| `npm ci / typecheck / build` | 通过；`prepare` 自动构建三端独立入口、单文件零导入 `contracts/browser-v1.d.ts`、内置 `observation-v1.d.ts` 与工具包；0 漏洞 |
| `npm test` | **49 项全部通过**（原 41 项 + 新增 8 组回归：代次令牌防撞、到期零伪缺口、非严格 LIFO 恢复与异步区间、8MiB 104,652 槽与 32KiB 持续排出 2500 条零丢弃、并发停机与有界外推、分页重试与 `pull` 补拉、单服务连续 >4 场、32,000 区间 $O(N)$ 分析与 150,000 事件转换、进程内 CPU 采样/GC/混合统计时间序列及自动重连） |
| `npm run verify:optional` | 仓库目录树外独立临时目录验证（不改名工作区 `node_modules`）：完全裁剪产物 **76 bytes**、保留 Off 判断产物 **155 bytes**；独立单文件 `browser-v1.d.ts` 类型检查通过；PuerTS VM 零全局隔离通过 |
| `npm run setup:perfetto` | 自动识别代理环境变量并支持 6 类桌面/服务器平台（含 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-x64`），下载后预热 `--version` 校验通过 |
| `npm run verify:perfetto` | 官方 `trace_processor_shell` v58.2 导入 `.pftrace`，查出 1043ms 排队等待、9ms 执行与 1 条因果 Flow，导入错误计数为 0 |
| `npm run demo` | Node 主线程与 Room Worker 通过首帧认证 `connect()` 连接，开启 `gc,cpu` 自动采集并经真实 CLI 查出队列等待与 `cpu-hotspots` |
| `npm run verify:browser` | 本机 Chrome 157（headless，移除自动化禁节流默认参数），开启 COOP/COEP + `Document-Policy: js-profiling`（`crossOriginIsolated: true`，实测 `precisionMs: 0.005`），2 个页面 + 2 个 Worker 共 4 个来源同步停机、采集 `raf` 与 JS Self-Profiling 栈样本，合并至 **1 个共享 Perfetto 时间域** |
| `npm run verify:docs` | 23 份 Markdown 文档 YAML frontmatter 与相对链接核验通过 |
| 热点吞吐复核 | `benchmark-hotpath.mjs` 600 万对 span（1200 万条记录）耗时约 1.52s（~126ns/条），8MiB 保留 104,624 条；600 万组 × 3 次 Stats 更新耗时约 0.58s |

未验证边界保持诚实标注：**Unity / PuerTS / Mono / IL2CPP 真实运行环境、WebGL / 原生 GPU 计时、OS 真实物理窗口前后台切换与物理屏幕呈现测量尚未在目标环境验证。**

---

## 2026-10-16 v0.1.0 初始验证与开销基线（Windows x64 · Node 24.18.0）

真实101游戏的后续本机验证见 [外部接入证据](../../archive/evidence/2026-10-16-101-game-validation.md)：solo、独立DS、双浏览器和GAS身份链已实际采集；结论为受限可行，严格CPU/p99预算仍证据不足。下文保留第一版合成宿主实验的原始范围，不用后续游戏结果改写它。

验证日期：2026-10-16。本轮仅修改 lumio-profile，使用独立合成宿主，未修改或复测真实游戏。环境为 Windows 10.0.26200、i5-12600KF（16 逻辑处理器）、Node 24.18.0、本机 Chrome 155.0.8059.84、官方 Perfetto v58.2-add693d8b。

**功能与隔离回归通过；严格性能预算尚未全部得到证明。** 判定分为通过、未通过、证据不足，方法见 [性能基准](benchmark-method.md)。可供 Agent 读取、进入版本库的汇总为 [本次结果 JSON](../../../benchmarks/results/2026-10-16.json)，包含 SDK/基准源码摘要、原始数据摘要、各项区间和判定。较大的原始样本、源码副本、CPU profile 留在本仓被忽略的 artifacts，未上传。

## 本轮功能与隔离回归

| 命令 | 实际结果 |
| --- | --- |
| npm run typecheck / build | 通过；三个独立入口、PuerTS CJS、独立工具产物 |
| npm test | 37 项通过，包含 Off、Release、稀疏标记、过滤、直方图边界、最大 Stats 目录、缓冲复用、旧 writer、时钟、关联、导出及 Agent 控制 |
| npm run verify:optional | 消费者无法解析插件时完成类型检查、构建和运行；小型裁剪样例 76 bytes，保留 Off 判断样例 155 bytes；PuerTS VM 隔离通过 |
| npm run verify:perfetto | 官方二进制导入原生文件，查询出 1043ms 等待、9ms 执行及一个 Flow，导入错误计数为零 |
| npm run demo | Node 主线程与 Worker，通过实际 CLI 完成采集、导出与官方查询 |
| npm run verify:browser | Chrome 两个页面及两个 Worker 完成采集、导出、查询；保留真实启动参数 |

本轮端到端证据：`artifacts/perfetto-ostI8t/capture`、`artifacts/node/demo-fDobE7/928c75bd-cb44-4bfe-a679-239777af9091`、`artifacts/browser/e988948b-8b55-4122-9b13-b39c318d0059`。本轮未重跑未修改的纯 C# 测试，也未重新打包或发布 npm 包；原纯 .NET 和本地包安装记录不能当作本轮 Unity 验证。

Off 的确定性检查验证关闭判断先于采集时钟、参数构造、缓冲、定时器和原生调用；满后丢新也不继续读取事件时钟，stop/release 后旧 writer 不再工作。这不等于空槽位判断、静态装配或显式控制连接的 CPU 成本为零。

默认 Off 从未开启时没有采集缓冲。stop 后待导出记录仍可保留，release 才解除存储引用；这不承诺 JS 引擎立即把内存交还操作系统。

## 噪声与真实成本

旧脚本每档只有 80 个 tick，p99 接近最大样本；一次基线 CPU 为零；20Hz 与吞吐的计算函数还不同。因此旧数据不参与本轮预算判定，也不能用来声称优化幅度。

修正后共用一个 Int32 工作负载，每 tick 12 个系统。每系统 Trace 一对无 context 的 span，Stats 三次聚合，每档 2000 对 20Hz 样本；吞吐 64 对，每块 256 tick。加入 A/A 基线对照、AB/BA 交替、固定随机顺序、预热、生命周期单列及源码摘要校验。默认保留旧记录、满后丢新和显式循环覆盖分开验证。每对业务结果一致，不删除异常点，不强制 GC。

实际发现：短 CPU 区间的读数常在 78/94ms 等值之间跳变，约 16ms 的计数粒度显著影响百分比。补充 32 对、每块 2048 tick 的长窗口，计入八次采集重建、预填和记账成本；A/A CPU 区间仍为 -0.61%～+2.97%，并存在明显墙钟波动。长窗口不能当成纯热路径 CPU，也没有消除环境不确定性。

## 按证据保留的优化

- **Off**：没有发现可归因于采集器的关闭态热点，保留零采集动作契约，没有为追逐 0.2% 的噪声修改宿主执行路径。
- **Stats**：采集开始时把不可变标记信息与聚合数据关联，热更新只做一次 Map 查找。稀疏 ID、过滤、类型校验、直方图和快照接口保持不变。
- **Node Trace**：热点采样指向逐事件 BigInt 时钟读取和转换，改用 Node performance 毫秒时钟，记录实际 basis/timeOrigin。时间仍是区间墙钟，跨来源仍校准，旧采集描述继续可读。[Node 时间接口](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow)

独立热点实验每次 600 万组操作，8 对独立进程，交替前后顺序，不开启 CPU 采样计时；Trace 使用显式循环覆盖且不带 context。Stats 纯聚合墙钟下降 **23.85%**（95% 区间 22.37%～25.21%）；Node Trace 纯采集下降 **20.85%**（19.81%～21.59%）。这只证明这些热点变快，不是游戏 CPU 或帧预算验收。证据在 `artifacts/benchmark/hotpath-2026-10-16T12-24-37.332Z/comparison.json`，前后 SDK 摘要已收入汇总。

相同业务负载下，吞吐墙钟的观测增量由 Stats 1.48% 到 1.13%、Trace 未满 3.41% 到 1.95%、循环覆盖 2.80% 到 1.30%；Off 为 0.38% 到 0.72%，满后丢新为 0.71% 到 0.80%。不同时间运行的点估计差不是收益置信区间，不能据此宣称 Off 变慢或 CPU 达标。

## 预算结论

| 项目 | 结论 | 依据与边界 |
| --- | --- | --- |
| 无插件构建、完全裁剪 | **通过** | 无法解析插件时实际构建运行；检查裁剪产物 |
| Debug/Release 默认 Off、关闭后零采集动作 | **通过** | 确定性契约测试；不声称保留分支零 CPU |
| Off CPU ≤0.2% | **证据不足** | 短/长窗口噪声均不能分辨此预算 |
| Stats CPU ≤1% | **证据不足** | 热点收益成立，业务 CPU 区间仍跨越预算 |
| Stats tick p99 增量 ≤0.1ms | **证据不足** | Node 区间加噪声超过阈值；Chrome 约 0.1ms 时钟粒度不足 |
| Trace CPU ≤5%，三种缓冲状态 | **证据不足** | 短窗口量化显著；含生命周期的长窗口仍跨越预算，不能以墙钟代替 |
| Trace tick p99 增量 ≤0.5ms，三种缓冲状态 | **通过** | 最终 Node 和 headless Chrome 均通过本次合成场景判定 |
| Stats 预留存储 ≤256KiB/source | **通过（预留账本）** | 基准为 14.5KiB；256 个标记、各 32 阈值测试为 140KiB；不是所有 JS 堆分配的精确上界 |
| Trace 8MiB 配置内、丢弃规则与完整性 | **通过** | 本基准预留 8,388,096 bytes，未满/丢新/覆盖状态均检查，业务结果一致 |
| 有可靠证据的预算失败 | **本轮无** | 未满足通过条件的项目保持“证据不足”，没有反向解释为合格 |

最终 20Hz p99 增量（ms）。通过要求“区间上界 + 噪声包络 ≤ 预算”；Node 包络 0.0843ms，Chrome 包络约 0.3000ms，后者含时钟量化项。

| 环境 / 模式 | 点估计 | 95% 区间 | 判定 |
| --- | ---: | --- | --- |
| Node Stats | +0.0078 | [-0.0517, +0.0719] | 证据不足 |
| Node Trace 未满 | +0.0700 | [-0.0054, +0.1208] | 通过 |
| Node Trace 丢新 | +0.0039 | [-0.0440, +0.0444] | 通过 |
| Node Trace 覆盖 | +0.0035 | [-0.1030, +0.0730] | 通过 |
| Chrome Stats | 0.0000 | [-0.1000, +0.1000] | 证据不足 |
| Chrome Trace 未满 | +0.1000 | [-0.1000, +0.1000] | 通过 |
| Chrome Trace 丢新 | -0.1000 | [-0.1000, +0.1000] | 通过 |
| Chrome Trace 覆盖 | 0.0000 | [-0.1000, +0.1000] | 通过 |

长窗口总 CPU 的点估计/区间：Off 3.11% / [1.42%, 5.06%]；Stats 3.52% / [1.73%, 5.40%]；Trace 未满 6.84% / [4.26%, 9.93%]；丢新 7.26% / [5.14%, 9.65%]；覆盖 7.77% / [5.11%, 10.74%]。它们包含频繁重建和预填；每个区间再考虑约 2.97% 噪声后，都无法作预算通过或失败判定。CPU 严格验收需要噪声小于候选阈值的目标环境证据，本次不承诺所有硬件达标。

## 生命周期与环境限制

生命周期在热计时之外记录，模块已经预热，不是冷进程启动。最终 Node 中 Stats prepare/start 中位数 0.0370ms、最大 0.1041ms；Trace 未满为 0.1573ms、最大 0.4405ms。Stats stop 中位数 0.0056ms、最大 0.1177ms；release 中位数 0.0035ms。Chrome 生命周期很多读数为 0，只表示低于约 0.1ms 分辨率，不能据此称为零成本。完整 factory/start/stop/release 样本保留在 raw。

最终调度机会最大迟到为 Node 16.24ms、Chrome 18.80ms；与实际 tick 工作耗时分开记录。Chrome 全程 visibility=visible、headless=true、crossOriginIsolated=false、realOsForegroundValidated=false。没有用模拟状态代替 OS 前后台验证。浏览器 CPU、GC、GPU 和物理呈现均没有由本基准测量。

Unity/PuerTS 的真实装配、Mono/IL2CPP、原生跨界成本、原生 Profiler/CPU/GPU、真实远程 DS、两个独立浏览器进程及 OS 前后台状态仍未验证。PuerTS VM 隔离、纯 .NET 和 Node Worker 测试不能代替这些验证。当前性能负载没有关联字段、复杂实体上下文、控制连接或同步导出，不外推到这些情形。

时钟校准的 1ms 精度、1000ppm 漂移假设仍需目标环境验证；当前为条件估计。1043ms/9ms 等数值来自合成验收输入，并非本工具重新抓到 101-bomber 的真实故障。游戏 20Hz 权威、GAS、输入与结算未改动。

## 证据索引

以下目录均位于 `artifacts/benchmark/v2/`，包含 raw、summary、基准和 SDK 源码副本与 SHA-256：

| 用途 | 目录 |
| --- | --- |
| 优化前吞吐 | 2026-10-16T12-15-48.522Z-node-throughput-before |
| 优化后吞吐 | 2026-10-16T12-25-13.041Z-node-throughput-after |
| 最终长 CPU 窗口 | 2026-10-16T12-29-16.771Z-node-cpu-window-final |
| 最终 Node 20Hz | 2026-10-16T12-35-02.612Z-node-paced-final |
| 最终 Chrome 20Hz | 2026-10-16T12-37-06.587Z-browser-paced-final |

上述五份归档的源码摘要与副本、配对业务结果已校验一致。`provenance-audit.json` 保留核验结果。`2026-10-16T12-26-55.813Z-node-paced-after` 运行中基准文件发生变化，结束时复制的三个源码副本与启动摘要不一致，**不计入验收**；原记录保留。现已改为启动时冻结源码副本，并完成最终复测。旧 80 样本结果也保留但不参与本轮结论。
