# LumioProfile

可选的跨运行环境性能采集与分析插件，以 Perfetto 为分析核心，面向浏览器、Unity + PuerTS 和独立服务器。包名 `@lumio/profile`、工具包 `@lumio/profile-tools`（CLI `lumio-profile`），当前版本 `0.2.0`（仓库安装或 `npm ci` 时通过 `prepare` 自动构建 `dist/`）。

已打通可选语义埋点采集、采集中持续排出、两阶段并发停与有界漂移外推时钟校准、可选运行时自动采集（浏览器 rAF / LongTask / LoAF / JS Self-Profiling，Node GC / 进程内 V8 CPU 采样）、原生 Perfetto `.pftrace` + `.cpuprofile` 导出和 Agent CLI 查询。**Unity/PuerTS 的真实运行环境、WebGL GPU 计时与物理屏幕呈现尚未在目标真机验证。**

插件提供观测接口、环境适配、长短时采集、按需或混合统计（Trace / Stats / Hybrid）和 Agent 分析能力。游戏或引擎自行决定是否接入、在哪里埋点；本仓不负责替游戏埋点，也不要求现有项目强制安装插件。

## 阅读入口

- [当前运行指引](.spec/knowledge/standards/mvp-usage.md)：构建、容量估算、COOP/COEP 高精度计时、开发态令牌下发、三端 `connect()` 接入及 Agent CLI 命令。
- [当前能力与实现矩阵](.spec/knowledge/features/mvp-runtime.md)：每项能力明确标注「已实现 / 未实现」、紧凑缓冲容量、外推时钟模型与支持边界。
- [验证与开销记录](.spec/knowledge/standards/verification.md)：Windows 与 macOS 实测回归证据、基准方法与未验证边界。
- [性能基准方法](.spec/knowledge/standards/benchmark-method.md)：统一负载、噪声对照、原始数据与通过/未通过/证据不足的三态判定。
- [插件设计](.spec/knowledge/features/profile-plugin.md)：可选边界、Debug/Release、统一接入、数据模型与开销预算。
- [SDK 接口与包结构](.spec/knowledge/features/sdk-contract.md)：三个环境子入口、独立单文件浏览器声明、观测与装配接口。
- [采集协议与跨端关联](.spec/knowledge/features/capture-protocol.md)：原始记录、时钟校准与外推误差、会话代次身份、因果关联、持续排出和 Perfetto 转换。
- [接入使用指引](.spec/knowledge/standards/integration-guide.md)：无包构建、双层开关、三端最小示例、引擎标记合并与数据质量检查。
- [Agent 采集分析流程](.spec/knowledge/features/agent-capture-analysis.md)：发现目标、采集、校验、内置/自定义 SQL 查询、证据与源码关联。
- [已确认决策](.spec/decisions/README.md)：ADR-001 至 ADR-006。
- [知识导航](.spec/knowledge/README.md)：文档索引与状态总览。

本仓与 LumioEngine、LumioGameNext 同级，仅维护插件与独立分析工具，不修改其他仓库。

## 本地运行与一键验证

```text
npm ci
npm run setup:perfetto
npm run verify
```

`npm ci` 会通过 `prepare` 自动生成 `dist/` 与独立类型声明。`setup:perfetto` 自动识别本机 `HTTPS_PROXY` / `HTTP_PROXY`（覆盖 Windows x64、macOS arm64/x64、Linux x64/arm64/arm），校验官方 Perfetto v58.2 SHA-256 并完成首次 `--version` 预热。

`npm run verify` 依次执行 `typecheck`、49 项单元与回归测试、隔离目录无插件裁剪验证（`verify:optional`）、Perfetto 转换与零导入错误验证（`verify:perfetto`）、Node 主线程 + Worker + CPU 采样全链路演示（`demo`）、Chrome 双页面 + 双 Worker + COOP/COEP 共享时间轴验证（`verify:browser`，headless）及文档链接检查（`verify:docs`）。所有产物写入本地 `artifacts/`，默认不上传。

性能复测使用 `npm run benchmark`、`npm run benchmark:throughput`、`npm run benchmark:browser`，必要时补充 `npm run benchmark:cpu`，均应串行执行。
