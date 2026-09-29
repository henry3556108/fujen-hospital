#!/usr/bin/env bash
# 把 compose 的 api 容器接上 kind 叢集：產生容器內可用的 kubeconfig，套用 compose.kind.yaml 重啟 api。可重複執行。
# 先執行 ./up.sh（叢集）與 compose up（堆疊）。解除：cd ../local && docker compose up -d api
set -euo pipefail
cd "$(dirname "$0")"
CLUSTER=ai-platform
LOCAL=../local

kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || { echo "kind 叢集 $CLUSTER 不存在，先執行 ./up.sh"; exit 1; }
kind get kubeconfig --name "$CLUSTER" --internal > "$LOCAL/kubeconfig.kind"
chmod 644 "$LOCAL/kubeconfig.kind"   # api 容器以非 root（uid 10001）執行

cd "$LOCAL"
docker compose -f compose.yaml -f compose.kind.yaml up -d --wait api
echo "== 確認 api 看得到叢集節點"
docker compose exec -T api /app/.venv/bin/python - <<'PY'
from app.scheduling.backend import backend_from_env
nodes = backend_from_env().nodes()
for n in nodes:
    print(f"  {n.name:<28} pool={n.pool or '-':<14} ready={n.ready} gpu={n.gpu_allocatable}/{n.gpu_capacity}")
assert nodes, "叢集沒有節點"
PY
echo "完成：工作 API 現在會把 Job 送進 kind 叢集的 platform-jobs 命名空間。"
