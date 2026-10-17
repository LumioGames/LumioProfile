# 决策索引

ADR 记录已经确认的取舍与理由。未确认的接口和预算留在功能设计中，不因文档落盘而变成实现授权。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [ADR-001](ADR-001-optional-plugin-and-perfetto.md) | 独立可选插件，以 Perfetto 支撑单次采集分析 | Accepted |
| [ADR-002](ADR-002-host-contract-and-optional-injection.md) | 宿主持有无依赖观测契约，可选注入实现，分开编译裁剪与运行时开关 | Accepted |
| [ADR-003](ADR-003-runtime-subpaths-and-independent-tools.md) | 一个采集包带三个环境子入口，工具包与 Unity 原生包独立 | Accepted |
| [ADR-004](ADR-004-trace-overflow-policy.md) | 普通 Trace 保留已有记录、满时丢新详细事件，循环覆盖显式选择 | Accepted |
| [ADR-005](ADR-005-first-version-runtime-boundary.md) | 第一版有限采集、分页排出、固定 Perfetto 与运行验证边界 | Accepted |

本仓 ADR 使用 `ADR-NNN-<主题>.md`，前 12 行包含 `状态：Draft / Accepted / Superseded` 与日期。正文包含背景、决策、替代方案、影响及重新评估条件。已确认决策的变更用新 ADR 表达。
