---
name: sdk-contract
description: 采集包与环境子入口、观测和装配接口及版本边界；讨论 SDK 契约和发布结构时查
metadata:
  type: doc
  status: 设计中
---

# SDK 接口与包结构

一个采集包带三个环境子入口，工具包与 Unity 原生包独立，已由 [ADR-003](../../decisions/ADR-003-runtime-subpaths-and-independent-tools.md) 确认。宿主无依赖契约与双层开关遵循 [ADR-002](../../decisions/ADR-002-host-contract-and-optional-injection.md)。

**当前仓库已实现 0.2.0（`npm ci` 自动构建 `dist/`）。实际类型真值为 `packages/profile/src/types.ts`，逐项「已实现 / 未实现」矩阵见 [当前运行能力](mvp-runtime.md)。本页保留完整契约方向，超出已实现矩阵的部分（如 MCP 目录、Unity 原生 Profiler 采样与 GPU 计时）仍为未实现设计。** 三端示例见 [当前运行指引](../standards/mvp-usage.md) 与 [接入使用指引](../standards/integration-guide.md)，控制与分析见 [Agent 流程](agent-capture-analysis.md)。

记录编码、原始时钟、实例与事件身份、缓冲和 Perfetto 映射见 [采集协议](capture-protocol.md)。本页的观测方法不要求调用方自行生成采集身份、进行时钟校准或处理批次重传。

## 交付物与依赖

| 候选交付物 | 内容 | 部署位置 |
| --- | --- | --- |
| `@lumio/profile` | 通用采集核心；`/browser`、`/puerts`、`/node` 三个子入口 | 选择接入的宿主 |
| `@lumio/profile-tools` | 采集协调、原始记录收取、导出转换、Perfetto 查询、CLI 及后续 MCP 包装 | 开发机或独立分析服务 |
| `com.lumio.profile` | Unity 原生时钟、批量桥接、实际可用的原生 Profiler 来源 | 选择接入的 Unity 工程 |

下列为职责布局；第一版源码位于各包 src，MCP 目录和原生 Profiler 采样尚未实现：

```text
contracts/observation-v1.d.ts       宿主契约参考，不是必装 API 包
packages/profile/
  core/                           有界记录、统计、会话与协议
  browser/                        浏览器及 Worker 适配
  puerts/                         注入原生桥接的 TS 适配
  node/                           Node Host 与 Worker 适配
packages/profile-tools/
  capture/                        目标协调、控制与原始数据收取
  conversion/                     Perfetto 转换与质量校验
  analysis/                       版本化查询与结构化结果
  cli/                            程序化命令入口
  mcp/                            同一工具服务的可选包装
unity/com.lumio.profile/           独立 Unity 原生包
```

采集包各子入口只引用通用核心及本环境依赖。根入口不得重新导出会拉入全部平台的模块。分析侧可以读取采集协议，采集侧不得反向引用分析工具或 Perfetto UI。同一个采集包不意味着同一个混合运行时产物。

接入方将零外部依赖的参考声明纳入宿主或由 Engine 统一提供；普通业务代码不从插件导入类型。只有独立可选诊断入口解析 SDK。参考契约的分发校验方式尚未冻结，但不要求无插件消费者运行依赖插件的生成器。

## 三层接口

| 层 | 使用者 | 职责 |
| --- | --- | --- |
| 观测写入 | 接入方自选观测点 | 同步、有界地记录区间、事件、关联与统计 |
| 宿主装配 | 可选诊断入口 | 注入环境、声明能力与策略、挂接控制通道 |
| 控制与分析 | Agent 或开发工具 | 发现、协商、启停、导出、校验和查询 |

业务观测接口没有网络、文件、查询、异步等待或业务调度能力。控制操作不要求玩法等待完成。

## 宿主持有的观测契约

以下声明用于说明候选签名。宿主本地声明不导入 LumioProfile；示例中的版本号只表示当前讨论的第一版契约。

```ts
type Fields = Readonly<Record<string, string | number | boolean>>;

interface Context {
  operationKey?: string;
  entityKey?: string;
  tick?: number;
  fields?: Fields;
}

interface TraceWriter {
  begin(markerId: number, context?: Context): number;
  end(scopeToken: number): void;
  event(markerId: number, context?: Context): void;
  link(
    markerId: number,
    correlationKey: string,
    side: "out" | "in",
    context?: Context
  ): void;
}

interface StatsWriter {
  add(metricId: number, delta: number): void;
  gauge(metricId: number, value: number): void;
  observe(metricId: number, value: number): void;
}

interface ProfileHost {
  readonly contract: "lumio.observation/1";
  trace?: TraceWriter;
  stats?: StatsWriter;
}

export const profileHost: ProfileHost = {
  contract: "lumio.observation/1"
};
```

业务侧只读槽位并记录。可选适配器在本执行上下文内管理槽位绑定；未装配及稳定 Off 状态下两个槽位均为空。Stats 独立启用时不提供 Trace writer。

普通 Trace 满时拒绝新详细记录并保留缺口，显式循环模式才覆盖最旧批次。begin 未保存返回 0，不要求业务重试。已开始区间通过有限预留尽量收尾，不能因此保证完整；缓冲策略不能改变方法的同步、有界和不反压语义。

### 写入与区间语义

- 所有写入方法同步、有界，不等待上传；非法记录、容量不足或关闭后写入在诊断侧处理，不能向玩法抛出诊断异常。
- `begin/end` 表示同执行上下文的同步区间（已实现，且内层漏 `end` 时自动弹出未闭合内层并标 `partial`）；可选 `beginAsync/endAsync` 表示允许重叠或跨 `await` 的异步墙钟区间（已实现，独立泳道展示，不扣减同步 `observedSelfMs`）。未开始记录时均返回保留值 `0`，`end(0)` / `endAsync(0)` 安全忽略。
- 令牌高位编码会话代次（已实现）；无论调用方保存原 writer 还是结束时重读 `profileHost.trace`，上一场迟到结束均被安全忽略且不会误关新会话区间或污染新会话质量。结束区间不等于业务成功，业务结果需要实际事件证据。
- `event` 记录一个实际观察点；`link` 同时记录一个带标记和时间的因果端点，`out/in` 不能被解释为同步父子调用，也不能自动解释成网络单程延迟。
- 停止立即撤销写入槽位（当前已实现：收尾宽限固定为 `0ms`，未闭合区间如实记入 `openSpans`；大于 0 的延长收尾宽限未实现）。关闭后的旧 writer 或旧代次令牌安全忽略迟到结束，绝不写入新会话。

### 关联身份与字段

`operationKey` 用于操作、自动行为或权威事件的关联，`entityKey` 用于短时筛选。key 必须带足够的业务会话与来源命名空间；不能只用会重复的输入序号或实体编号。插件另行保存来源实例、代码代次和采集身份。

相同 operationKey 先表示归组，不能直接产生因果箭头。显式 link 端点与标记语义才提供因果依据；预测重放、权威提交和另一玩家观察的执行身份分开，详见 [跨端关联](capture-protocol.md#跨端关联与业务结果)。

`correlationKey` 标识一次明确传递或异步因果关系，包含必要的方向、连接代次或重试身份。匹配时保留重复和歧义；一对多关系要有明确声明，不能自动把任意同名端点全部相连。

关联优先使用宿主已有身份。没有跨端身份时显示无法精确关联；插件不擅自修改业务消息或要求额外身份参与业务处理。校准不足时，即使身份能匹配，也不得计算跨域差值。

`fields` 仅接收标记清单允许的有限原始值，不接收任意业务对象、访问器或会改变业务的求值。字段数、字符串长度与数值范围由协商预算限制；稳定元数据放清单中，避免逐事件复制。

### 统计语义

`add` 表示计数增量，`gauge` 表示当前值，`observe` 把一次观测加入有界分布。单位和聚合口径由指标清单声明，不能混合不同单位。Stats 不保留逐操作历史，不要求以实体身份建立常驻高基数标签。

## 标记清单

清单在冷路径装配或启用时绑定，热路径复用稳定数字 ID。候选字段包括清单命名空间及版本、标记 ID、名称、类别、记录种类、单位、允许字段、源码映射和可选语义角色。

ID 在一个清单内唯一；导出保留来源与清单身份，不能把不同清单的同一数字当成同一标记。名称不拼接实体 ID 或操作序号。

接入方可以把观测声明为队列进入/离开、帧机会、tick 执行等通用语义。分析规则据此计算已有端点支持的指标；只有自由命名事件时，工具只展示事件，不能猜测其业务含义。具体语义角色枚举与查询映射继续讨论。

## 装配接口与环境边界

候选工厂为 `createBrowserProfiler`、`createPuertsProfiler`、`createNodeProfiler`，分别来自三个环境子入口。共用配置如下：

| 配置 | 来源与用途 |
| --- | --- |
| `host` | 宿主本地 ProfileHost，包含契约版本与空槽位 |
| `markers` | 宿主提供的标记和统计清单 |
| `build` | 实际构建 ID、Debug/Release、代码代次及保留能力 |
| `policy` | 宿主允许的模式、数据源、字段、时限与容量上限 |
| `role` | 来源逻辑角色；不能替代运行实例和时钟身份 |
| `nativeBridge` | 仅 PuerTS 需要的注入桥接能力 |

工厂只完成装配，不开启采集或隐式监听网络。返回实例通过 `attachControl(channel)` 挂接明确提供的诊断通道；挂接通道不等于 start。版本不兼容应返回可诊断结果并保留空槽位，装配失败不阻断宿主启动。

通道实现和具体错误返回类型尚未冻结。通道承载诊断控制及有界批量数据交接，不承担逐事件同步传输；连接、订阅、排出队列及控制响应的成本均计入对应模式。工具离线或通道拥塞时执行诊断丢弃策略，不反压玩法。

| 子入口 | 环境职责 | 不可假定 |
| --- | --- | --- |
| `/browser` | 主线程或各 Worker 的时钟、缓冲和浏览器数据源；可选工具端连接 | 主线程采样等于全部 Worker 采样；附加工具可模拟真实焦点 |
| `/puerts` | TS 本地缓冲，注入单调时钟和批量原生桥接，按实际能力接入 Unity 数据 | V8 后端拥有浏览器/Node 全局；所有 Release 都能导出完整原生调用树 |
| `/node` | Host 或 Room Worker 的时钟、缓冲、事件循环/GC 与按需采样 | Host 采样代表全部 Worker；源 TS 执行等于已裁剪 |

Unity 原生桥接的具体 ABI 仍待目标后端验证。关闭判断在 JS 侧；启用后若计时需要跨 C#，必须实测并报告成本。批量排出不能把批次时间冒充原始事件时间。原生记录与 TS 记录的同一次工作关联后不能重复累加。

## 控制与版本边界

工具包对 Agent 提供 `inspect → prepare → start → status → stop → export → analyze`，统一方法语义见 [Agent 流程](agent-capture-analysis.md#控制接口输入输出)。各运行时只承担本地会话与数据排出；跨来源协调、完整采集包生成和 Perfetto 查询放在工具侧。

宿主契约、采集传输协议、采集包格式与分析查询版本分别记录。SDK 版本一致不替代能力协商；工具包与 Unity 包独立发布时声明兼容范围。不兼容不能静默解码或改写数据。

接口签名、构建导出映射、桥接 ABI、版本范围及编码预算还需要细化；本页不把它们标记为已发布协议。实现验收需证明三子入口隔离、无包构建、Off 零采集动作、启停语义及工具侧离线复算，方法见 [接入使用指引](../standards/integration-guide.md)。
