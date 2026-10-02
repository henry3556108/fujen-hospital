#!/usr/bin/env bash
# 部署平台到 Kubernetes（命名空間 ai-platform）。可重複執行：已存在的資源就地更新，一次性工作重跑（都可重複執行）。
# 以 Helm release「ai-platform」部署（每次部署一個版本，可 helm rollback）；manifest 全部來自 Kustomize overlay。
#   ./deploy.sh kind          本機 kind 叢集：開發密碼、假服務、模擬 PACS；最後跑測試基線（seed）並啟動主機連接埠轉送
#   ./deploy.sh production    甲方：先改好 overlays/production 的佔位、建好 Secret（./create-secrets.sh）與 TLS 憑證
# 環境變數：SKIP_SEED=1（kind 不重設測試基線）、TIMEOUT（等待每個服務的上限，預設 900s）、
#           OFFLINE=1（離線安裝：clamav 不跑 freshclam，病毒碼由 offline/install.sh 預載）
# 映像要先在叢集裡：kind 用 ./build-and-load.sh；甲方推到內部 registry（README「正式環境」）。
set -euo pipefail
cd "$(dirname "$0")"
OVERLAY="${1:-}"
NS=ai-platform
TIMEOUT="${TIMEOUT:-900s}"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
[ "$OVERLAY" = kind ] || [ "$OVERLAY" = production ] || { echo "用法：$0 kind|production" >&2; exit 2; }
if [ "$OVERLAY" = kind ] && [ "$(kubectl config current-context)" != "kind-ai-platform" ] && [ -z "${ALLOW_CONTEXT:-}" ]; then
  echo "kubectl 目前的 context 不是 kind-ai-platform（設 ALLOW_CONTEXT=1 略過檢查）" >&2; exit 2
fi

python3 render-config.py --check
if [ "$OVERLAY" = kind ]; then
  ./create-secrets.sh --dev
else
  kubectl -n "$NS" get secret platform-secrets >/dev/null 2>&1 \
    || { echo "缺少 Secret platform-secrets：先執行 ./create-secrets.sh" >&2; exit 2; }
  if kubectl kustomize overlays/production | grep -q 'CHANGE-ME\|example\.invalid'; then
    echo "overlays/production 仍有 CHANGE-ME 或 example.invalid 佔位，請先替換（README「正式環境」）" >&2
    [ -n "${ALLOW_PLACEHOLDERS:-}" ] || exit 2
  fi
fi

# Helm 只做版本紀錄與 rollback：chart 沒有樣板，manifest 由 post-renderer 外掛以 kubectl kustomize 產生（helm/README）
HELM_VERSION_REQUIRED="${HELM_VERSION_REQUIRED:-v4.3.0}"
have=$(helm version --template '{{.Version}}' 2>/dev/null || true)
[ "$have" = "$HELM_VERSION_REQUIRED" ] || [ -n "${ALLOW_HELM_VERSION:-}" ] \
  || { echo "需要 Helm $HELM_VERSION_REQUIRED（目前：${have:-未安裝}）；安裝方式見 README「Helm」" >&2; exit 2; }
helm plugin list 2>/dev/null | grep -q '^kustomize-overlay' || helm plugin install helm/kustomize-postrenderer >/dev/null
# OVERLAY_DIR：另一個以此 overlay 為基礎的 Kustomize 目錄（例如 rollback 演練）；它引用 overlay 時要用相對路徑
OVERLAY_DIR="${OVERLAY_DIR:-$PWD/overlays/$OVERLAY}"
kubectl kustomize "$OVERLAY_DIR" >/dev/null   # 先在這裡失敗並顯示原因（post-renderer 失敗時 Helm 不顯示 kustomize 的錯誤）

kubectl apply -f base/namespace.yaml >/dev/null
log "Helm 部署 overlays/$OVERLAY（release ai-platform）"
# --take-ownership：第一次改用 Helm 時接手先前以 kubectl apply -k 建立的資源
helm upgrade --install ai-platform helm/chart -n "$NS" --history-max 10 --take-ownership \
  --post-renderer kustomize-overlay --post-renderer-args "$OVERLAY_DIR" >/dev/null
helm history ai-platform -n "$NS" --max 1 | tail -1
if [ -n "${OFFLINE:-}" ]; then   # 離線安裝（offline/install.sh）：病毒碼已預載，容器內不跑 freshclam
  kubectl -n "$NS" set env statefulset/clamav CLAMAV_NO_FRESHCLAMD=true >/dev/null
fi

wait_ready() {  # wait_ready <kind/name>...
  for r in "$@"; do
    log "等待 $r 就緒"
    kubectl -n "$NS" rollout status "$r" --timeout="$TIMEOUT"
  done
}
run_job() {  # run_job <範本名稱>：由暫停的 CronJob 建立 Job 並等它完成
  local tpl=$1 name
  name="$tpl-$(date +%Y%m%d%H%M%S)"
  log "執行一次性工作 $name"
  kubectl -n "$NS" create job "$name" --from="cronjob/$tpl" >/dev/null
  if ! kubectl -n "$NS" wait --for=condition=complete "job/$name" --timeout="$TIMEOUT" >/dev/null; then
    kubectl -n "$NS" logs "job/$name" --tail=40 >&2 || true
    echo "一次性工作 $name 失敗" >&2
    return 1
  fi
  kubectl -n "$NS" logs "job/$name" --tail=5 | sed 's/^/    /'
}

wait_ready statefulset/postgres
run_job db-init
wait_ready statefulset/minio
run_job minio-init
wait_ready deployment/keycloak statefulset/orthanc deployment/hapi statefulset/clamav statefulset/mlflow \
  deployment/inference deployment/wiki
wait_ready deployment/api deployment/fhir-worker deployment/apisix deployment/ohif
if [ "$OVERLAY" = kind ]; then
  wait_ready deployment/fake-llm deployment/autolabel deployment/mailpit statefulset/orthanc-pacs
  if [ -z "${SKIP_SEED:-}" ]; then run_job seed; else run_job bootstrap-admin; fi
else
  run_job bootstrap-admin
fi
run_job wiki-setup
if [ "$OVERLAY" = kind ]; then
  kind/expose.sh
  log "Gateway http://localhost:38980  OHIF http://localhost:38981  Keycloak http://localhost:38180  PACS http://127.0.0.1:38943  Mailpit http://127.0.0.1:38925"
fi
log "完成"
