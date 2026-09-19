#!/usr/bin/env bun
/**
 * pi-bridge — 把 pi-coding-agent 的 AgentSession 桥接成 HTTP/SSE。
 *
 * 根治后架构（见 REFACTOR.md）：
 *   - 源码拆成 src/ 多模块（config / session-cache / sse / routes / schedules / agents）
 *   - 删除 toHermesMessage / transformEvent 翻译层
 *   - GET /sessions/:id/messages 返回 pi 原生 AgentMessage[]
 *   - SSE 透传 pi 原生 AgentSessionEvent（仅体积裁剪，非翻译）
 *   - 前端认 content blocks (Text|Thinking|ToolCall) + toolResult 消息
 *
 * 启动：bun run pi-bridge.ts
 *   环境变量：PIWEB_PORT(默认8643) PIWEB_CWD(默认process.cwd()) PIWEB_AGENT_DIR(默认~/.pi/agent)
 */
import "./src/server.ts";
