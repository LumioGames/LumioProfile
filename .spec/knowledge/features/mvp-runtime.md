---
name: mvp-runtime
description: 第一版实际交付范围、协议限制和验证证据；判断当前能力与未验证边界时查
metadata:
  type: doc
  status: 已交付
---

# 第一版运行能力与边界

仓库提供本地 0.1.0 实现，尚未发布 npm 或 Unity 包。范围为可选采集、有限会话、原生 Perfetto 转换及 Agent CLI 查询。完整产品方向仍见其他设计文档；本页与 [运行指引](../standards/mvp-usage.md) 是当前实现范围的入口。

## 交付能力

| 内容 | 实际行为 |
| --- | --- |
| 采集包 | `@lumio/profile`，独立 `/browser`、`/node`、`/puerts` 子入口；PuerTS 另有 CJS 产物 |
| 宿主契约 | `contracts/observation-v1.d.ts` 可复制到宿主，零外部依赖；普通入口排除可选诊断文件 |
| 运行模式 | 默认 Off；Trace 与 Stats 二选一；Release 还要求宿主 `policy.allowRelease` |
| 写入 | 同步 span/event/link，计数/gauge/有界直方图；显式清单和字段白名单；Stats 可通过 status 实时读取 |
| 控制 | 显式提供的 WebSocket 连接；工具服务仅监听回环地址，校验令牌与浏览器 Origin |
| 导出 | stop 后按 64 条记录分批请求，工具组装不可覆盖的采集包；收到完整来源后释放采集端存储 |
| 分析 | 原生 `.pftrace`；固定 Perfetto v58.2；overview、hotspots、queues、operation 四个共享 SQL 查询 |
| Unity 原生包 | 独立 `com.lumio.profile`；`LUMIO_PROFILE` 控制程序集，提供时钟和 16 槽主线程调度桥接 |

不自动埋点、不调整 20Hz 权威/GAS 边界，不改变游戏消息或资源结算。记录失败、满缓冲、旧 writer、旧控制请求不进入业务决策。源码定位仅使用接入方提供的 marker.source 和对应 buildId，不推断当前工作区行号。

## 协议与容量

协议为 `lumio.capture/1`，采集包为 `lumio.bundle/1`，查询为 `lumio.sql/1`。类型真值在 `packages/profile/src/types.ts`。事件时间字段实际名为 `time`，单位毫秒；原始计时依据保存在来源 clock 描述中。Node 直接读取 `node:perf_hooks` 的 performance.now，保留毫秒 timeOrigin、`node.performance.now` 依据及独立 clockId；浏览器保留自己的 performance 原点；PuerTS 注入单调毫秒值。原点只是描述信息，不据此绕过跨来源校准。工具继续支持带旧 hrtime 描述的历史采集。

采集热路径使用预分配数值列和 UTF-16 槽，不逐记录 JSON 编码。槽预算为 1024 bytes，其中实际数值列 64 bytes、字符区 768 bytes；其余作为预留。另计基础元数据、开放 span 和统计预留。`allocatedBytes` 是配置存储预留，不代表整个 JS VM 的精确堆占用，额外堆/GC 由基准报告。

- 默认每来源 8MiB，最大时长 60s；宿主可设更小上限。首期未内置跨来源共享内存仲裁，宿主与工具需限制来源数和各自预算。
- key 最多 95 个 UTF-16 code units，不允许 NUL。每 marker 最多 4 个附加字段，每值序列化文本最多 22 字符；过长或非法值拒收并记缺失，不截断身份。
- 清单最多 256 个 marker；默认开放同步 span 最多 128。只允许同上下文同步嵌套，不跨 await。
- 普通模式保留已有记录、满时丢新；有限槽位给已有 span 结束使用。显式循环模式按最多 16 条的旧记录块覆盖；不保证区间起点保留。
- 第一版在停止后排出，采集中不做持续排出。因此普通模式满后不会恢复记录；持续排出/恢复属于后续协议扩展。
- 质量用固定计数和首尾序号界定，不为每个丢弃分配对象。完整性不足时禁止完整 self 和总体分位数推断。
- 一次工具服务最多 32 个连接、16 个准备计划、4 个采集会话；单次收到的来源总数据限 32MiB；导出包总预算 128MiB。达到限制明确报错或标记缺来源。

原始 JSON 只在冷路径传输/保存；Perfetto 使用 protobufjs 编码。没有实现原始批次 Protobuf、压缩、自适应采样和网络断连续传。停止后的分页可重试，身份保持不变；来源断开则保留部分结果，不补造尾部。

## 时钟与关联

工具在明确 start 后及约每秒采样，单采集最多 512 个样本。一次源端时钟读取是四时间点方法中 b2=b3 的特例；往返残差包含源端调度与响应开销，不当成纯网络时间。

当前采用常量偏移的有界区间模型，参数为时间戳误差假设 1ms、漂移假设 1000ppm、样本有效半窗 1500ms。这些是**待目标环境验证的模型假设**，不是已证明的最大误差。结果是条件估计；间隔过长、来源代次不匹配、样本矛盾时不对齐。尚未实现分段线性漂移拟合与多跳校准。

只有整个来源的保留事件都有共同参考时间覆盖时才归到同一个 Perfetto 文件。否则输出独立时间域文件。原始本地时钟、样本、误差和文件所属 domain 均保留；各文件的合成时间轴不代表 OS 物理时钟。

operationKey 只归组。link 的 out/in 必须唯一且匹配才建立因果；重复端点标歧义，缺端点保留缺项。跨域没有映射时仍能查关联，但耗时为 null。一个 span 的自身区间仅相对于已观察的同步子区间，不能称为精确 CPU 时间。队列等待使用显式 `relation: 'queue'` 两端；不同来源、构建与 marker 的热点分组分开。

## 验证口径

| 场景 | 当前证据 |
| --- | --- |
| 无插件构建 | 暂时移走两个 workspace 安装链接；确认消费者解析不到采集包，再完成普通 TS 检查、打包与运行，最后恢复链接 |
| 完全裁剪 | 发布产物无 trace/event/观测包装，独立模块图不包含诊断入口；示例裁剪产物 76 bytes，Off 产物 155 bytes |
| Off | Debug/Release 测试时钟、参数构造、定时器、写入槽和采集存储；均为零采集动作。控制连接如保留，仍有固定成本 |
| Node 主线程与 Worker | 实际独立执行上下文，经 CLI 发现、准备、开始、停止、导出和官方 Trace Processor 查询 |
| Chrome 与 Worker | 本机 Chrome，两个页面与两个 Worker；真实 JavaScript 执行，但 headless。保留实际启动参数，移除禁用后台节流的自动化默认参数 |
| Unity/PuerTS | TS 注入桥接契约测试、纯 .NET 10 时钟/调度测试；**没有 Unity/PuerTS/Mono/IL2CPP 运行验证** |
| 归因样例 | 人工时钟生成 1043ms 队列等待与 9ms 执行；官方 Trace Processor 返回两种独立区间和 Flow，零导入错误；不是重新复现 101-bomber |
| 时钟与缺失 | 非对称往返、未校准、缺子区间、丢端点、序号缺口、重复诊断数据、歧义关联均有自动化测试 |

详细命令与开销结果见 [验证记录](../standards/verification.md)。不能将 headless 的 visible 状态当真实窗口前后台验证。GPU、CPU 原生采样、GC 数据接入、Unity Profiler 导出、物理呈现、双浏览器独立进程及真实 DS 远程网络尚不属于已验证能力。

## 当前限制

停止采用立即截止，收尾宽限为 0；已开放但无终点的区间记不完整。hot reload 应停止/导出、解除控制绑定并以新实例和 codeEpoch 重建，尚无原地热更生命周期 API。Stats 没有实体级常驻标签，也没有合并分位数功能。

控制计划固定 prepare 时选择的来源和控制连接代数；同 sourceId 的新连接不接收旧计划的 start、时钟采样或导出请求。晚注册/重建 Worker 不自动加入，仍为 Off，需下一段显式 prepare/start。targets 提供 controlConnection；status、raw.json 和 quality.json 提供可选 sourceLifecycle，记录选中代数及最多 128 条注册/断开事件，满后保留已有生命周期事件并增加 droppedEvents。它仅描述工具协调器单调时间轴，不是源时钟校准、业务事件或缺失记录的补偿；selected 只表示属于计划，不承诺实际开始成功。旧包没有此可选字段仍可读取。

控制只支持显式回环服务。远程 DS 需接入方提供既有安全通道或端口转发，不能把本地 demo 当生产远程部署验证。CLI 已可使用，MCP 包装与自研分析 UI 暂缓。
