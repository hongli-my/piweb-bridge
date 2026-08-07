#!/usr/bin/env bash
# ============================================================
# pi-bridge 启动脚本
# 把 pi-coding-agent 的 AgentSession 桥接成 HTTP/SSE 供 piweb 前端消费
# ============================================================
# 用法：
#   ./start.sh              # 前台启动
#   ./start.sh start        # 后台启动
#   ./start.sh stop         # 停止
#   ./start.sh restart      # 重启
#   ./start.sh status       # 查看状态
#   ./start.sh logs         # 查看日志
#
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

# 脚本目录和 PID/日志文件路径
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/pi-bridge.pid"
LOG_FILE="$SCRIPT_DIR/pi-bridge.log"

# 默认 cwd = 上级目录（~/ai-home）
DEFAULT_CWD="$(cd "$SCRIPT_DIR/.." && pwd)"

# 检查 pi-bridge 是否运行
check_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            return 0  # 运行中
        else
            # PID 文件存在但进程不存在，清理
            rm -f "$PID_FILE"
            return 1  # 未运行
        fi
    else
        return 1  # 未运行
    fi
}

# 前台启动
start_foreground() {
    cd "$SCRIPT_DIR"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 前台启动 pi-bridge..."
    echo "日志将输出到终端"
    echo "按 Ctrl+C 停止"
    echo ""

    # 清除 pi 会话环境变量并启动
    exec env -u PI_SESSION_FILE -u PI_SESSION_ID -u PI_SUBAGENT_PARENT_SESSION -u PI_CODING_AGENT \
        PIWEB_PORT="${PIWEB_PORT:-8643}" \
        PIWEB_CWD="${PIWEB_CWD:-$DEFAULT_CWD}" \
        PI_PROVIDER="${PI_PROVIDER:-my-provider}" \
        PI_MODEL="${PI_MODEL:-glm5-cdp}" \
        OPENAI_API_KEY="${OPENAI_API_KEY}" \
        OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://11.160.215.64/v1}" \
        bun run pi-bridge.ts
}

# 后台启动
start_background() {
    if check_running; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] pi-bridge 已经在运行 (PID: $(cat "$PID_FILE"))"
        return 1
    fi

    cd "$SCRIPT_DIR"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 后台启动 pi-bridge..."
    echo "PID 文件: $PID_FILE"
    echo "日志文件: $LOG_FILE"
    echo ""

    # 清除 pi 会话环境变量并在后台启动
    nohup env -u PI_SESSION_FILE -u PI_SESSION_ID -u PI_SUBAGENT_PARENT_SESSION -u PI_CODING_AGENT \
        PIWEB_PORT="${PIWEB_PORT:-8643}" \
        PIWEB_CWD="${PIWEB_CWD:-$DEFAULT_CWD}" \
        PI_PROVIDER="${PI_PROVIDER:-my-provider}" \
        PI_MODEL="${PI_MODEL:-glm5-cdp}" \
        OPENAI_API_KEY="${OPENAI_API_KEY}" \
        OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://11.160.215.64/v1}" \
        bun run pi-bridge.ts > "$LOG_FILE" 2>&1 &

    # 保存 PID
    echo $! > "$PID_FILE"

    # 等待一下确认启动成功
    sleep 2
    if check_running; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] pi-bridge 启动成功 (PID: $(cat "$PID_FILE"))"
        echo "查看日志: tail -f $LOG_FILE"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] pi-bridge 启动失败，请检查日志: $LOG_FILE"
        return 1
    fi
}

# 停止
stop() {
    if check_running; then
        PID=$(cat "$PID_FILE")
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 停止 pi-bridge (PID: $PID)..."
        kill "$PID" 2>/dev/null || true

        # 等待进程停止
        for i in {1..10}; do
            if ! ps -p "$PID" > /dev/null 2>&1; then
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] pi-bridge 已停止"
                rm -f "$PID_FILE"
                return 0
            fi
            sleep 1
        done

        # 强制停止
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 强制停止 pi-bridge..."
        kill -9 "$PID" 2>/dev/null || true
        rm -f "$PID_FILE"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] pi-bridge 已强制停止"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] pi-bridge 未运行"
    fi
}

# 查看状态
status() {
    if check_running; then
        PID=$(cat "$PID_FILE")
        echo "pi-bridge 正在运行"
        echo "  PID: $PID"
        echo "  日志: $LOG_FILE"

        # 检查端口
        PORT="${PIWEB_PORT:-8643}"
        if lsof -i :$PORT > /dev/null 2>&1; then
            echo "  端口 $PORT: 监听中"
        else
            echo "  端口 $PORT: 未监听"
        fi

        # 测试 HTTP 接口
        if curl -s http://localhost:$PORT/health > /dev/null 2>&1; then
            echo "  HTTP: 正常"
        else
            echo "  HTTP: 无响应"
        fi
    else
        echo "pi-bridge 未运行"
    fi
}

# 查看日志
logs() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo "日志文件不存在: $LOG_FILE"
    fi
}

# 显示帮助
show_help() {
    echo "用法: $0 [命令]"
    echo ""
    echo "命令："
    echo "  (无参数)    前台启动"
    echo "  start       后台启动"
    echo "  stop        停止"
    echo "  restart     重启"
    echo "  status      查看状态"
    echo "  logs        查看日志"
    echo "  help        显示帮助"
}

# 主逻辑
case "${1:-}" in
    start)
        start_background
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 1
        start_background
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    foreground|"")
        start_foreground
        ;;
    help|-h|--help)
        show_help
        ;;
    *)
        echo "未知命令: $1"
        show_help
        exit 1
        ;;
esac
