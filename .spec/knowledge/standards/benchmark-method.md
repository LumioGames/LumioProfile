---
name: benchmark-method
description: 性能基准的固定负载、噪声对照、三态判定与复测方法；运行或解释性能预算时查
metadata:
  type: doc
  status: 已交付
---

# 性能基准与判定

本仓使用独立合成宿主验证可选采集器，不接入游戏，不改变 20Hz 权威或 GAS。当前结果见 [验证报告](verification.md)。性能测试串行运行，不与构建、测试或其他基准同时运行；脚本用本仓锁文件阻止第二份基准，无法控制用户其他程序的负载。

## 固定负载与档位

Node 与 Chrome、20Hz 与吞吐共用 `scripts/bench/workload.mjs`：每 tick 12 个系统，每系统执行 32768 次相同 Int32 运算。基线没有观测接缝，Off 保留空槽位判断；Stats 每系统执行 counter、gauge、histogram 各一次；Trace 每系统一对无 context 的 begin/end。每对执行的结果必须相同。无插件模块解析与构建隔离由 `verify:optional` 单独验证，不能以进程中不调用插件代替未安装验证。

六组比较为：基线对基线（A/A 噪声对照）、Off、Stats、Trace 未满、Trace 预填满后丢新、Trace 预填满后循环覆盖。Trace 使用同样的 8MiB 配置，检查是否真的保持指定状态；满后丢新变快不代表正常采集变快。每次采集状态必须持续 active，防止测到已经到期的 Off。

业务运算、埋点密度、配置和随机顺序在优化前后保持一致。不得增加业务工作量来稀释比例，也不得将多字段、长关联键、大量标记等未覆盖场景宣称为已达标。Stats 此基准为每 tick 36 次聚合，旧脚本为一次，旧结果不可作为该负载的优化前基线。

## 计时与噪声

- 先对每种执行路径及基线各预热 2048 tick；每 256 tick 重建采集，避免预热耗尽未满 Trace。模块加载和冷进程启动不在此基准中。
- 20Hz 模式每个 50ms 调度机会依次运行六组配对工作，各档默认 2000 对样本。随机打乱组顺序，AB/BA 交替。记录机会迟到与浏览器 visibility。它是共享进程的合成对照，不是六台隔离的 20Hz 服务器，也不是物理前后台验证。
- 吞吐模式每个计时块运行 256 tick，默认 64 对。CPU 只使用 Node 的进程 CPU 读数，包含运行时和后台线程。Chrome JavaScript 区间仅称墙钟，不用于判断 CPU 百分比。
- `cpu-window` 是补充 CPU 实验：每块 2048 tick，默认 32 对。包含八次短采集的创建、停止、释放以及满缓冲预填和基准记账成本，避免从多个量化的短 CPU 读数相减拼接。它给出该配置总成本的保守证据，不冒充单独热路径 CPU；也不代表真实宿主以这种频率重建采集。
- factory、prepare/start、stop、release 在热区间外单列。关闭之后待导出存储仍可存在，release 才释放。采集重建造成的后续 GC 可能影响热区间，记录这一限制，不删异常点、不强制 GC。
- Node 保存 GC、内存前后值；它们含基准本身与运行时成本，不能归因成纯插件分配量。Chrome 此基准不采 GC/CPU，不能填成零。

## 预算判定

候选预算保持不变：Off CPU ≤0.2%；Stats CPU ≤1%、tick p99 增量 ≤0.1ms、存储 ≤256KiB；Trace CPU ≤5%、tick p99 增量 ≤0.5ms。完全裁剪和 Off 零采集动作另用确定性契约检查。

吞吐对 CPU 和墙钟分别计算配对总量比例。20Hz 计算各档与对应基线的 p99 差，按连续 50 个机会分组进行重采样，保留组内相关性。默认 1500 次确定种子的配对 bootstrap，给出 95% 区间。A/A 对照区间绝对值的最大值作为保守噪声包络；p99 再加两倍实测时钟最小正增量，避免浏览器时钟量化被忽略。

- **通过**：区间上界加噪声包络不超过预算，且达到最低证据量。
- **未通过**：区间下界减噪声包络仍超过预算。
- **证据不足**：其他情况，包括 CPU 未测、零基线、时钟粒度限制、样本不足或区间跨过预算。

最低证据量：p99 每档 2000 对；吞吐至少 32 对，CPU 基线累计至少 1000ms。这只是本基准最低要求，不保证任意硬件的统计精度。区间是合成样本的不确定性估计，噪声包络是保守判定规则，不是普适误差保证。CPU 与墙钟各自判定；墙钟过关不能替代 CPU。负增量不能解释为插件加速。

## 复测与证据

```text
npm run build
npm run benchmark:throughput -- --tag before
npm run benchmark -- --tag before
npm run benchmark:browser -- --tag before
npm run benchmark:cpu -- --tag final
```

优化后使用 `--tag after` 重跑相同命令。`--rounds` 可用于短时检查脚本；不足证据量的结果必须保留“证据不足”。每次输出新目录 `artifacts/benchmark/v2/<时间>-<环境>-<类型>-<标签>`，保存 raw、summary、启动时冻结的 SDK 与基准源码副本及 SHA-256、运行环境、Chrome 实际启动参数。原始记录不会被新运行覆盖。运行中不能修改被测代码；归档源码与摘要不一致的实验不进入验收。

`scripts/benchmark-hotpath.mjs stats|trace` 放大纯采集操作，可配合 Node `--cpu-prof` 找热点。该实验没有业务负载，只用于归因，不能替代预算验收。CPU 采样不代表 GPU 时间。

本机 headless Chrome 的真实 OS 前后台、远程 DS、Unity/PuerTS、Mono/IL2CPP 及跨原生开销没有由这些脚本验证。任何报告均需保留此边界。
