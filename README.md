# pi-bridge

把 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) 的 `AgentSession` 桥接成 HTTP/SSE 服务，供 OpenResty 下的 **piweb** 前端消费。

## 它在整体架构中的位置

```
浏览器 http://localhost/  “对话”tab
   │ iframe
   ▼
OpenResty  /piweb/            静态文件 (nginx/html/piweb)
           /piweb/api/*  ──反代──▶  pi-bridge :8643  ──SDK──▶  pi AgentSession
                                         │
                                         ▼
                                   LLM (OpenAI 兼容 / Anthropic / ...)
```

- **前端** `nginx/html/piweb/`：纯静态，复刻自 Hermes WebUI 外壳，事件处理改为 pi 原生 `AgentSessionEvent`
- **反代** `nginx/conf/piweb.conf`：`/piweb/api/` → `127.0.0.1:8643`，SSE 关闭 buffering
- **桥接** `pi-bridge.ts`（本目录）：HTTP/SSE 对外，进程内用 SDK 驱动 `AgentSession`，事件原样透传

## 协议

| 层 | 协议 |
|----|------|
| 浏览器 ↔ OpenResty | HTTP + SSE（`text/event-stream`） |
| OpenResty ↔ pi-bridge | HTTP 反代 |
| pi-bridge ↔ pi | SDK 进程内 `session.subscribe()` 事件流 |

**事件语义**：pi 的 `AgentSessionEvent` 原样序列化为 SSE `data: <json>`，消息体由 pi-bridge 转成前端兼容格式（`content` string + `tool_calls` + `reasoning`），前端渲染逻辑无需改动。

主要事件类型：
`agent_start` · `turn_start` · `message_start` · `message_update`(`text_delta`/`thinking_delta`/`toolcall_*`) · `tool_execution_start`/`update`/`end` · `message_end` · `turn_end` · `agent_end` · `agent_settled` · `extension_ui_request` · `queue_update`

## pi session 与目录的关系（重要）

pi 的 session **按 cwd（工作目录）分目录存储**，无需额外关联表：

```
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

- 编码规则：cwd 去掉前导 `/`，把 `/ \ :` 替换成 `-`，首尾加 `--`
  例：`/Users/honglichang/openresty` → `--Users-honglichang-openresty--`
- 每个 session 文件头记录原始 `cwd`，`SessionInfo.cwd` 直接返回

piweb 的"项目"概念 = pi 的 cwd：
- `GET /projects` 从所有 session 的 cwd 聚合出真实目录列表（`id=cwd`, `name=目录名`）
- 默认"全部目录"显示所有会话；选中某目录只显示该目录的会话
- 新建会话用当前选中目录（或默认 `PIWEB_CWD`）作为 cwd，agent 的文件操作以此为根

## 启动

### 1. 准备模型认证（与 pi CLI 一致，通常已在 shell 环境）

```bash
export PI_PROVIDER=my-openai-proxy
export PI_MODEL=glm5-cdp
export OPENAI_API_KEY=sk-xxx
export OPENAI_BASE_URL=http://your-proxy/v1
```

### 2. 启动 pi-bridge

```bash
cd ~/ai-home/piweb-bridge
./start.sh
# 后台运行：nohup ./start.sh > /tmp/pi-bridge.log 2>&1 &
```

`start.sh` 会自动清除 `PI_SESSION_FILE` / `PI_SESSION_ID` 等环境变量——这些是 pi CLI 当前会话留下的，会让 SDK 误判为子代理导致 hang。

### 3. OpenResty（已配置，只需 reload）

```bash
cd /Users/honglichang/openresty
./nginx/sbin/nginx -t && ./nginx/sbin/nginx -s reload
```

### 4. 访问

打开 http://localhost/ ，点"对话"tab。

## 配置项

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PIWEB_PORT` | 8643 | 监听端口 |
| `PIWEB_CWD` | `~/ai-home`（脚本上级目录） | 新建会话的默认工作目录 |
| `PIWEB_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json/models.json/sessions） |
| `PI_PROVIDER` | - | 模型 provider，与 pi CLI 一致 |
| `PI_MODEL` | - | 模型 id，与 pi CLI 一致 |
| `OPENAI_*` | - | OpenAI 兼容接口认证 |

## REST 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/sessions` | 会话列表（带 cwd） |
| POST | `/sessions` | 新建会话（body: `working_dir`） |
| GET | `/sessions/:id` | 会话详情 |
| GET | `/sessions/:id/messages` | 消息（已转格式） |
| DELETE | `/sessions/:id` | 删除会话 |
| POST | `/sessions/:id/fork` | fork 当前路径为新会话 |
| POST | `/chat/stream` | 流式对话（SSE） |
| POST | `/steer` | 边跑边插话 |
| POST | `/follow_up` | 跑完再做 |
| POST | `/abort` | 中止当前 |
| POST | `/ui-response` | 审批/扩展 UI 响应回传 |
| GET | `/context` | 上下文用量 |
| GET/POST | `/projects` | 项目=目录列表 / 新增目录 |
| GET | `/projects/mapping` | sessionId → cwd |
| GET/POST | `/model` `/providers` `/models` | 模型切换 |

## 与 Hermes 的区别

| | Hermes | piweb |
|---|--------|-------|
| 上游事件 | OpenAI delta + `hermes.*` 补丁 | pi 原生 `AgentSessionEvent` |
| 工具进度 | `hermes.tool.progress/call/result` | `tool_execution_start/update/end`（含流式 partialResult） |
| 思维链 | `delta.reasoning_content` | `thinking_delta` |
| 审批 | `approval.request` + 独立 REST | `extension_ui_request` 子协议 |
| 插话 | ❌ 无 | ✅ `steer` / `followUp` |
| 会话 | 线性 session id | 树形 fork/branch |
| 项目 | 人工 project_id 关联 | 天然 = cwd 目录 |

## 调试

```bash
# 看日志
tail -f /tmp/pi-bridge.log

# 最小 SDK 测试（排除 HTTP 层）
bun run test-sdk.ts

# E2E 浏览器测试（需 playwright，已装）
bun run test-e2e.ts            # 基础对话
bun run test-e2e-tools.ts      # 工具调用
bun run test-projects.ts       # 项目/目录过滤
bun run test-home.ts           # 首页 tab 完整链路
```

常见问题：
- **EADDRINUSE**：`pkill -f pi-bridge.ts` 后重启
- **默认模型 401**：检查 `PI_PROVIDER`/`PI_MODEL`/`OPENAI_API_KEY` 是否与 pi CLI 一致
- **hang 在 user message 后**：start.sh 已清除 `PI_SESSION_*` 环境变量，若仍 hang 检查是否误继承
- **前端连接失败**：确认 pi-bridge 在跑（`curl http://localhost/piweb/api/health`）

## 文件结构

```
~/ai-home/piweb-bridge/
├── pi-bridge.ts        # 桥接服务（HTTP/SSE + SDK）
├── start.sh            # 启动脚本
├── package.json
├── README.md           # 本文件
├── test-sdk.ts         # SDK 最小测试
└── test-e2e*.ts        # E2E 浏览器测试

nginx/html/piweb/       # 前端（copy 自 hermes，已清理冗余）
nginx/conf/piweb.conf   # 静态 + API 反代
```
