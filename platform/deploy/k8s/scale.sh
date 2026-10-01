#!/usr/bin/env bash
# 平台工作負載全部縮到 0（保留命名空間、manifest、PVC、Secret），或恢復成 1 份。
#   ./scale.sh down     釋放記憶體；資料都在 PVC 與 PostgreSQL，不會遺失
#   ./scale.sh up       全部恢復 1 份並等待就緒
set -euo pipefail
NAMESPACE="${NAMESPACE:-ai-platform}"
case "${1:-}" in
  down)
    kubectl -n "$NAMESPACE" scale deployment,statefulset --all --replicas=0
    kubectl -n "$NAMESPACE" delete job --all --ignore-not-found >/dev/null
    ;;
  up)
    kubectl -n "$NAMESPACE" scale statefulset --all --replicas=1
    kubectl -n "$NAMESPACE" scale deployment --all --replicas=1
    for r in $(kubectl -n "$NAMESPACE" get statefulset,deployment -o name); do
      kubectl -n "$NAMESPACE" rollout status "$r" --timeout=15m
    done
    ;;
  *) echo "用法：$0 down|up" >&2; exit 2 ;;
esac
