#!/usr/bin/env bash
# 建立 Mac 開發用的 kind 叢集：多節點、假 GPU、Kueue 佇列、web-echo、監控堆疊。可重複執行。
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER=ai-platform
CONTEXT="kind-$CLUSTER"
KUEUE_VERSION="${KUEUE_VERSION:-v0.19.6}"
k() { kubectl --context "$CONTEXT" "$@"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "== 建立 kind 叢集 $CLUSTER"
  kind create cluster --config kind-config.yaml --wait 120s
else
  echo "== 叢集 $CLUSTER 已存在，略過建立"
fi

echo "== 假 GPU"
./fake-gpus.sh

echo "== Kueue $KUEUE_VERSION"
k apply --server-side --force-conflicts \
  -f "https://github.com/kubernetes-sigs/kueue/releases/download/$KUEUE_VERSION/manifests.yaml" >/dev/null
k -n kueue-system rollout status deploy/kueue-controller-manager --timeout=300s

echo "== Kueue 佇列（webhook 就緒前會重試）"
for i in $(seq 1 30); do
  if k apply -f kueue/queues.yaml >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && k apply -f kueue/queues.yaml
  sleep 5
done

echo "== web-echo（cpu-web 節點）"
k apply -f workloads/web-echo.yaml >/dev/null

echo "== 監控：Prometheus、Alertmanager、Grafana、kube-state-metrics、Mailpit"
k apply -f monitoring/ >/dev/null
for d in prometheus alertmanager grafana kube-state-metrics mailpit; do
  k -n monitoring rollout status "deploy/$d" --timeout=300s
done
k -n platform-web rollout status deploy/web-echo --timeout=180s

cat <<EOF

完成。
  Prometheus    http://127.0.0.1:39090
  Alertmanager  http://127.0.0.1:39093
  Grafana       http://127.0.0.1:33000（admin／見 monitoring/grafana.yaml 的開發用密碼）
  Mailpit       http://127.0.0.1:38025
EOF
