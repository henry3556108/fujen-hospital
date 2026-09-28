#!/usr/bin/env bash
# 移除 add-node.sh 加入的節點。用法：remove-node.sh <節點名稱>
set -euo pipefail
NAME="${1:?節點名稱}"
kubectl --context kind-ai-platform delete node "$NAME" --ignore-not-found --wait=true >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "已移除 $NAME"
