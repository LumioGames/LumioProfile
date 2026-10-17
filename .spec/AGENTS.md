# LumioProfile 项目说明

LumioProfile 是独立的可选性能分析插件仓库。第一版已实现一个采集包的浏览器、PuerTS、Node 子入口，独立工具包和可选 Unity 原生桥接包。实际支持范围、协议版本与可执行命令以 mvp-runtime 和 mvp-usage 为准，整体设计中的后续能力不能视为已实现。

普通 Trace 默认保留已有记录、满时丢新详细事件，循环覆盖显式选择。采集协议中的编码、校准参数与数值阈值仍需验证；关联依据、时钟依据和完整性分别表达，不因数据可显示就认为可计算。

## 所有权

| 参与方 | 负责内容 |
| --- | --- |
| LumioProfile | 通用观测契约、可选运行环境适配、采集控制、Perfetto 转换与分析、Agent 接口 |
| 接入方引擎或游戏 | 是否安装、构建选择、启用策略、观测接缝和语义埋点 |
| 分析部署方 | 独立分析入口、采集文件存储和访问配置 |

浏览器与 Unity 前端复用现有 TS 逻辑，Unity 通过 PuerTS 承载 TS 并负责原生表现。服务器独立于 Unity。不能把宿主目前的线程布局、游戏规则或渲染器硬编码成插件要求。

## 文档入口

- [第一版能力](knowledge/features/mvp-runtime.md)
- [第一版运行指引](knowledge/standards/mvp-usage.md)
- [实际验证](knowledge/standards/verification.md)
- [项目约束](rules/system.md)
- [知识导航](knowledge/README.md)
- [SDK 接口与包结构](knowledge/features/sdk-contract.md)
- [采集协议与跨端关联](knowledge/features/capture-protocol.md)
- [接入使用指引](knowledge/standards/integration-guide.md)
- [决策索引](decisions/README.md)

已确认取舍记入 ADR。只修改本仓，不自动接入游戏。保持可选依赖、Off 和数据质量边界；任何能力声明附实际运行证据。本仓未绑定 Workflow 项目或 Room，不进行远端写入。

## 文档核验

使用已安装 Workflow 插件提供的 `spec-lint` 检查结构、frontmatter、导航和相对链接。检查结果只代表文档结构，不能证明插件能力或性能已实现。
