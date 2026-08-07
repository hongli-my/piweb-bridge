#!/usr/bin/env bash
# ============================================================
# pi-bridge 启动脚本
# 把 pi-coding-agent 的 AgentSession 桥接成 HTTP/SSE 供 piweb 前端消费
# ============================================================
# 必需的模型认证环境变量（与 pi CLI 一致）：
#   PI_PROVIDER          如 my-openai-proxy
#   PI_MODEL             如 glm5-cdp
#   OPENAI_API_KEY       API key
#   OPENAI_BASE_URL      兼容 OpenAI 的接口地址
#
# 可选：
#   PIWEB_PORT           默认 8643
#   PIWEB_CWD            agent 默认工作目录，默认本脚本的上级目录（~/ai-home）
#                        新建会话若未指定目录则用此值；前端可在项目选择器切换其它目录
#   PIWEB_AGENT_DIR      pi 配置目录，默认 ~/.pi/agent
# ============================================================
set -e
cd "$(dirname "$0")"

# 默认 cwd = 上级目录（~/ai-home）
DEFAULT_CWD="$(cd "$(dirname "$0")/.." && pwd)"

# 清除 pi 会话环境变量：pi-bridge 作为独立服务，不能继承当前 pi 会话的
# PI_SESSION_FILE/PI_SESSION_ID 等，否则 SDK 会误以为是子代理或复用会话导致 hang
exec env -u PI_SESSION_FILE -u PI_SESSION_ID -u PI_SUBAGENT_PARENT_SESSION -u PI_CODING_AGENT \
    PIWEB_PORT="${PIWEB_PORT:-8643}" \
    PIWEB_CWD="${PIWEB_CWD:-$DEFAULT_CWD}" \
    PI_PROVIDER="${PI_PROVIDER:-my-provider}" \
    PI_MODEL="${PI_MODEL:-glm5-cdp}" \
    OPENAI_API_KEY="${OPENAI_API_KEY}" \
    OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://11.160.215.64/v1}" \
    bun run pi-bridge.ts
