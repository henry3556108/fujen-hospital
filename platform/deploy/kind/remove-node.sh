#!/usr/bin/env bash
# 移除 add-node.sh 加入的節點。用法：remove-node.sh <節點名稱>
# -v：一併刪除節點容器的 /var 匿名 volume（節點上的映像都在裡面，訓練映像約 40 GB，不刪會一直佔著主機磁碟）
set -euo pipefail
NAME="${1:?節點名稱}"
kubectl --context kind-ai-platform delete node "$NAME" --ignore-not-found --wait=true >/dev/null
docker rm -f -v "$NAME" >/dev/null 2>&1 || true
echo "已移除 $NAME"
