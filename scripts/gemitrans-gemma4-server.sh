#!/usr/bin/env bash
#
# GemiTrans向け Gemma 4 26B llama.cpp サーバーを GTX 1080 ホストで管理する。
#
# Usage:
#   bash scripts/gemitrans-gemma4-server.sh start
#   bash scripts/gemitrans-gemma4-server.sh status
#   bash scripts/gemitrans-gemma4-server.sh logs
#   bash scripts/gemitrans-gemma4-server.sh stop

set -euo pipefail

ACTION="${1:-status}"
SSH_HOST="${GEMITRANS_SSH_HOST:-192.168.11.20}"
PORT="${GEMITRANS_GEMMA4_PORT:-8080}"
CONTAINER_NAME="${GEMITRANS_GEMMA4_CONTAINER:-gemitrans-gemma4}"
MODEL_ALIAS="${GEMITRANS_GEMMA4_ALIAS:-gemitrans-gemma4}"
MODEL_PATH="${GEMITRANS_GEMMA4_MODEL_PATH:-/models/models--unsloth--gemma-4-26B-A4B-it-qat-GGUF/snapshots/02749a7b272109255a4c559a80894d3d9777574c/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf}"
IMAGE="${GEMITRANS_GEMMA4_IMAGE:-nvidia/cuda:12.4.1-devel-ubuntu22.04}"
LLAMA_SERVER="${GEMITRANS_LLAMA_SERVER:-./llama.cpp/build-cuda61/bin/llama-server}"

case "$ACTION" in
    start|restart)
        # --no-mmap でモデル常駐中はWSLの空きメモリが少ないため、
        # 既存コンテナの停止は新しいWSLプロセスを起動せずWindows側Docker CLIで行う。
        ssh "$SSH_HOST" docker rm -f gemitrans-hymt2 >/dev/null 2>&1 || true
        ssh "$SSH_HOST" docker rm -f gemitrans-gemma4-e2b >/dev/null 2>&1 || true
        ssh "$SSH_HOST" docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
        ssh "$SSH_HOST" wsl -e bash -s <<REMOTE
set -euo pipefail
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --gpus all \
  -p "$PORT:8080" \
  -v "\$HOME/llama-cpp-gemma4:/work" \
  -v "\$HOME/llama-models:/models:ro" \
  -w /work \
  "$IMAGE" \
  "$LLAMA_SERVER" \
  -m "$MODEL_PATH" \
  -a "$MODEL_ALIAS" \
  -ngl 30 -ncmoe 16 -fa on --no-mmap \
  -c 4096 -np 1 -cb \
  -rea off --reasoning-budget 0 \
  --host 0.0.0.0 --port 8080 >/dev/null
REMOTE

        printf 'Gemma 4 server loading at http://%s:%s' "$SSH_HOST" "$PORT"
        for _ in {1..36}; do
            if curl -fsS --max-time 3 "http://$SSH_HOST:$PORT/health" >/dev/null 2>&1; then
                printf '\nready: model=%s endpoint=http://%s:%s\n' "$MODEL_ALIAS" "$SSH_HOST" "$PORT"
                exit 0
            fi
            printf '.'
            sleep 5
        done
        printf '\nserver did not become ready; inspect logs with: %s logs\n' "$0" >&2
        exit 1
        ;;
    stop)
        ssh "$SSH_HOST" docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
        echo "stopped: $CONTAINER_NAME"
        ;;
    status)
        ssh "$SSH_HOST" docker ps -a --filter "name=$CONTAINER_NAME"
        ssh "$SSH_HOST" nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader
        ;;
    logs)
        ssh "$SSH_HOST" docker logs --tail 120 "$CONTAINER_NAME"
        ;;
    *)
        echo "usage: $0 {start|restart|stop|status|logs}" >&2
        exit 2
        ;;
esac
