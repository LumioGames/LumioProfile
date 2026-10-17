# 知识导航

第一版实现与运行指引已交付；整体设计文档继续描述完整方向，不能据此推定后续能力已经实现。实际支持与验证以 mvp-runtime、mvp-usage 和 verification 为准。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [mvp-runtime](features/mvp-runtime.md) | 第一版实际交付范围、协议限制和验证证据；判断当前能力与未验证边界时查 | 已交付 |
| [mvp-usage](standards/mvp-usage.md) | 第一版构建、三端接入和 Agent 命令的可执行指引；安装本地包或跑通采集分析时查 | 已交付 |
| [verification](standards/verification.md) | 第一版构建、隔离、端到端和开销验证的实测记录；评估验证覆盖与性能限制时查 | 已交付 |
| [benchmark-method](standards/benchmark-method.md) | 性能基准的固定负载、噪声对照、三态判定与复测方法；运行或解释性能预算时查 | 已交付 |
| [profile-plugin](features/profile-plugin.md) | 可选性能插件的边界、构建开关、统一接入与数据契约；讨论架构和开销时查 | 设计中 |
| [sdk-contract](features/sdk-contract.md) | 采集包与环境子入口、观测和装配接口及版本边界；讨论 SDK 契约和发布结构时查 | 设计中 |
| [capture-protocol](features/capture-protocol.md) | 采集记录、时钟校准、身份关联、缓冲丢弃与 Perfetto 转换；讨论数据可信度和跨端分析时查 | 设计中 |
| [agent-capture-analysis](features/agent-capture-analysis.md) | Agent 从目标发现到采集、质量校验、Perfetto 查询与证据交付的流程；讨论自动分析时查 | 设计中 |
| [integration-guide](standards/integration-guide.md) | 可选插件的宿主接口、无包构建、双层开关和三类环境接入；接入与验证时查 | 设计中 |

已确认选型见 [决策索引](../decisions/README.md)。设计问题集中在 [插件设计的讨论项](features/profile-plugin.md#继续讨论的设计项)，它们是设计分歧，不是已派发任务。
