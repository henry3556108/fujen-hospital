#!/usr/bin/env bash
# 由離線安裝包部署（不需要網路）。
#   ./install.sh <安裝包目錄> kind          匯入 kind 節點後部署 overlays/kind（開發機演練）
#   ./install.sh <安裝包目錄> load-only     只把映像匯入 kind 節點
# 甲方叢集：把 images/*.tar 以 docker load（或 ctr import）放進內部 registry 或每個節點，再照部署說明執行 deploy.sh production；
# 病毒碼以本腳本的 seed_clamav 同樣方式放進 clamav 的 PVC，並把 clamav-env 的 CLAMAV_NO_FRESHCLAMD 設為 true（或指向內部鏡像站）。
set -euo pipefail
BUNDLE="$(cd "${1:?用法：$0 <安裝包目錄> kind|load-only}" && pwd)"
MODE="${2:-kind}"
HERE="$(cd "$(dirname "$0")" && pwd)"
K8S="$(cd "$HERE/.." && pwd)"
NS=ai-platform
PLATFORM_NODES="${PLATFORM_NODES:-ai-platform-worker}"
JOB_NODES="${JOB_NODES:-ai-platform-worker2,ai-platform-worker3,ai-platform-worker4}"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "比對雜湊"
(cd "$BUNDLE" && sha256sum -c --quiet SHA256SUMS)

full_name() {
  local ref=$1 first=${1%%/*}
  if [[ "$ref" != */* ]]; then echo "docker.io/library/$ref"
  elif [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then echo "$ref"
  else echo "docker.io/$ref"; fi
}
jobs_images=$(python3 "$K8S/images.py" jobs)
while read -r ref; do
  [ -n "$ref" ] || continue
  file="$BUNDLE/images/$(echo "$ref" | tr '/:@' '___').tar"
  nodes=$PLATFORM_NODES
  echo "$jobs_images" | grep -qx "$ref" && nodes="$PLATFORM_NODES,$JOB_NODES"
  log "匯入 $ref → $nodes"
  for n in ${nodes//,/ }; do
    docker exec -i "$n" ctr -n k8s.io images import --digests --snapshotter=overlayfs - < "$file" >/dev/null
    if [[ "$ref" == *@sha256:* ]]; then
      docker exec "$n" ctr -n k8s.io images tag --force "$(full_name "${ref%@*}:pinned")" "$(full_name "$ref")" >/dev/null
    fi
  done
done < "$BUNDLE/images.txt"
[ "$MODE" = load-only ] && { log "完成（只匯入映像）"; exit 0; }

# 病毒碼：先把 clamav 縮到 0，用一個臨時 Pod 把安裝包的病毒碼寫進它的 PVC，再關掉 freshclam 啟動
seed_clamav() {
  kubectl -n "$NS" scale statefulset/clamav --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NS" wait --for=delete pod/clamav-0 --timeout=120s >/dev/null 2>&1 || true
  kubectl -n "$NS" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: db-clamav-0, namespace: $NS, labels: {app: clamav}}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 2Gi}}}
YAML
  kubectl -n "$NS" run clamav-db-seed --restart=Never --image=busybox:1.36 --image-pull-policy=Never \
    --overrides='{"spec":{"nodeSelector":{"platform/pool":"cpu-web"},"containers":[{"name":"seed","image":"busybox:1.36","imagePullPolicy":"Never","command":["sleep","600"],"volumeMounts":[{"name":"db","mountPath":"/db"}]}],"volumes":[{"name":"db","persistentVolumeClaim":{"claimName":"db-clamav-0"}}]}}' >/dev/null
  kubectl -n "$NS" wait --for=condition=Ready pod/clamav-db-seed --timeout=180s >/dev/null
  kubectl -n "$NS" exec -i clamav-db-seed -- tar xf - -C /db < "$BUNDLE/clamav-db.tar"
  kubectl -n "$NS" exec clamav-db-seed -- sh -c 'chmod -R a+rwX /db; ls /db'
  kubectl -n "$NS" delete pod clamav-db-seed --wait=true >/dev/null
}

log "部署 overlays/kind（離線：不建置、不拉取）"
kubectl create namespace "$NS" 2>/dev/null || true
seed_clamav
# OFFLINE=1：deploy.sh 讓 clamav 不跑 freshclam（連不到更新站）；病毒碼更新改由新的安裝包或內部鏡像站
SKIP_PULL=1 OFFLINE=1 "$K8S/deploy.sh" kind
log "完成"
