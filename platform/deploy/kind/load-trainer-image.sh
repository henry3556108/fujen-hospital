#!/usr/bin/env bash
# 把 platform-trainer 映像載入 kind 的 GPU 節點（訓練工作只排在這兩個池）。可重複執行。
#   ./load-trainer-image.sh            先 docker build 再載入
#   SKIP_BUILD=1 ./load-trainer-image.sh
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${TRAINING_IMAGE:-platform-trainer:dev}"
[ -n "${SKIP_BUILD:-}" ] || docker build -f ../../training/Dockerfile -t "$IMAGE" ../..
kind load docker-image "$IMAGE" --name ai-platform --nodes ai-platform-worker3,ai-platform-worker4
echo "已載入 $IMAGE 到 gpu-exclusive、gpu-shared 節點"
