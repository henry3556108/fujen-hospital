#!/usr/bin/env bash
# 刪除 kind 叢集（含 add-node.sh 加入的節點容器）。
set -euo pipefail
CLUSTER=ai-platform
for c in $(docker ps -a --filter "label=io.x-k8s.kind.cluster=$CLUSTER" --format '{{.Names}}'); do
  case "$c" in "$CLUSTER"-extra-*) docker rm -f "$c" >/dev/null ;; esac
done
kind delete cluster --name "$CLUSTER"
