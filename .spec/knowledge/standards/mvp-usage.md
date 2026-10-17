---
name: mvp-usage
description: 第一版构建、三端接入和 Agent 命令的可执行指引；安装本地包或跑通采集分析时查
metadata:
  type: doc
  status: 已交付
---

# 第一版使用指引

当前只发布在本地仓库，包版本 0.1.0。使用 Node >=22.18；本次验证为 Node 24.18.0。先在本仓执行：

```text
npm ci
npm run build
node scripts/setup-perfetto.mjs
npm run demo
```

下载器固定 Perfetto v58.2 并校验 SHA-256；仅下载到本仓 `.cache/perfetto`。如果网络不能访问 Google 存储，可从官方 v58.2 发布页取得平台二进制，核对脚本中摘要后传入 `--processor`。无需安装 Python。

`npm run demo` 使用独立 Node 主线程与 Room Worker，经真实 CLI 采集并查询，输出采集包位置。`npm run verify:browser` 使用已安装 Chrome 跑两个页面及各自 Worker；这是 headless 验证，不是物理窗口前后台验收。更多限制见 [第一版范围](../features/mvp-runtime.md)。

## 可选接入

宿主复制 `contracts/observation-v1.d.ts` 到自己的代码中；普通业务入口不得从插件导入类型。将诊断入口排除在普通构建的 TS files/include 和打包图之外。`examples/host` 同时展示普通入口和可选诊断入口，`scripts/verify-optional.mjs` 验证实际裁剪。

```ts
// 宿主文件：只有本地契约依赖。
const profileHost: ProfileHost = { contract: 'lumio.observation/1' };

if (PROFILE_COMPILED) {
  const writer = profileHost.trace;
  if (writer) writer.event(101, { tick: currentTick });
}
```

PROFILE_COMPILED 由宿主构建替换。设为 false 并验证产物才能称为完全裁剪；运行时空槽位仍保留一次判断。关闭判断必须在对象构造、读取计时和跨原生调用之前。

Debug 和 Release 装配后均为 Off。Release 默认拒绝启用，确需保留诊断时由宿主固定 `policy.allowRelease: true`，不能取自普通客户端 URL 参数。

## 三端装配

下列 common 中的 host、清单、构建和策略都由接入方提供。采集包只提供能力，不替游戏埋点。

```ts
const common = {
  host: profileHost,
  markers: [{ id: 101, name: 'step', kind: 'event' as const }],
  build: { id: 'actual-build-id', mode: 'debug' as const, codeEpoch: '1' },
  policy: { maxBytes: 8 * 1024 * 1024, maxDurationMs: 60000 }
};
```

浏览器主线程与各 Worker 分别装配，不共享 writer：

```ts
import { createBrowserProfiler, websocketChannel } from '@lumio/profile/browser';
const profiler = createBrowserProfiler({ ...common, role: 'client-main' });
// socket 已由可选宿主入口明确建立并完成 open。
const detach = profiler.attachControl(websocketChannel(socket));
socket.send(JSON.stringify({ hello: profiler.inspect() }));
```

Node 主线程与各 Room Worker 分别装配：

```ts
import { createNodeProfiler, websocketChannel } from '@lumio/profile/node';
const profiler = createNodeProfiler({ ...common, role: 'ds-room' });
profiler.attachControl(websocketChannel(socket));
socket.send(JSON.stringify({ hello: profiler.inspect() }));
```

PuerTS 入口不依赖浏览器/Node 全局；提供原生时钟、调度器和控制通道：

```ts
import { createPuertsProfiler } from '@lumio/profile/puerts';
const profiler = createPuertsProfiler({
  ...common, role: 'client-script',
  nativeBridge: {
    sourceId: native.SourceId, clockId: native.ClockId, clockEpoch: native.ClockEpoch,
    nowMs: () => native.NowMilliseconds(),
    setTimeout: (fn, ms) => {
      const token = native.Schedule(fn, ms);
      if (!token) throw new Error('native-timer-budget');
      return token;
    },
    clearTimeout: token => native.Cancel(token as number)
  }
});
profiler.attachControl(hostOwnedChannel);
```

可选 Unity 包位于 `unity/com.lumio.profile`，需要 `LUMIO_PROFILE` 编译符号。宿主在自己的主线程 Update 中调用 native.Pump；关闭且无待处理回调时不读时钟。该代码只验证了 TS 与纯 .NET 契约，Unity/PuerTS 委托绑定和真实构建未验证，不能直接承诺兼容。

## Agent 控制与分析

工具与游戏独立部署。显式创建仅本机可读的令牌文件，内容至少 16 字符；令牌不要写进游戏消息或采集 metadata。下面命令均已实现，`SOURCE_A` 等值替换为 targets 返回值。

```text
node packages/profile-tools/dist/cli.js serve --token-file .cache/profile-token --port 9466 --out artifacts/captures
node packages/profile-tools/dist/cli.js targets --token-file .cache/profile-token
node packages/profile-tools/dist/cli.js prepare --token-file .cache/profile-token --targets SOURCE_A,SOURCE_B --mode trace --duration 15000 --bytes 8388608 --plan .cache/plan.json
node packages/profile-tools/dist/cli.js start --token-file .cache/profile-token --plan .cache/plan.json --request-id UNIQUE_REQUEST_ID
node packages/profile-tools/dist/cli.js status --token-file .cache/profile-token --capture CAPTURE_ID
node packages/profile-tools/dist/cli.js stop --token-file .cache/profile-token --capture CAPTURE_ID
node packages/profile-tools/dist/cli.js export --token-file .cache/profile-token --capture CAPTURE_ID
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIRECTORY --query overview
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIRECTORY --query hotspots
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIRECTORY --query queues
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIRECTORY --query operation --key SESSION/PLAYER/OPERATION
```

浏览器连接时在 serve 命令增加 `--origin http://127.0.0.1:页面端口`；页面显式连接 `ws://127.0.0.1:9466/target?token=...`。工具不发现或注入未接入的页面，不开启 Node Inspector，不上传第三方。

prepare 不启用采集。start 的 request-id 必须在重试时保持一致；准备凭据 30s 有效。到期停止，断连不无限延长。每来源同时只允许一场会话。普通 Trace 默认 `--overflow drop-new-detail`；希望最近窗口时明确选择 `--overflow overwrite-oldest-chunk`。Stats 用 `--mode stats`，不隐式开启 Trace。

计划固定来源及其控制连接代数。targets 的 controlConnection 包含 id、registeredAt、referenceId；相同 sourceId 重新连接后会得到新的连接 id，旧计划会报告 source-generation-mismatch，不能把新实例当成旧实例继续采集。新 sourceId 或晚注册 Worker 不会自动加入计划，也不会隐式启用。

断网/重建 Worker 使用明确分段：先 stop/export 第一段，保留其中 missingSources 与生命周期；再 targets/inspect，选择当前主线程、预测及权威 Worker，重新 prepare/start 第二段，用新的 request-id 和采集目录。每实例最多四场会话的限制不变；若需重启服务，宿主必须显式重建控制连接，不能假定 socket 会自动重连。

status、raw.json 和 quality.json 的可选 sourceLifecycle 保存 selectedSources（sourceId、connectionId、registeredAt）与 events（kind、sourceId、connectionId、atMs、selected），并给出 referenceId、captureStartedAt、observationStoppedAt 和 droppedEvents。最多保留 128 条事件，超出计数；selected=false 表示此连接未在当前计划，注册前的 Worker 时段没有观测，不能补造端点。selected=true 只说明计划选择，不保证 start 已成功。captureStartedAt 是协调器开始派发请求之前的时间，observationStoppedAt 是结束来源收取后的时间，均不是所有来源同时启停的时刻。生命周期时间使用服务单调参考轴；只有 calibrations 中实际成功的时钟样本参与跨源映射，不能用 registeredAt/atMs 与源事件直接相减。没有该字段的历史包继续兼容。

Stats 启用期间，status 返回当前计数、gauge 与直方图快照，可低频轮询查看实时统计；不会为每次聚合更新读取时间。离线 Perfetto 只保存窗口结束时的聚合快照，不伪造成逐时刻的历史曲线。

stop 后工具分批取回记录并释放源端存储；export 将缓存内容保存为新目录，重复 export 返回同一目录。每个服务实例最多四场会话，导出后可重启服务，不让历史会话无限占用内存。低层直接调用 snapshot 是同步冷路径接口，大量记录应使用控制分页；停止后直接调用 release 可释放存储。

导出包包含 manifest.json、raw.json、quality.json 和 traces/*.pftrace，带文件 SHA-256。分析先校验完整性，再用固定 Trace Processor 和 SQL，返回查询文本、版本、数据域、质量、原始引用和源码标记。导出目录不可覆盖；分析结果另存。

```text
node packages/profile-tools/dist/cli.js sql --query queues
```

该命令输出与 Agent 相同的 SQL，可粘贴到 Perfetto UI 的查询窗口。分别打开各 domain 的 pftrace，不能把独立文件的时间轴直接相减。缺端点、歧义关系或缺校准时使用 quality/relations 的未知说明；通用 UI 的数值不替代这些检查。

## 验证命令

```text
npm run typecheck
npm test
npm run build
npm run verify:optional
npm run verify:perfetto
npm run verify:browser
npm run demo
npm run benchmark
npm run benchmark:throughput
npm run benchmark:browser
npm run benchmark:cpu
```

性能基准应串行执行；运行前重新 build。每次保留独立目录、源码摘要、原始样本和三态预算判定，不覆盖旧报告。可用 `-- --tag before` / `-- --tag after` 标记优化前后；负载、轮数和缓冲策略必须一致。CPU 与墙钟分别判定，Chrome 墙钟不能充当 CPU。方法、证据量要求及噪声处理见 [性能基准](benchmark-method.md)，已完成结论见 [验证报告](verification.md)。

纯 C# 检查使用 `dotnet run --project tests/native/NativeBridge.Tests.csproj`；建议将 DOTNET_CLI_HOME、NUGET_PACKAGES 指向本仓 `.cache`，关闭 SDK 遥测与首次证书生成。它不代表 Unity 实测。
