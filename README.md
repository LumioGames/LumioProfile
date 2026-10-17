# LumioProfile

当前仓库目录为 `C:\Work\LumioNext\LumioProfile`，由原 `lumio-profile` 目录改名而来。当前 Git 尚无提交、未配置远端；包名 `@lumio/profile`、CLI `lumio-profile`、协议名及历史证据保持原样。npm workspace 名保留合法的小写 `lumio-profile-workspace`。

可选的跨运行环境性能采集与分析插件，以 Perfetto 为分析核心，面向浏览器、Unity + PuerTS 和独立服务器。

**第一版本地实现已可运行，版本 0.1.0，尚未发布安装包。** 已打通可选采集、原生 Perfetto 导出和 Agent CLI 查询；Unity/PuerTS 的真实运行环境尚未验证。

插件提供观测接口、环境适配、短时采集、按需统计和 Agent 分析能力。游戏或引擎自行决定是否接入、在哪里埋点；本仓不负责替游戏埋点，也不要求现有项目安装插件。

## 阅读入口

- [第一版运行指引](.spec/knowledge/standards/mvp-usage.md)：构建、三端接入、Agent 命令及验证步骤。
- [当前能力与限制](.spec/knowledge/features/mvp-runtime.md)：实际协议、容量、时钟模型和支持范围。
- [验证与开销记录](.spec/knowledge/standards/verification.md)：实际执行证据与未达成/未验证项。
- [性能基准方法](.spec/knowledge/standards/benchmark-method.md)：统一负载、噪声对照、原始数据与通过/未通过/证据不足的判定。
- [插件设计](.spec/knowledge/features/profile-plugin.md)：可选边界、Debug/Release、统一接入、数据模型与开销预算。
- [SDK 接口与包结构](.spec/knowledge/features/sdk-contract.md)：一个采集包的三个环境子入口、独立工具与 Unity 原生包，以及观测和装配接口草案。
- [采集协议与跨端关联](.spec/knowledge/features/capture-protocol.md)：原始记录、时钟校准与误差、会话与事件身份、因果关联、缓冲丢弃和 Perfetto 转换。
- [接入使用指引](.spec/knowledge/standards/integration-guide.md)：无包构建、双层开关、三端最小示例、Agent 命令、缓冲选择与数据质量检查；当前是设计约定。
- [Agent 采集分析流程](.spec/knowledge/features/agent-capture-analysis.md)：发现目标、采集、校验、查询、证据与源码关联。
- [已确认决策](.spec/decisions/README.md)：独立可选插件、Perfetto、宿主无依赖接口、可选注入、包拆分及默认丢弃策略。
- [知识导航](.spec/knowledge/README.md)：设计状态和继续讨论的入口。

本仓与 LumioEngine、LumioGameNext 同级。当前不修改这些仓库，不改 Games 的 `.engine` 缓存，不修改同步参考资料 `sources/`。

## 本地运行

```text
npm ci
npm run build
node scripts/setup-perfetto.mjs
npm run demo
```

demo 使用本仓独立 Node 主线程和 Worker，经真实 CLI 完成采集、导出及官方 Trace Processor 查询。浏览器验证使用 `npm run verify:browser`，明确为 headless。所有工具输出留在本仓 artifacts，默认不上传。

性能复测使用 `npm run benchmark`、`npm run benchmark:throughput`、`npm run benchmark:browser`，必要时补充 `npm run benchmark:cpu` 的长 CPU 窗口；这些命令应串行执行。热点优化已经验证，严格 CPU 预算仍有证据不足项，不能把功能闭环或单次较低读数当作全部性能验收通过。
