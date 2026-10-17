# ADR-001：独立可选插件，以 Perfetto 支撑单次采集分析

状态：Accepted

日期：2026-10-16

## 背景

Lumio 需要一套可复用性能分析工具，让开发者和 Agent 从操作、行为或卡帧追到等待与执行区间。产品面向浏览器前端、通过 PuerTS 复用 TS 逻辑的 Unity 前端，以及独立服务器。

101-bomber 的历史延迟现象用于验证工具的归因能力，本仓的目标不是继续修复该游戏。接入方决定是否安装、启用和埋点。

## 决策

1. 在独立同级仓库 `LumioProfile` 设计可选插件包，不把采集器变成 Engine 或 Games 的强制依赖。
2. 本仓提供通用观测、环境适配与分析能力；引擎与游戏的埋点由接入方负责。
3. 以 Perfetto 作为时间线与查询核心，人和 Agent 使用同一份采集数据及版本化分析规则。
4. 第一阶段以一段可分享采集会话的深入分析为中心。保留低成本实时统计能力，但需要时才启用，不默认常驻。
5. 区分 Debug、Release 构建能力和运行时采集状态。安装或连接分析工具不代表启用采集。
6. 浏览器与 Unity 共用 TS 层语义；Unity 使用 PuerTS，并接入原生表现数据；服务器不依赖 Unity。
7. 分析工具可独立部署，不要求业务平台承担持续遥测基础设施。

本决策确认产品方向，不冻结 SDK 签名、Release 裁剪入口、协议编码、采样后端或开销阈值；当前仅整理设计，尚未授权实现。

## 替代方案

| 方案 | 评价 |
| --- | --- |
| 从零建设完整时间线与性能分析界面 | 维护成本高，优先复用 Perfetto；仅补必要的采集入口和语义分析 |
| OpenTelemetry + Grafana Tempo / Pyroscope 作为首期主体 | 适合持续汇聚、历史检索和线上趋势，当前单次会话分析不需要先承担整套部署 |
| Tracy 作为统一主体 | 原生帧分析能力强，浏览器、Node、PuerTS 的统一接入与 Agent 查询仍需额外适配 |
| 只依赖各端 CPU 采样 | 无法可靠还原目标 tick、排队、预测确认和表现缓冲的因果关系 |

## 影响

插件需要统一语义记录和各端适配，不能依赖 Perfetto 自动识别游戏语义。宿主未提供观测点时，工具只能分析实际收到的数据。

未安装或构建剔除的插件无法远程开启。保留但关闭的插件需要验证关闭成本；开启任何观测都会产生测量开销，不能承诺启用前后性能绝对相同。

## 重新评估条件

若长期线上检索、告警成为明确产品要求，再评估持续观测层；若 Perfetto 扩展无法满足核心分析体验，再评估定制 UI。不得因出现新的运行环境而把游戏语义搬入插件核心。

## 参考

- [Perfetto 自定义数据转换](https://perfetto.dev/docs/getting-started/converting)
- [Perfetto Trace Processor Python API](https://perfetto.dev/docs/analysis/trace-processor-python)
- [Perfetto Agent 工作流](https://perfetto.dev/docs/getting-started/using-ai)
- [Grafana trace 与 profile 关联](https://grafana.com/docs/tempo/latest/visualize-traces/)
- [Tracy](https://github.com/wolfpld/tracy)
