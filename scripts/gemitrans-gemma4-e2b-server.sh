#!/usr/bin/env bash
#
# GemiTrans向け Gemma 4 E2B QAT llama.cpp サーバーを GTX 1080 ホストで管理する。
# GemiTransの12件バッチ・2並列リクエストを2スロットで処理する。
#
# Usage:
#   bash scripts/gemitrans-gemma4-e2b-server.sh start
#   bash scripts/gemitrans-gemma4-e2b-server.sh status
#   bash scripts/gemitrans-gemma4-e2b-server.sh logs
#   bash scripts/gemitrans-gemma4-e2b-server.sh stop

set -euo pipefail

ACTION="${1:-status}"
SSH_HOST="${GEMITRANS_SSH_HOST:-192.168.11.20}"
PORT="${GEMITRANS_GEMMA4_E2B_PORT:-8080}"
CONTAINER_NAME="${GEMITRANS_GEMMA4_E2B_CONTAINER:-gemitrans-gemma4-e2b}"
MODEL_ALIAS="${GEMITRANS_GEMMA4_E2B_ALIAS:-gemitrans-gemma4-e2b}"
MODEL_REPO="${GEMITRANS_GEMMA4_E2B_REPO:-google/gemma-4-E2B-it-qat-q4_0-gguf:Q4_0}"
IMAGE="${GEMITRANS_GEMMA4_E2B_IMAGE:-nvidia/cuda:12.4.1-devel-ubuntu22.04}"
LLAMA_SERVER="${GEMITRANS_LLAMA_SERVER:-./llama.cpp/build-cuda61/bin/llama-server}"

case "$ACTION" in
    start|restart)
        ssh "$SSH_HOST" docker rm -f gemitrans-hymt2 >/dev/null 2>&1 || true
        ssh "$SSH_HOST" docker rm -f gemitrans-gemma4 >/dev/null 2>&1 || true
        ssh "$SSH_HOST" docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
        ssh "$SSH_HOST" wsl -e bash -s <<REMOTE
set -euo pipefail
mkdir -p "\$HOME/llama-models/gemma4-e2b-cache"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --gpus all \
  -p "$PORT:8080" \
  -v "\$HOME/llama-cpp-gemma4:/work" \
  -v "\$HOME/llama-models/gemma4-e2b-cache:/root/.cache/llama.cpp" \
  -w /work \
  "$IMAGE" \
  "$LLAMA_SERVER" \
  -hf "$MODEL_REPO" \
  -a "$MODEL_ALIAS" \
  -ngl 99 -fa on --no-mmap \
  -c 8192 -np 2 -cb \
  -rea off --reasoning-budget 0 \
  --host 0.0.0.0 --port 8080 >/dev/null
REMOTE

        printf 'Gemma 4 E2B server loading at http://%s:%s' "$SSH_HOST" "$PORT"
        for _ in {1..72}; do
            if curl -fsS --max-time 3 "http://$SSH_HOST:$PORT/health" >/dev/null 2>&1; then
                printf '\nready: model=%s endpoint=http://%s:%s\n' "$MODEL_ALIAS" "$SSH_HOST" "$PORT"
                exit 0
            fi
            printf '.'
            sleep 3
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
