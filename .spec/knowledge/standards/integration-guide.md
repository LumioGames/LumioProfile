---
name: integration-guide
description: 可选插件的宿主接口、无包构建、双层开关和三类环境接入；接入与验证时查
metadata:
  type: doc
  status: 设计中
---

# 可选插件接入与使用指引

**本页保留整体接入契约与验收设计。第一版实际可执行示例、命令及限制请使用 [第一版运行指引](mvp-usage.md)，不得把本页候选示例当作当前 CLI 参数。** 接入原则见 [ADR-002](../../decisions/ADR-002-host-contract-and-optional-injection.md)，已确认包拆分见 [ADR-003](../../decisions/ADR-003-runtime-subpaths-and-independent-tools.md)，声明与职责见 [SDK 接口与包结构](../features/sdk-contract.md)，总体能力与候选预算见 [插件设计](../features/profile-plugin.md)。

本文面向 Engine 或宿主集成者。游戏是否接入、观测哪些系统或行为，由接入方决定；LumioProfile 不要求游戏修改规则或补齐某套预设埋点。

采集数据与分析口径见 [采集协议](../features/capture-protocol.md)。普通 Trace 丢新、循环覆盖显式选择的默认策略已确认，见 [ADR-004](../../decisions/ADR-004-trace-overflow-policy.md)；本页第 10 节给出配置与质量检查用法。

## 1. 先选择构建能力，再选择运行状态

| 接入选择 | 默认状态 | 需要时能否开启 | 必须验证 |
| --- | --- | --- | --- |
| 未安装插件，普通构建 | 无采集能力 | 不能 | 普通类型检查、构建、启动和业务运行独立成立 |
| 已安装但不装配 | 无活动采集 | 需要显式装配 | 包导入没有定时器、连接、采样器等副作用 |
| Debug 保留能力 | Off | 可按构建能力开启 | 关闭路径不执行采集；不因连接 Agent 自动开启 |
| Release 保留能力 | Off | 宿主明确允许的能力可开启 | 发布策略、实际原生支持与 Off 成本 |
| Debug 或 Release 完全裁剪 | 无采集能力 | 不能 | 最终产物及模块图中没有对应诊断路径与依赖 |

「未安装」与「完全裁剪」也要区分：未安装证明包可选，但宿主本地槽位与判断仍可能存在；完全裁剪还要证明这些观测路径从产物消失。构建选择由消费者持有，不强迫服务器改变构建方式。

Stats 也是显式开启的模式，Off 不保留隐式实时统计。已开启 Stats 时可申请短时 Trace，结束恢复此前模式；采样与 GPU 数据源分别选择，不默认跟随 Trace 开启。

## 2. 依赖方向：宿主契约与插件实现分开

```text
普通业务入口 → 宿主持有的无依赖观测声明与空槽位
                               ↑ 注入兼容实现
可选诊断入口 → LumioProfile → 浏览器 / PuerTS / Node 适配器
```

接入方可以复用 Engine 的宿主契约，无需每个游戏重新设计。契约描述所需数据结构与观测语义，不导入或重新导出 LumioProfile 的类型、值或原生适配。插件提供参考声明与兼容性验证方法，不把独立 API 包变成普通构建的必装依赖。

建议的接入次序：

1. 在宿主已有代码中定义轻量契约与空槽位，声明契约版本；没有插件时两类槽位保持为空。
2. 把插件类型、实例化和环境适配依赖放进独立可选集成模块。普通入口、公共导出、启动代码均不引用它。
3. 普通构建的类型检查与打包图排除该集成模块；诊断构建才显式加入。检查宽泛的文件包含规则、公共导出和测试配置，防止它们重新拉入可选模块。
4. 可选入口验证契约版本和实际环境能力。装配只提供控制能力；收到启用请求后才创建所需采集资源并绑定写入槽位。
5. 不兼容时拒绝诊断装配并保留空槽位，宿主继续运行；工具报告原因，不能假装正在采集。

`import type` 只消除运行时导入，类型检查仍可能解析对应包；包不存在时不能依靠它通过构建。把动态导入放在条件或异常捕获里也不是通用保证，编译器与打包器可能提前解析该模块。普通构建必须在整个依赖图上独立成立。

## 3. 热路径：先判断，再做任何采集工作

建议分别保留 Stats 与 Trace 的可选写入槽位。它们是本执行上下文的普通引用，不是会读取时钟、请求远端状态或调用 C# 的属性 getter。

以下是接入约定示意，不是现有 SDK：

```ts
// PROFILE_COMPILED 由宿主构建提供静态值，不能作为未定义变量直接使用。
if (PROFILE_COMPILED) {
  const writer = profileHost.trace;
  if (writer) {
    writer.event(markerId, buildContext());
  }
}
```

Off 时 `trace` 与 `stats` 都为空。只有 Stats 时 `trace` 仍为空，因此不构造逐操作上下文。时钟读取、字符串拼接、对象创建、序列化、复杂筛选与原生调用都放在对应已启用路径内；标记名称与句柄在冷路径注册或绑定，热路径复用。

`buildContext()` 必须是只读、仅用于诊断的工作。不能把玩法计算、输入序号递增、随机数推进或资源结算藏在它里面，否则关闭或裁剪会改变业务。

下面两种写法不能保证关闭路径无采集开销：

```ts
profiler.record(markerId, buildContext()); // 空 record 仍会先构造参数。
profiler.scope(markerId, () => doWork());  // 仍可能创建闭包并经过包装调用。
```

保留能力时仍有分支、引用读取和必要静态元数据成本。应表述为「关闭时不执行采集」，不能称为绝对零开销。默认不以 no-op 方法替代空槽位判断。

## 4. 复用语义接口，不复用环境依赖

| 共用概念 | 接入要求 |
| --- | --- |
| Marker | 稳定标识、名称、类别、单位和源码映射；实体身份作为数据，不拼进名称 |
| 同步 Scope | 同一执行上下文的 begin/end；保持业务返回值和异常语义，不跨 await、yield 或线程 |
| Event | 记录实际观察到的阶段，不替游戏生成事实 |
| Link | 关联消息、异步操作与跨端事件；与同步父子调用分开 |
| Counter / Histogram | 有界计数与分布；不默认保留逐操作历史 |

这些概念与输入设备无关，可以描述按键、移动、拾取、系统更新或表现批次。插件只分析接入方实际提供的标记。原生 CPU 采样是另选的数据源，不能替代队列端点或业务关联。

同步区间若已开始，应保存对应 writer、区间令牌和会话身份，结束时不能重新读取槽位而写入另一场采集。结束逻辑需在正常返回和业务异常时执行，诊断故障不得吞掉或替换业务异常。裁剪时还须检查残留包装、闭包及 try/finally，不能假定一个常量会自动移除所有结构。

通用 TS 层不依赖 `window`、`performance`、`process`、文件系统、网络或 Unity API。每个执行上下文拥有自己的适配器、槽位、时钟标识和有界缓冲；跨 Worker 传递配置与记录协议，不传 writer 对象。

| 环境 | 由适配器提供 | 接入时特别验证 |
| --- | --- | --- |
| 浏览器主线程 / Worker | 已验证的单调时钟、本地缓冲、批量排出、可用浏览器数据源 | 各 Worker 实际覆盖；主线程能力不能默认套给 Worker |
| Unity + PuerTS | 注入的单调时钟、每脚本环境缓冲、批量 TS→原生排出、Unity 数据适配 | JS 侧关闭判断不跨 C#；后端/平台能力；计时跨界成本；环境重建 |
| Node Host / Room Worker | Node 时钟、各实例缓冲、排出、事件循环/GC/采样适配 | Host 与 Room 覆盖分别报告；源 TS 执行和实际发布入口分别检查 |

PuerTS 不假设天然拥有浏览器或 Node API。开启时先在 TS 侧记录，按预算批量排出，避免每个 TS 标记都跨 C#；若读取时钟必须跨界，应实测并报告成本。批量排出时间不能代替事件时间。Unity 原生 Marker、计数器、逐帧捕获按实际支持独立接入，不承诺所有 Release Player 都支持完整原生 Profiler 数据。

同样的语义记录使用相同协议，具体测量来源和限制必须保留。跨端先校准时钟并报告误差，不能直接相减本地时间；WebGL 提交、GPU 执行和屏幕呈现分别表达。

## 5. 启停与 Agent 使用流程

观测写入接口只记录数据；控制入口负责下列流程，接口名称尚未冻结：

```text
capabilities → prepare → start → status → stop → export
```

1. 宿主按需开放诊断控制入口。安装或导入包不自动监听网络，也不自动与 Agent 连接。若保留常驻控制入口，其成本计入 Off 基线。
2. Agent 读取构建、版本、实际来源和能力，区分未接入、已裁剪、保留但 Off、平台不支持与访问受限。无法连接本身不能证明插件未安装。
3. 准备有限时、有限容量的采集，明确 Stats/Trace、过滤条件和另选的原生来源。各端返回实际接受配置，不因一个来源支持便推断全部支持。
4. 开始时为每个来源绑定本次会话的写入槽位。控制消息异步送达，各来源记录实际生效时间，不暂停玩法或等待全端同步屏障。
5. 停止先撤销本次会话的新写入入口，已开始区间使用原令牌在期限内收尾；不等待业务完成。到期后关闭旧 writer，迟到结束安全丢弃并计入质量信息，不写入新会话。
6. 只停止和释放本次启动的资源；恢复先前模式。导出已有记录及未完成信息，交给 Perfetto 和版本化查询分析。原本由其他工具启动的采样器不能被无条件关闭。

Worker 或 PuerTS 环境重建生成新来源实例；热更记录代码代次，重新验证绑定，旧令牌不能迁移成新环境事件。控制重连不得重复开采集，也不得把旧会话事件关联到新操作。完整的环境核验与证据流程见 [Agent 采集分析流程](../features/agent-capture-analysis.md)。

## 6. 完全裁剪必须检查真实产物

编译开关是宿主构建契约，具体机制按运行环境选择。普通构建不能为了去掉可选插件而先强制加载该插件提供的构建工具。

| 构建路径 | 需要证明的内容 |
| --- | --- |
| 浏览器打包 | 静态常量替换后消除观测分支，模块图没有插件及适配器；检查分块与加载请求 |
| PuerTS 加载 JS | 检查实际部署的 JS；原生适配程序集和 Unity 编译开关另行检查，不能只验证 TS 输出 |
| Node 打包或预处理 | 检查实际服务器入口及 Worker 产物，确认裁剪生效 |
| Node 直接运行 TS | 类型剥离不等于消除分支；没有显式裁剪步骤时，只承诺运行时 Off，不声称完全裁剪 |

环境变量名称、`sideEffects: false`、源码中的 false 常量或 JIT 可能优化，都不能单独作为验收证据。除依赖分析外，还要检查热路径残留调用、包装、诊断参数与原生绑定。是否提供构建适配，以及如何命名入口，继续讨论后再定。

## 7. 接入验收与开销测量

以下是完整接入验证要求；第一版已执行的子集见 [验证记录](verification.md)。优先使用独立合成宿主证明插件契约，再由接入方自愿提供场景；不要求修改现有游戏来完成插件基础验收。

| 验证项 | 合格证据 |
| --- | --- |
| 真实无包构建 | 隔离环境中插件物理缺席，不能从父目录或工作区提升依赖找到它；普通类型检查、构建和运行成功 |
| 安装但未装配 | 导入无采集计时器、网络连接、采样器或缓冲初始化副作用 |
| Debug / Release 运行时 Off | 对时钟、上下文构造、记录、采样器启动、PuerTS 采集跨界计数，预期全部为零；统计槽位同样检查 |
| 完全裁剪 | 模块图与部署产物证明无诊断模块、观测调用及包装；不能仅搜索包名或测得耗时接近零 |
| Stats 独立 | 启用统计不构造 Trace 上下文；停止后不遗留统计定时器或累积 |
| 启停、异常和溢出 | 同样的宿主返回值、异常和业务状态；缓冲满不反压；旧区间不写入新会话 |
| 三类环境一致性 | 同一合成事件序列得到一致语义；能力差异、丢弃和时钟误差明确记录 |
| 性能对照 | 分别测无包、完全裁剪、装配 Off、Stats、Trace 和 Deep，报告构建差异、样本、噪声与分布 |

对照测试采用相同业务版本、设备和负载，交错重复测量并区分冷启动与稳态；比较帧/tick 分布、CPU、分配、GC 与内存。微基准单独测判断、时钟、记录、排出和跨界，不能代替实际工作负载。Deep 的采样成本单独报告。具体数值预算仍以 [候选预算](../features/profile-plugin.md#开销与容量候选预算) 为讨论稿，不能写成已达成保证。

## 8. 三端最小接入示例

采集端选择一个包的环境子入口；工具包和 Unity 原生包独立安装与部署。以下包名只是候选名称，当前不能据此安装或运行：

| 接入方 | 可选入口使用 | 工具与原生依赖 |
| --- | --- | --- |
| 浏览器及浏览器 Worker | `@lumio/profile/browser` | 分析工具在开发机或独立服务，不进入页面依赖 |
| Unity + PuerTS | `@lumio/profile/puerts` | 选择接入时另装 `com.lumio.profile` 原生适配 |
| Node Host / Room Worker | `@lumio/profile/node` | 不依赖 Unity；工具包独立运行 |

### 共用宿主声明与观测点

宿主持有 [ProfileHost、TraceWriter 与 StatsWriter 声明](../features/sdk-contract.md#宿主持有的观测契约)。普通业务入口只引用宿主本地契约和标记 ID，不导入插件。

下面是接入方自愿添加的观测点示意，不表示本仓会替游戏埋点。`existingOperationKey` 来自宿主现有身份，不能为诊断改变输入序号或业务消息：

```ts
if (PROFILE_COMPILED) {
  const writer = profileHost.trace;
  if (writer) {
    writer.event(101, {
      operationKey: existingOperationKey,
      tick: currentTick
    });
  }
}

processInput(input); // 原有业务调用。
```

标记 `101` 的含义由宿主清单定义。这个示例只产生一个观察点，不能凭它计算完整输入延迟。需要区间、队列或跨端分析时，由接入方选择提供相应端点和关联。

### 可选入口的共用配置

每个执行上下文在自己的可选诊断入口中准备配置：

```ts
const common = {
  host: profileHost,
  markers: markerCatalog,
  build: buildManifest,
  policy: hostDiagnosticPolicy
};
```

`markerCatalog` 是宿主标记及指标清单；`buildManifest` 是实际构建 ID、Debug/Release 与保留能力；`hostDiagnosticPolicy` 是宿主允许开启的能力和资源上限。这些值由宿主提供，不接受 Agent 请求任意扩权。普通构建不解析包含 SDK 导入的可选入口，也不把该入口纳入普通类型检查。

以下三个例子是互斥的环境装配方式，不能在同一上下文中全部创建。跨 Worker 复用声明和配置协议，不共享 `common.host` 或 writer 对象。

### 浏览器

```ts
import { createBrowserProfiler } from "@lumio/profile/browser";

const profiler = createBrowserProfiler({
  ...common,
  role: "client-main"
});

profiler.attachControl(browserDiagnosticChannel);
```

预测 Worker 或 solo Room Worker 在自己的可选入口中使用相同工厂，分别声明实际角色和实例。诊断控制可经专用 MessagePort 转发；各上下文持有独立槽位、时钟与缓冲，不能阻塞玩法消息等待诊断确认。

`browserDiagnosticChannel` 表示宿主显式提供的诊断通道，例如页面主动连接本地工具端、Worker 经专用通道接入。例子不创建监听、不附加 CPU Profiler，也不模拟焦点或前后台。

### Unity + PuerTS

```ts
import { createPuertsProfiler } from "@lumio/profile/puerts";

const profiler = createPuertsProfiler({
  ...common,
  role: "client-script",
  nativeBridge: unityProfileBridge
});

profiler.attachControl(unityDiagnosticChannel);
```

`unityProfileBridge` 由可选 Unity 原生包提供单调时钟、批量交接、可用原生来源与生命周期通知；具体桥接 ABI 尚未冻结。`unityDiagnosticChannel` 是通过原生侧显式提供的控制通道。

关闭判断留在 JS；开启后 TS 先写本地缓冲，按预算批量排出。时钟若跨 C# 读取，单独测量成本；不为每个 TS scope 默认再跨界写 Unity Marker。脚本环境重建时重新登记实例，旧 writer 不能用于新环境。

### 服务器

```ts
import { createNodeProfiler } from "@lumio/profile/node";

const profiler = createNodeProfiler({
  ...common,
  role: "ds-room"
});

profiler.attachControl(serverDiagnosticChannel);
```

DS Host 使用独立实例和 `ds-host` 角色，各 Room Worker 分别装配。`serverDiagnosticChannel` 来自宿主明确开放的诊断入口；不要求普通服务启动时开启 Inspector 监听。CPU 采样单独协商，Host 采样不能代替 Room 采样。

三个例子的工厂只装配且默认 Off，`attachControl` 只挂接通道。直到明确 start，才创建所需采集资源并绑定相应写入槽位。通道连接和控制响应有固定成本，计入 Off 基线。实际通道的创建、认证和关闭 API 仍待细化，不能把这些示例当成可运行的完整程序。

## 9. Agent 最小使用流程

工具包 `@lumio/profile-tools` 部署在开发机或独立服务。它协调显式开放的诊断通道、收取有界记录、转换与分析；游戏产物不携带该工具包。CLI 与后续 MCP 复用同一服务语义。

以下是候选命令，不是当前可执行程序。目标 ID 来自发现结果；`cap-001` 代表 start 返回的 captureId，不能作为固定会话 ID 重用：

```text
lumio-profile targets --json
lumio-profile prepare --targets browser-a,ds-room-1 --mode trace --duration 15s --out capture-plan.json
lumio-profile start --plan capture-plan.json --json
lumio-profile status --capture cap-001 --json
lumio-profile stop --capture cap-001
lumio-profile export --capture cap-001 --out ./capture-001
lumio-profile analyze ./capture-001 --query overview --json
lumio-profile analyze ./capture-001 --query operation --key session-a/player-a/42 --json
```

`prepare` 解析目标、宿主限制及实际来源支持，返回每来源配置和有期限的准备凭据；不开始采集。示例仅选择两个来源，不代表覆盖完整主线程、预测、Host 和 Room 链路；完整性必须按实际来源报告。15s 是示例窗口，最终值由协商结果决定。

`start` 使用准备凭据并保持可重试的请求身份，重试不能重复启动。到期自动停止；`stop` 用于提前结束。CLI 参数如何携带请求身份还未冻结。Stats 选择 `--mode stats`，不隐式开启 Trace；原生 CPU/GPU 来源在准备配置中另选，不默认启动。

普通 Trace 在未另选策略时保留已有记录、满时丢新详细事件。循环覆盖必须显式请求；prepare 返回实际接受的策略，status 与导出包保留同一口径。校准在明确 start 后有预算地进行，不能把一次成功握手当作整场采集永远可对齐。

导出目录建议为以下逻辑内容，具体文件布局尚未冻结：

```text
capture-001/
  manifest.json      来源、构建、配置、协议与工具版本
  raw/               原始记录与时钟校准样本
  traces/            转换后的 Perfetto 文件
  native/            可选 CPU profile、Unity 原生附件
  quality.json       丢弃、缺失、时钟误差与覆盖
```

工具仅合并有可靠时钟映射的来源，其他来源保留独立时间域。导出包作为不可变输入，分析结果另存。Agent 先检查环境与质量，再执行版本化查询，最后回到证据、源码与 Perfetto 区间；缺少端点不能套用历史归因。

控制方法的输入输出、部分失败和恢复约定见 [Agent 控制接口](../features/agent-capture-analysis.md#控制接口输入输出)。这些示例不改变 20Hz 权威、GAS 预测边界、输入顺序或资源结算，采集与导出不得让业务等待。

## 10. 缓冲选择、身份和时钟的使用约定

本节的字段和值是配置草案，不能当作可执行 API 或已冻结线格式。普通 Trace 的最小选择可以表示为：

```text
mode: trace
durationMs: 15000
overflowPolicy: drop-new-detail
```

希望循环保留最近窗口时，显式选择候选值 `overwrite-oldest-chunk`。具体命令参数、窗口与容量仍由宿主策略和 prepare 协商，不能绕过上限。

| 选择 | 使用者应预期什么 |
| --- | --- |
| 默认丢新详细记录 | 已保存记录不会因新记录而被覆盖；满缓冲可能形成中间缺口，释放后可继续 |
| 显式循环覆盖 | 最旧完整批次可能被覆盖；跨批次区间起点可能消失，实际保留窗口以导出证据为准 |
| 只开 Stats | 没有逐操作历史，不能在故障后补出未采集的 Trace |

所有模式都不反压玩法，详细记录满时不会自动开启 Stats。预留空间用于质量和已有区间收尾，仍可能丢失；质量无法可靠保存时来源终止详细采集，Agent 应报告部分数据而不是继续声称完整。

### 各端提供与核对的信息

| 来源 | 接入与使用时核对 |
| --- | --- |
| 浏览器及 Worker | 实际来源实例、performance 时钟与 timeOrigin、分辨率、握手依据、真实前后台和暂停变化 |
| PuerTS / Unity | 脚本环境实例、原生时钟与频率、TS 是否实际共用该时钟、原生 Profiler 附件自身的时间域、环境重建 |
| Node Host / Room | 各执行上下文实例、实际单调时钟、同域证明或校准样本；不能用 Host 覆盖代替 Room 覆盖 |

宿主只提供已有业务会话、操作、消息或状态修订身份。采集器管理 captureId、来源、写入流与记录序号，不要求业务生成这些字段或依据采集成功与否重试。

业务重连、诊断通道重连、热更和时钟重置是不同事件。补传原批次保留身份；旧输入不能改成新会话；重建环境使用新实例；热更不自动证明时钟重置。跨端 key 匹配只能证明关联依据，不能替代时钟校准。

不要用 targetTick 作为唯一操作身份，不要仅凭同一实体和时间接近关联另一玩家观察。缺少标记或身份时，工具显示覆盖不足，不能要求插件自动修改玩法消息来补齐。

### Agent 的采集与分析检查顺序

1. prepare 核对实际来源、构建、模式、容量与丢弃策略；确认本次要求的阶段确实有观测点。
2. start 后核对各来源实际生效状态、校准覆盖及真实环境；后台冻结或时钟异常后重新验证，不改变前后台来追求精度。
3. status 查看分原因的丢弃、保留窗口和最后已知进度；过滤未覆盖不算丢包，未知尾部也不算零丢失。
4. stop/export 使用有界收尾，诊断重传去重，业务重试保留；损坏批次、缺失清单和导出截断均写入质量报告。
5. 转换前检查时钟映射、区间配对和因果依据；无法对齐的来源单独输出，不补造 begin/end 或移动时间戳来美化 Flow。
6. analyze 先读质量，再给数值或范围、测量类型、关联依据、完整性、原始引用与版本。只对证据支持的范围计算指标。

常见质量结果的用法如下：

| 结果 | 正确处理 |
| --- | --- |
| 关联明确，但跨域时钟不可用 | 继续看因果链和本地耗时，跨域延迟返回不可计算 |
| 跨域估计为 5ms ± 8ms | 保留范围和模型限制，不称为确定 5ms，不偷偷归零 |
| 同域队列端点完整 | 可以计算这一条等待样本，仍检查其他样本是否丢失 |
| 父区间完整但子区间缺失 | 父区间墙钟可用，完整自身耗时未知 |
| 部分操作缺失 | 统计只描述保留样本，不冒充总体 p99 |
| 来源退出且无最终进度 | 尾部未知，不补造成功、取消或零丢失 |

历史的 1043ms 等待与约 9ms 规则区间只作为验收背景；没有当次端点不能套用这些数值。32 tick 提前量、实际等待、RAF 机会、draw、CPU 与 GPU 时间分别依赖对应证据。

具体字段、校准公式和转换映射见 [采集协议](../features/capture-protocol.md)，工具侧流水线见 [Agent 流程](../features/agent-capture-analysis.md#从原始批次到分析包)。第一版的校准、缺失与性能实验见 [验证记录](verification.md)，不代表所有目标环境都已经验证。

## 常见接入问题

| 现象 | 优先检查 |
| --- | --- |
| 无插件时报找不到模块 | 类型导入、公共导出、宽泛编译文件范围、可选模块被普通入口拉入 |
| Off 仍在分配或跨 C# | 参数是否在判断前构造、回调是否提前创建、槽位 getter 是否调用原生、是否保留控制连接 |
| Agent 无法开始 | 先核实入口可达性与实际能力；不能把缺席或裁剪当成可通过开关恢复 |
| 有 trace 但无法解释某行为 | 检查是否提供相关标记、关联与端点，报告覆盖不足，不自动替游戏埋点 |
| 停止后仍见旧事件 | 核对原会话身份、有界收尾与丢弃信息，不能混入新会话或无限延长采集 |
| 有关联链但没有跨端耗时 | 核对时钟映射有效范围、精度和误差，不用时间邻近代替校准 |
| Perfetto 有区间但标准查询不给 self 或总体 p99 | 检查子区间与样本完整性；通用 UI 数值不证明语义覆盖 |
