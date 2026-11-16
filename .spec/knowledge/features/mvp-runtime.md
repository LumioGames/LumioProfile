---
name: mvp-runtime
description: 当前实际交付范围、已实现/未实现能力矩阵、容量估算、协议限制和验证证据；判断当前能力与未验证边界时查
metadata:
  type: doc
  status: 已交付
---

# 当前运行能力与实现边界

仓库当前提供本地 `0.2.0` 实现（`npm ci` 通过 `prepare` 自动构建 `dist/` 与独立声明），遵循 [ADR-001](../../decisions/ADR-001-optional-plugin-and-perfetto.md) 至 [ADR-006](../../decisions/ADR-006-continuous-drain-clock-extrapolation-and-auto-collectors.md)。本页与 [运行指引](../standards/mvp-usage.md) 是当前真实实现范围的权威入口。

## 能力矩阵（明确标注已实现 / 未实现）

| 能力项 | 状态 | 实际行为与边界 |
| --- | --- | --- |
| 采集包与三端隔离入口 | **已实现** | `@lumio/profile` 提供 `/`、`/browser`、`/browser-standalone`、`/node`、`/puerts`、`/contract`；PuerTS 另有零全局依赖 CJS 产物 |
| 无依赖宿主契约与独立浏览器类型 | **已实现** | `contracts/observation-v1.d.ts`（及包内 `@lumio/profile/contract`）零外部依赖；`contracts/browser-v1.d.ts`（及 `@lumio/profile/browser-standalone`）为零相对导入的单文件声明，便于开发服务模块重定向 |
| 运行模式（Off / Trace / Stats / Hybrid） | **已实现** | 默认 Off；支持 `trace`、`stats` 以及同场同时采集区间与统计时间序列的 `hybrid` 模式；Release 默认拒绝，需宿主显式 `policy.allowRelease: true` |
| 会话代次区间令牌与非严格 LIFO 恢复 | **已实现** | `scopeToken` 高位编码会话代次，上一场重读槽位的迟到 `end` 安全忽略、不误关新场区间；内层漏 `end` 时自动弹出未闭合内层并标 `partial`，不污染后续兄弟区间 |
| 可选异步区间（`beginAsync` / `endAsync`） | **已实现** | 支持重叠异步区间并在 Perfetto 中自动分配不重叠轨道泳道，标记 `measurementKind: 'async-wall'`，不混入同步 `observedSelfMs` |
| 标记清单详细校验与合并 | **已实现** | 装配时逐条校验 ID、长度、字段数、直方图单调桶并写入 `validationErrors` / `inspect()` / `prepare()`；提供 `mergeMarkers()` 合并引擎与游戏标记表 |
| Writer 故障通知（`onFault` / `onStateChange`） | **已实现** | `clock-fault`、`writer-fault`、`scheduler-fault` 自动卸载槽位并通过 `onFault` 通知宿主（异常隔离不抛入业务） |
| 一体化连接器 `connect()` 与 `MessagePort` 通道 | **已实现** | `profiler.connect({ endpoint, token })` 封装首帧认证（令牌不进 URL）、`helloAck` 确认、指数退避自动重连与 `close()`；另提供 `messagePortChannel()` |
| 紧凑变长槽位与采集中持续排出（`drain`） | **已实现** | 数值列 64B + 环形变长 UTF-16 文本池均摊 16B（共 80B/条，8MiB 约 104,652 条）；服务后台周期 `drain(ackSeq)` 确认释放槽位，支撑多分钟连续采集 |
| 两阶段并发停止、分页重试与单来源补拉 | **已实现** | `stop` 先并发停稳所有来源，再做停后尾部校准，最后分页拉取（每页 512 条、瞬时故障自动同偏移重试 3 次）；部分失败可用 `pull` 单独补拉；导出后自动释放服务内存，无 4 场硬上限 |
| 有界漂移外推时钟对齐与退回原因诊断 | **已实现** | 忙主线程错过单次窗口时，同 `clockId/clockEpoch` 在 `maxExtrapolationMs`（默认 60s）内按最近样本线性放大不确定度保留在共享时间轴；无法对齐时在 `domainDiagnostics` / `manifest.json` 报告精确 `fallbackReason` |
| 浏览器可选自动数据源（rAF / LongTask / LoAF / JS 采样） | **已实现** | Off 不启动；`collectors` 显式请求时按环境支持开启 `raf`、`longtask`、`long-animation-frame` 及 `Profiler`（需页面配置 `Document-Policy: js-profiling`） |
| Node 可选自动数据源（GC / 进程内 V8 CPU 采样） | **已实现** | Off 不启动；`collectors` 显式请求时开启 `perf_hooks` GC 观察与当前线程进程内 `node:inspector` CPU 采样（零网络端口），同时生成共享时间轴 Perfetto 火焰图轨道与 `native/*.cpuprofile` |
| Perfetto v58.2 转换、分位数/按帧/CPU 热点与自定义 SQL | **已实现** | $O(N)$ 父子归组、无调用栈溢出循环求极值、单次分析复用；内置 `overview`、`hotspots`、`percentiles`、`frames`、`cpu-hotspots`、`runtime`、`queues`、`operation` 及 `--sql` / `--sql-file` |
| 停止后延长业务收尾宽限窗口（>0ms） | **未实现（固定为 0）** | 停止立即撤销写入槽位（宽限为 0），未闭合区间如实记入 `openSpans`；跨会话迟到 `end` 按代次安全忽略 |
| 原始批次 Protobuf / 流式压缩与跨进程重连续传 | **未实现** | 控制通道仍用有界 JSON 批次；进程断开前的未排出记录不跨新连接续传 |
| 分段线性时钟漂移拟合与多跳校准 | **未实现** | 当前为四时间点有界偏移 + 最近样本有界漂移不确定度扩张，不做跨样本回归斜率拟合 |
| WebGL / 原生 GPU 计时与物理屏幕呈现测量 | **未实现** | `capabilities.gpu = false`、`physicalPresent = false`；rAF 仅代表回调间隔，绝不等同屏幕物理上屏 |
| Unity / PuerTS / Mono / IL2CPP 真机运行与原生 Profiler 导出 | **未实现 / 未验证** | 仅完成 TS 隔离沙箱与纯 .NET 桥接契约测试，未在真实 Unity 编辑器或 Player 中实测 |
| MCP 服务包装与自研可视化时间线 UI | **未实现** | Agent 直接使用 JSON CLI 或程序化 API，可视化直接复用官方 Perfetto UI |

## 缓冲容量与采集时长估算

每条 Trace 记录槽预算为 **80 bytes**（64 bytes 数值列 + 16 bytes 变长 UTF-16 环形文本池份额；无字符串记录零文本池消耗），固定基础与开放区间元数据约 16 KiB（默认 `maxOpenSpans = 128`）。注意：一场同步区间（`begin` + `end`）占 **2 条记录**。

| 每秒业务负载（单线程） | 每秒记录数（条/秒） | 8 MiB 纯静态缓冲（约 104,652 条）可采时长 | 32 MiB 纯静态缓冲（约 419,225 条）可采时长 | 开启服务默认持续排出（`drain`）可采时长 |
| --- | ---: | ---: | ---: | --- |
| 20 Hz 房间线程 × 每步 10 个区间 | ~400 | **~261 秒（4.3 分钟）** | **~17 分钟** | 受 `maxRecordsPerSource`（默认 100 万条，约 **41 分钟**）限制 |
| 60 FPS 客户端主线程 × 每帧 10 个区间 | ~1,200 | **~87 秒（1.4 分钟）** | **~5.8 分钟** | 默认 100 万条上限可连续采 **~13.8 分钟** |
| 60 FPS 重度埋点 × 每帧 40 个区间 | ~4,800 | **~21.8 秒** | **~87 秒** | 默认 100 万条上限可连续采 **~3.4 分钟** |
| 120 FPS 高刷客户端 × 每帧 25 个区间 | ~6,000 | **~17.4 秒** | **~70 秒** | 默认 100 万条上限可连续采 **~2.7 分钟** |

估算公式：

$$\text{静态可采秒数} \approx \frac{\lfloor (\text{maxBytes} - 16384) / 80 \rfloor}{\text{帧率} \times (\text{每帧区间数} \times 2 + \text{每帧单点事件数})}$$

默认策略 `policy.maxDurationMs` 为 300,000ms（5 分钟），单来源上限 1,000,000 条，单场工具端聚合上限 256 MiB，导出包总上限 512 MiB。当请求 `--bytes` 或 `--duration` 超过某来源宿主 `policy` 上限时，`prepare` 自动协商降级至该来源上限并在计划中返回实际接受值。

## 时钟模型与跨线程时间轴

工具在 `start` 后、运行期间（默认每 1000ms，单来源不重叠排队避免慢帧堆积）及 `stop` 停稳后各采一次四时间点样本。默认参数可在 `createService({ calibration })` 或 CLI `serve --clock-interval / --clock-valid-for / --clock-drift-ppm / --clock-precision` 中配置，且自动读取源端上报的 `clock.precisionMs`（如浏览器 COOP/COEP 下的 0.005ms 或未隔离下的 0.1ms）。

- 直接窗口覆盖（`[b2 - validForMs, b3 + validForMs]`）：取多样本交集区间中点与半宽误差。
- 最近样本有界外推（超出直接窗口但距离最近同代次样本 $\Delta t \le \text{maxExtrapolationMs}$，默认 60s）：保持在共享参考时间轴上，不确定度按 $\text{baseHalfWidth} + \Delta t \times \text{maxDriftPpm} \times 10^{-6}$ 放大，并在 `warnings` 与事件注解中标明 `clockExtrapolated: true`。
- 退回独立本地时间域：仅当无校准样本（`no-calibration-samples`）、时钟代次不匹配（`clock-epoch-mismatch`）、样本矛盾（`conflicting-clock-mappings`）、参考域混杂（`mixed-reference-domains`）或超出最大外推时限（`extrapolation-limit-exceeded`）时退回 `local:<streamId>`，并在 `quality.json` 与 `manifest.json` 的 `domainDiagnostics` / `fallbackReasons` 中明确写出原因。

## 验证口径

| 场景 | 当前证据 |
| --- | --- |
| 无插件隔离构建与裁剪 | 在仓库目录树外的系统临时目录验证 `@lumio/profile` 不可解析时完成普通 TS 检查、esbuild 打包（裁剪产物 76 bytes，Off 产物 155 bytes）及单文件 `browser-v1.d.ts` 类型检查，绝不改名工作区 `node_modules` |
| Off 与跨场隔离 | 49 项自动化测试覆盖 Off 零计时/零分配、代次区间令牌防撞、到期零伪缺口、非严格 LIFO 栈恢复、异步区间、32,000 区间 $O(N)$ 分析、150,000 事件转换、分页重试、`pull` 补拉、连续多场采集与断线自动重连 |
| Node 主线程 + Worker + CPU/GC | 真实 CLI 驱动主线程与 Room Worker，同时开启 `gc,cpu` 自动采集，验证队列等待与 `cpu-hotspots` 同轴查询 |
| Chrome 双页面 + 双 Worker | 本机 Chrome（headless），开启 COOP/COEP 高精度计时（`crossOriginIsolated: true`）与 `raf,longTasks,longAnimationFrames,cpuSampling`，4 个来源对齐至同一共享 Perfetto 时间轴 |
| Unity / PuerTS | 仅验证 TS 沙箱无全局依赖与纯 .NET 时钟/调度契约；**无真实 Unity / PuerTS / Mono / IL2CPP 运行验证** |
