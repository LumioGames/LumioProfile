---
name: mvp-usage
description: 当前构建、三端 connect() 接入、COOP/COEP 高精度配置、开发态令牌下发与 Agent CLI 可执行指引
metadata:
  type: doc
  status: 已交付
---

# 运行与接入指引（v0.2.0）

使用 Node >=22.18（已在 Windows Node 24.18.0、macOS Node 22.23.2 / 24.x 验证）。在本仓执行：

```text
npm ci
npm run setup:perfetto
npm run demo
```

- `npm ci` 会自动执行 `prepare` 脚本构建 `packages/profile/dist`、`packages/profile-tools/dist` 及 `contracts/browser-v1.d.ts`，外部仓库通过本地路径或 Git 同步拉取后无需再手动先跑构建。
- `npm run setup:perfetto` 支持 `win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`linux-arm`，自动读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，校验官方 Perfetto v58.2 SHA-256 并在下载后预热执行一次 `--version`（避免 macOS 首次运行的系统扫描导致第一次分析空输出）。

## 1. 宿主可选契约与单文件浏览器类型

普通业务代码仅依赖宿主本地的轻量契约，绝不导入插件包：

- 仅需写入接口时：复制 `contracts/observation-v1.d.ts`（或从已安装包的 `@lumio/profile/contract` 参考）。
- 若前端开发服务器通过别名重定向将 `/@lumio/profile/browser` 指向单文件 `packages/profile/dist/browser.js`：可直接复制零相对导入的单文件声明 `contracts/browser-v1.d.ts`（或引用 `@lumio/profile/browser-standalone`），无需拼装多个内部 `.d.ts`。
- 若引擎与游戏各自维护标记段（例如引擎持有 `100–156` 号 `ENGINE_PROFILE_MARKERS`，游戏持有 `200+` 号业务标记）：引擎入口应导出其 `Marker[]` 常量，游戏诊断入口用 `mergeMarkers(ENGINE_PROFILE_MARKERS, GAME_MARKERS)` 一行合并并校验 ID 无冲突。

```ts
// 普通业务热路径：关闭判断先于任何参数构造与计时
if (PROFILE_COMPILED) {
  const writer = profileHost.trace;
  if (writer) {
    const token = writer.begin(201, { tick: currentTick });
    try {
      stepSimulation();
    } finally {
      // 既可复用局部变量 writer.end(token)，也可安全重读 profileHost.trace?.end(token)：
      // 令牌高位携带会话代次，跨场迟到 end 不会误关新一场的区间。
      writer.end(token);
    }
  }
}
```

## 2. 三端装配与一键连接 `connect()`

工厂创建实例后仍保持 Off；`profiler.connect({ endpoint, token })` 封装 WebSocket 建连、首帧认证（**令牌放在握手消息中，不拼入 WebSocket URL 参数**）、`helloAck` 确认、服务重启后的指数退避自动重连、Worker 套接字异常隔离以及 `close()` 清理（支持 `Symbol.dispose`，热更新 dispose 时调用 `conn.close()` 即可断开旧连接）：

```ts
import { createBrowserProfiler, mergeMarkers } from '@lumio/profile/browser';

const profiler = createBrowserProfiler({
  host: profileHost,
  role: 'client-main',
  markers: mergeMarkers(engineMarkers, gameMarkers),
  build: { id: BUILD_ID, mode: 'debug', codeEpoch: '1' },
  onFault(fault) {
    // 当发生 clock-fault / writer-fault 内部自动卸载 writer 时通知接入方
    console.warn('[LumioProfile] writer detached:', fault);
  }
});

// 检验标记表是否合法（若不合法，validationErrors 会精确指出第几个标记违反了哪条规则）
if (!profiler.inspect().supported) {
  console.error('[LumioProfile] invalid catalog:', profiler.validationErrors);
}

const connection = profiler.connect({ endpoint: 'ws://127.0.0.1:9466/target', token });
await connection.ready; // 服务已完成注册，立即可被 targets / prepare 发现
// 热更新或卸载时：connection.close();
```

- **Node 主线程与各 Room Worker**：从 `@lumio/profile/node` 导入 `createNodeProfiler`，同样调用 `profiler.connect({ endpoint, token })`。
- **受限 Worker 无直连 WebSocket 场景**：可使用 `messagePortChannel(port)` 经主线程 `MessagePort` 转发控制消息。
- **PuerTS**：从 `@lumio/profile/puerts` 导入 `createPuertsProfiler`，注入 `nativeBridge` 与宿主通道（注：真实 Unity/PuerTS 运行环境尚未实测）。

## 3. 浏览器高精度时钟（COOP/COEP）与开发态安全下发令牌

### 开启 0.005ms 时钟分辨率与浏览器 JS 采样

未开启跨源隔离时，浏览器会将 `performance.now()` 粗化至 `0.1ms`（100µs），小于 0.1ms 的微区间会大量测得 `0ms`（分析报告会提示 `coarse-browser-clock-unisolated`）。在开发服务器（如 Vite `server.headers`）添加以下响应头，可将时钟分辨率提升至约 **`0.005ms`（5µs）**，并同时解锁浏览器原生 `Profiler`（JS Self-Profiling API）：

```ts
// vite.config.ts（仅开发或诊断预览开启）
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Document-Policy': 'js-profiling'
  }
}
```

若页面引用了第三方跨域图片/脚本且无法加 `CORP` 头，可将 `Cross-Origin-Embedder-Policy` 设为 `credentialless`（Chromium 支持）。采集结果在 `environment.crossOriginIsolated` 和 `clock.precisionMs` 中自动记录实际状态。

### 开发态令牌下发做法（令牌不入构建产物、不进网址）

1. 本机生成仅当前用户可读的令牌文件（权限 `0600`，至少 16 字符）：
   `umask 077 && openssl rand -hex 24 > .cache/profile-token`
2. 在开发服务器（如 Vite `configureServer` 中间件，仅 `vite dev` 存在，正式打包不包含该路由）暴露同源只读开发接口（例如 `GET /dev/profile`），校验请求来自回环地址后返回 `{ endpoint: 'ws://127.0.0.1:9466/target', token }`。
3. 页面在 `?profile=1` 时 `fetch('/dev/profile')` 拿到 `{ endpoint, token }`，传给 `profiler.connect({ endpoint, token })`（及通过 `postMessage` 传给同源 Worker）。WebSocket 地址保持纯路径 `ws://127.0.0.1:9466/target`，不在浏览器 Network URL 栏或访问日志中暴露令牌。

## 4. Agent CLI 控制、自动数据源与查询命令

```text
# 1. 启动常驻本地协调服务（支持多个 --origin 或逗号分隔；导出后自动释放内存，可连续采任意多场）
node packages/profile-tools/dist/cli.js serve \
  --token-file .cache/profile-token \
  --port 9466 \
  --origin http://localhost:5173,http://127.0.0.1:5173 \
  --clock-interval 1s --clock-valid-for 2500ms

# 2. 查看已注册目标（--url 支持 127.0.0.1 与 localhost）
node packages/profile-tools/dist/cli.js targets --token-file .cache/profile-token --url http://localhost:9466

# 3. 准备采集（支持 15s / 500ms / 2m 时长单位、8mb 容量单位、--markers 过滤、--collectors 自动数据源、hybrid 混合模式）
node packages/profile-tools/dist/cli.js prepare \
  --token-file .cache/profile-token \
  --targets SOURCE_MAIN,SOURCE_ROOM,SOURCE_PREDICT \
  --mode hybrid \
  --duration 15s \
  --bytes 8mb \
  --markers 101,102,201 \
  --collectors raf,longtasks,loaf,gc,cpu \
  --stats-interval 250ms \
  --plan .cache/plan.json

# 4. 开始、状态、停止、单来源失败补拉（按需）、导出
node packages/profile-tools/dist/cli.js start --token-file .cache/profile-token --plan .cache/plan.json --request-id req-001
node packages/profile-tools/dist/cli.js status --token-file .cache/profile-token --capture CAPTURE_ID
node packages/profile-tools/dist/cli.js stop --token-file .cache/profile-token --capture CAPTURE_ID
node packages/profile-tools/dist/cli.js pull --token-file .cache/profile-token --capture CAPTURE_ID
node packages/profile-tools/dist/cli.js export --token-file .cache/profile-token --capture CAPTURE_ID

# 5. 分析（在任意工作目录运行都会自动定位 LumioProfile 仓库内已下载的 Perfetto 二进制）
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query overview
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query hotspots
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query percentiles
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query frames
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query cpu-hotspots
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query runtime
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query queues
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --query operation --key SESSION/OP_KEY
node packages/profile-tools/dist/cli.js analyze CAPTURE_DIR --sql "SELECT name, COUNT(*) AS n FROM slice GROUP BY name ORDER BY n DESC LIMIT 20;"
```

## 5. 验证命令

```text
npm run verify
```

或分步运行：`npm run typecheck`、`npm test`、`npm run build`、`npm run verify:optional`、`npm run verify:perfetto`、`npm run verify:browser`、`npm run demo`、`npm run verify:docs`。
