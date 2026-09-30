#!/usr/bin/env bash
# 把 platform-trainer 映像載入 kind 節點：GPU 兩個池（訓練、影像批次推論）與 cpu-data（結構式批次推論）。可重複執行。
#   ./load-trainer-image.sh            先 docker build 再載入
#   SKIP_BUILD=1 ./load-trainer-image.sh
#   NODES=ai-platform-worker2,ai-platform-worker3 ./load-trainer-image.sh   只載入 cpu-data 與獨占池（映像約 6 GB，磁碟吃緊時用）
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${TRAINING_IMAGE:-platform-trainer:dev}"
[ -n "${SKIP_BUILD:-}" ] || docker build -f ../../training/Dockerfile -t "$IMAGE" ../..
NODES="${NODES:-ai-platform-worker2,ai-platform-worker3,ai-platform-worker4}"
kind load docker-image "$IMAGE" --name ai-platform --nodes "$NODES"
echo "已載入 $IMAGE 到 $NODES"
