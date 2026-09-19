# piweb-bridge

把 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) 的 `AgentSession`
桥接成 HTTP/SSE 服务，供 [slate](https://github.com/hongli-my/slate) Tauri app 及任何前端消费。

```
任意前端 (浏览器 / Tauri webview / curl)
   │ HTTP + SSE
   ▼
pi-bridge :8643  ──SDK 进程内──▶  pi AgentSession  ──▶  LLM (OpenAI 兼容 / Anthropic / ...)
```

---

## 快速开始

本仓库**可独立编译、独立运行**，不依赖 slate 或其他宿主。

```bash
cd ~/ai-home/piweb-bridge

# 1. 安装依赖（首次）
bun install
```

### 启动

```bash
# 前台运行（调试）
./start.sh                    # 等价：bun run start / ./start.sh foreground

# 后台常驻（带崩溃自重启守护）
./start.sh start
./start.sh status             # 进程 / 端口 / HTTP 探活
./start.sh logs               # tail -f log/pi-bridge.log
./start.sh stop

# 探活
curl -s http://127.0.0.1:8643/health
# {"ok":true,"status":"up"}
```

> 启动前需配好模型认证（见下方[配置项](#配置项)）：至少 `OPENAI_API_KEY`，
> 或先把 `~/.pi/agent/auth.json` 配好。无可用模型时进程会直接退出并提示。

### 编译为独立单二进制

```bash
./build.sh                    # 等价：bun run build
# → dist/pi-bridge-aarch64-apple-darwin（~71MB，含 Bun runtime + pi SDK，已 ad-hoc 签名）

# 直接独立运行，不需要 bun / node_modules
PIWEB_PORT=8643 ./dist/pi-bridge-aarch64-apple-darwin
```

`build.sh` 内部依次做：`bun install` → `bun build --compile --minify --sourcemap`
→ 按 rust triple 重命名 → macOS ad-hoc 签名（JIT entitlements）。
跨平台编译用 `PI_BRIDGE_TARGET` + `PI_BRIDGE_TRIPLE` 覆盖，产物表见[编译为单二进制](#编译为单二进制)。

---

## 设计原则：**零翻译透传**

pi-bridge 不做协议翻译。它**原样**暴露 pi SDK 的数据模型：

| 数据 | 形态 |
|------|------|
| `GET /sessions/:id/messages` | pi 原生 `AgentMessage[]`（content blocks：`Text` / `Thinking` / `ToolCall` + `toolResult` 消息） |
| `POST /chat/stream` (SSE) | pi 原生 `AgentSessionEvent` 序列化为 `data: <json>`（仅做体积裁剪，不改语义） |

> 早期版本会把 `AgentMessage` 翻译成 Hermes/OpenAI 兼容格式（`content: string` + `tool_calls` + `reasoning`）。
> 该翻译层（`toHermesMessage` / `transformEvent`）已被**彻底删除**——两套消息模型靠字符串字段名耦合，
> 是当时最大的复杂度来源。前端改为直接消费 pi 原生结构。

**SSE 事件类型**：`agent_start` · `turn_start` · `message_start` · `message_update`
（`text_delta` / `thinking_delta` / `toolcall_*`）· `tool_execution_start` / `update` / `end` ·
`message_end` · `turn_end` · `agent_end` · `agent_settled` · `extension_ui_request` · `queue_update`

**REST 响应约定**：统一 `{ ok: true, data }` / `{ ok: false, error }`。

---

## 模型认证与启动细节

### 模型认证（与 pi CLI 一致）

```bash
export PI_PROVIDER=my-openai-proxy
export PI_MODEL=glm5-cdp
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=http://your-proxy/v1
```

模型也可在 `~/.pi/agent/models.json` 里自定义 provider。pi-bridge 启动时只暴露
**自定义 provider** 下的模型（过滤 SDK 内置项），用 `PI_PROVIDER` / `PI_MODEL` 指定默认；
都没配时依次回退 `anthropic` → `openai` → 列表首个，全无则退出并提示。

### `start.sh` 行为

| 调用 | 行为 |
|------|------|
| `./start.sh` · `./start.sh foreground` | 前台运行，日志打到终端 |
| `./start.sh start` | 后台守护循环：bun 退出后自动重启，指数退避 3s→60s（运行 >30s 视为健康并重置） |
| `./start.sh stop` | 停守护进程并转发 TERM 给 bun 子进程；超时 10s 后 `kill -9` |
| `./start.sh restart` | stop → 等 1s → start |
| `./start.sh status` | PID / 端口监听 / `/health` 探活 三项检查 |
| `./start.sh logs` | `tail -f log/pi-bridge.log` |

- 日志：`log/pi-bridge.log`；PID：`log/pi-bridge.pid`
- 默认 `PIWEB_CWD` 为 `~/ai-home`（脚本上级目录）
- 启动前会清除 `PI_SESSION_FILE` / `PI_SESSION_ID` / `PI_SUBAGENT_PARENT_SESSION` /
  `PI_CODING_AGENT`，避免从 pi CLI 会话内启动时误继承环境导致 hang

---

## 依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| `@earendil-works/pi-coding-agent` | `^0.85.1` | pi AgentSession SDK，**编译时会整个打进二进制** |
| `croner` | `^10.0.1` | `/schedules` 定时任务的 cron 调度 |

> ⚠️ **不要降到 0.84.x，也不要写 `^0.85.0`**：
> - 0.84.x 与当前 pi CLI（0.85.1）共用同一份 `~/.pi/agent/`（sessions / settings / models），
>   会产生版本错位；且缺 0.85 的几项关键修复：续接会话写坏 JSONL 尾记录（#8345）、
>   工具忽略 `ctx.cwd`（#8627）、fork 丢失压缩边界（#8990）、分支摘要被 reasoning 输出上限打断（#8845）
> - 0.85.0 存在发布事故（publish 了内部 experimental 代码导致 SDK import 失败），0.85.1 才修好

---

## 配置项

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PIWEB_PORT` | `8643` | 监听端口 |
| `PIWEB_CWD` | `process.cwd()` | 新建会话的默认工作目录 |
| `PIWEB_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json / models.json / settings.json / sessions） |
| `PIWEB_SESSION_CACHE_SIZE` | `16` | 常驻 `AgentSession` 缓存上限 |
| `PIWEB_HEARTBEAT_MS` | `5000` | SSE 心跳间隔（防中间层断流） |
| `PIWEB_MAX_STREAM_MS` | `1800000` | 单次流式对话上限（30 分钟） |
| `PIWEB_SCHEDULE_TIMEOUT_MS` | `300000` | 定时任务单次执行上限（5 分钟） |
| `PI_PROVIDER` | — | 默认模型 provider，与 pi CLI 一致 |
| `PI_MODEL` | — | 默认模型 id，与 pi CLI 一致 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | OpenAI 兼容接口认证（SDK 层读取） |

启动时会清除 `PI_SESSION_FILE` / `PI_SESSION_ID` / `PI_SUBAGENT_PARENT_SESSION` /
`PI_CODING_AGENT`（`start.sh` 负责），避免误继承 pi CLI 的会话环境导致 hang。

---

## pi session 与目录的关系

pi 的 session **按 cwd 分目录存储**，无需额外关联表：

```
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

- 编码规则：cwd 去掉前导 `/`，把 `/ \ :` 替换成 `-`，首尾加 `--`
  例：`/Users/me/proj` → `--Users-me-proj--`
- session 文件头记录原始 `cwd`，`SessionInfo.cwd` 直接返回
- 恢复已有会话时用 **session 自身记录的 cwd**（`sm.getCwd()`），而非全局 `PIWEB_CWD`，
  否则 agent 会在 sidecar 启动目录而非项目目录里执行；旧 session 无 cwd 时回退全局值

前端的"项目"概念 = pi 的 cwd：`GET /projects` 从所有 session 的 cwd 聚合出目录列表。

---

## REST 接口

### 健康 / 状态
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/status` · `/gateway_status` | 状态 + 当前默认模型 |

### 会话
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sessions` | 会话列表（带 cwd） |
| POST | `/sessions` | 新建会话（body: `working_dir`；`clip: true` 建无工具剪藏会话） |
| GET | `/sessions/:id` | 会话详情（model / 时间跨度 / 消息数 / token 用量） |
| GET | `/sessions/:id/messages` | pi 原生 `AgentMessage[]`；`?offset=N` 增量拉取 |
| PATCH | `/sessions/:id` | 改名（body: `title`） |
| DELETE | `/sessions/:id` | 删除 |
| POST | `/sessions/:id/fork` | fork 当前分支为新会话 |

### 对话
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/chat/stream` | 流式对话 SSE（body: `session_id`, `message`, `images?` dataURL 数组） |
| POST | `/steer` | 边跑边插话 |
| POST | `/follow_up` | 跑完再做 |
| POST | `/abort` | 中止当前生成 |
| POST | `/compact` | 压缩上下文（SDK `session.compact()`） |
| POST | `/ui-response` | 扩展 UI 审批响应回传 |
| GET | `/context` | 上下文用量（末轮 assistant 占用，对齐 SDK 压缩阈值） |

### 项目 / 模型
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/projects` | 项目 = 目录列表（从 session cwd 聚合） |
| POST | `/projects` | 新增目录 |
| GET | `/projects/mapping` | sessionId → cwd |
| GET | `/providers` | 自定义 provider（过滤 SDK 内置） |
| GET | `/models` | 可见模型列表 |
| POST | `/model` | 切换默认模型 |

### 扩展管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST | `/agents` | 子 agent 列表 / 新建 |
| PATCH / DELETE | `/agents/:id` | 修改 / 删除子 agent |
| GET | `/extensions` | 扩展列表 |
| GET | `/skills` · `/skills/builtin` | 技能列表 |
| GET / PATCH | `/settings` | pi settings.json 读写（PATCH 为全量合并） |

### 定时任务
| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST | `/schedules` | 定时任务列表 / 新建（cron 表达式 + prompt + cwd + model） |
| PUT / PATCH | `/schedules/:id` | 修改 |
| DELETE | `/schedules/:id` | 删除 |

---

## 编译为单二进制

`build.sh` 一键完成：安装依赖 → `bun build --compile` → 按 rust triple 重命名 →
macOS ad-hoc 签名（JIT entitlements）。

```bash
cd ~/ai-home/piweb-bridge
./build.sh              # 或 bun run build
```

产物落在 `dist/`：

| 平台 | target | 产物 |
|------|--------|------|
| macOS ARM | `bun-darwin-arm64` | `dist/pi-bridge-aarch64-apple-darwin` |
| macOS Intel | `bun-darwin-x64` | `dist/pi-bridge-x86_64-apple-darwin` |
| Linux x64 | `bun-linux-x64` | `dist/pi-bridge-x86_64-unknown-linux-gnu` |
| Windows x64 | `bun-windows-x64` | `dist/pi-bridge-x86_64-pc-windows-msvc.exe` |

跨平台编译用环境变量覆盖：`PI_BRIDGE_TARGET` + `PI_BRIDGE_TRIPLE`。

产物约 71MB（含 Bun runtime + pi SDK）。

**注意事项**
- ⚠️ 不要加 `--bytecode`：与 `pi-bridge.ts` 的 top-level await 不兼容
- 编译后 `import.meta.dir` / `__dirname` 指向虚拟 `/$bunfs/root/`，
  **读运行时用户配置必须用 `os.homedir()`**（代码已如此）
- `process.env` 正常可用，所有 `PIWEB_*` / `OPENAI_*` 由宿主进程 spawn 时注入
- macOS 下 bun 用 JavaScriptCore 需 JIT；宿主 app 若开 `hardenedRuntime`，
  必须带 entitlements 签名，否则子进程被内核直接 kill（`Entitlements.plist`）

### 被 slate 作为 Tauri sidecar 消费

```bash
cp dist/pi-bridge-aarch64-apple-darwin ~/ai-home/slate/src-tauri/binaries/pi-bridge-aarch64-apple-darwin
```

slate 侧由 `src-tauri/src/pi_bridge.rs` 负责生命周期：app `setup` 异步 spawn、
轮询 `/health` 确认 ready、崩溃 3s 退避自动重启（最多 10 次）、`RunEvent::Exit` 时 kill；
设置页通过 invoke 调 start/stop/restart/status，并订阅
`pi-bridge://log|ready|error|terminated` 事件实时显示状态与日志。

---

## 文件结构

```
piweb-bridge/
├── pi-bridge.ts          # 入口：仅 import ./src/server.ts
├── src/
│   ├── config.ts         # 端口/cwd/模型解析/HTTP 工具（CORS, json, readBody）
│   ├── server.ts         # Bun.serve + 路由分发 + 优雅退出
│   ├── session-cache.ts  # AgentSession 缓存（LRU）+ 按 session 记录 cwd 恢复
│   ├── sse.ts            # SSE 流式响应 + 心跳 + busy 锁 + 优雅退出
│   ├── agents.ts         # 子 agent / 扩展 / 技能 / settings CRUD
│   ├── schedules.ts      # cron 定时任务（croner）
│   └── routes/
│       ├── chat.ts       # /chat/stream /steer /follow_up /abort /compact /ui-response
│       ├── sessions.ts   # /sessions* /context /projects*
│       └── models.ts     # /providers /models /model
├── build.sh              # 编译 + 签名 → dist/
├── Entitlements.plist    # macOS JIT 权限
├── start.sh              # 开发用启停脚本（sidecar 模式由宿主 Rust 拉起）
└── package.json
```

`src/server.ts` 的路由分发约定：每个 `handle*Route` 返回 `Response | null`，
`null` 表示不匹配，交给下一个模块。

---

## 调试

```bash
./start.sh logs                                    # 跟踪日志
curl -s localhost:8643/health                      # 探活
curl -s localhost:8643/sessions | head             # 会话列表
```

常见问题：

| 症状 | 处理 |
|------|------|
| `EADDRINUSE` | `./start.sh stop`；兜底 `pkill -f pi-bridge.ts` |
| 默认模型 401 | 检查 `PI_PROVIDER` / `PI_MODEL` / `OPENAI_API_KEY` 是否与 pi CLI 一致 |
| 起不来，提示"没有可用模型" | 先 `pi login` 或配好 `~/.pi/agent/auth.json` |
| 发消息后 hang | `start.sh` 已清 `PI_SESSION_*`；若仍 hang，检查是否从 pi CLI 会话内启动 |
| 前端连接失败 | 确认服务在跑，且宿主 CSP 的 `connect-src` 放行了 `http://127.0.0.1:8643` |
| 流被中间层截断 | 调小 `PIWEB_HEARTBEAT_MS`；反向代理需关闭 SSE buffering |
