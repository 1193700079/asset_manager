#!/usr/bin/env bash
# Daemonized launcher for the VFE backend.
# - Detaches from the controlling terminal (survives SSH disconnect).
# - Auto-restarts on crash with exponential backoff (capped).
# - Single-instance: refuses to start a second copy on the same port.
# - Logs to logs/vfe-server.log.
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/vfe-server.log"
PID_FILE="$LOG_DIR/vfe-server.pid"
PORT="${PORT:-8899}"

mkdir -p "$LOG_DIR"

cmd_status() {
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "running (pid $(cat "$PID_FILE"))"
        return 0
    fi
    echo "stopped"
    return 1
}

cmd_stop() {
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        local pid
        pid="$(cat "$PID_FILE")"
        echo "stopping supervisor pid $pid"
        kill -TERM "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.3
        done
        kill -KILL "$pid" 2>/dev/null || true
    fi
    pkill -f "node $ROOT_DIR/server/index.mjs" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "stopped"
}

cmd_start() {
    if cmd_status >/dev/null; then
        echo "already running"
        exit 0
    fi
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${PORT}$"; then
        echo "port ${PORT} already in use; refusing to start"
        exit 1
    fi
    nohup setsid bash "$0" __supervisor >>"$LOG_FILE" 2>&1 < /dev/null &
    disown || true
    echo "started (logs: $LOG_FILE)"
}

cmd_supervisor() {
    echo "$$" > "$PID_FILE"
    trap 'rm -f "$PID_FILE"; exit 0' TERM INT
    local backoff=1
    while true; do
        echo "[supervisor $(date -Iseconds)] launching node server/index.mjs (PORT=$PORT)"
        PORT="$PORT" node "$ROOT_DIR/server/index.mjs"
        local rc=$?
        echo "[supervisor $(date -Iseconds)] child exited rc=$rc; restarting in ${backoff}s"
        sleep "$backoff"
        backoff=$(( backoff * 2 ))
        if (( backoff > 30 )); then backoff=30; fi
    done
}

case "${1:-start}" in
    start)       cmd_start ;;
    stop)        cmd_stop ;;
    restart)     cmd_stop; cmd_start ;;
    status)      cmd_status ;;
    __supervisor) cmd_supervisor ;;
    *)           echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
