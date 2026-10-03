#!/usr/bin/env bash
# 建置平台映像、取得上游映像，載入 kind 叢集的節點（叢集不必連網就能啟動平台）。可重複執行。
#   ./build-and-load.sh                    建置＋拉取＋載入
#   SKIP_BUILD=1 ./build-and-load.sh       不重建平台映像（用本機已有的）
#   SKIP_PULL=1  ./build-and-load.sh       不拉上游映像（離線；本機要已有）
# 映像清單只來自 components/images/kustomization.yaml（images.py）。
#   平台節點（cpu-web）：所有上游映像、platform-api、platform-fakes、platform-trainer（推論服務）
#   工作節點（cpu-data、GPU 池）：Job 映像 platform-trainer、busybox（../kind/load-trainer-image.sh 也會載入 trainer）
set -euo pipefail
cd "$(dirname "$0")"
PLATFORM_DIR="$(cd ../.. && pwd)"
CLUSTER="${KIND_CLUSTER:-ai-platform}"
PLATFORM_NODES="${PLATFORM_NODES:-ai-platform-worker}"
JOB_NODES="${JOB_NODES:-ai-platform-worker2,ai-platform-worker3,ai-platform-worker4}"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

ref_for() { python3 images.py built | grep "^$1:" ; }
if [ -z "${SKIP_BUILD:-}" ]; then
  log "建置 $(ref_for platform-api)"
  docker build -q -f "$PLATFORM_DIR/api/Dockerfile" -t "$(ref_for platform-api)" "$PLATFORM_DIR" >/dev/null
  log "建置 $(ref_for platform-fakes)（假服務，只給 kind）"
  docker build -q -t "$(ref_for platform-fakes)" "$PLATFORM_DIR/fakes" >/dev/null
  log "建置 $(ref_for platform-web)（網頁前端）"
  docker build -q -t "$(ref_for platform-web)" "$PLATFORM_DIR/web" >/dev/null
  log "建置 $(ref_for platform-trainer)（約 6 GB）"
  docker build -q -f "$PLATFORM_DIR/training/Dockerfile" -t "$(ref_for platform-trainer)" "$PLATFORM_DIR" >/dev/null
fi

# 不用 kind load：Docker 以 containerd 存映像時，kind load 的 --all-platforms 匯入會因缺少其他平台的內容而失敗。
# 改成 docker save --platform 後直接以節點的 ctr 匯入；節點上已是同一個 manifest 就略過。
# 以 digest 釘住的映像（MinIO）另外在節點上補上 name@sha256 的名稱，讓 Pod 的 image 在節點上找得到，不必連網。
PLATFORM="${PLATFORM:-linux/amd64}"
full_name() {  # containerd 的完整名稱：docker.io/library/…
  local ref=$1 first=${1%%/*}
  if [[ "$ref" != */* ]]; then echo "docker.io/library/$ref"
  elif [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then echo "$ref"
  else echo "docker.io/$ref"; fi
}
load() {  # load <ref> <nodes>
  local ref=$1 nodes=$2 save_ref=$1 name want_a want_b n have
  if [[ "$ref" == *@sha256:* ]]; then
    save_ref="${ref%@*}:pinned"
    docker tag "$ref" "$save_ref"
  fi
  name=$(full_name "$save_ref")
  want_a=$(docker image inspect --platform "$PLATFORM" -f '{{.Id}}' "$save_ref")
  want_b=$(docker image inspect -f '{{.Id}}' "$save_ref")
  for n in ${nodes//,/ }; do
    have=$(docker exec "$n" ctr -n k8s.io images ls "name==$name" 2>/dev/null | awk 'NR>1{print $3}')
    if [ -n "$have" ] && { [ "$have" = "$want_a" ] || [ "$have" = "$want_b" ]; }; then
      echo "    $n：已是最新"
    else
      docker save --platform "$PLATFORM" "$save_ref" \
        | docker exec -i "$n" ctr -n k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
      echo "    $n：已載入"
    fi
    if [[ "$ref" == *@sha256:* ]]; then
      docker exec "$n" ctr -n k8s.io images tag --force "$name" "$(full_name "$ref")" >/dev/null
    fi
    drop_import_refs "$n"
  done
}

# `ctr images import --digests` 每次載入都另外留下一個 import-<日期>@sha256:… 參照；舊版映像因此一直被留著，
# 節點磁碟會越用越多（2026-10-04 曾把主機磁碟用滿）。平台用到的映像都有正式名稱，所以載入後刪掉所有 import- 參照。
drop_import_refs() {
  docker exec "$1" sh -c 'ctr -n k8s.io images ls -q | grep "^import-" | while read r; do ctr -n k8s.io images rm "$r" >/dev/null 2>&1; done' || true
}

for ref in $(python3 images.py upstream); do
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    [ -z "${SKIP_PULL:-}" ] || { echo "本機沒有 $ref，且設定了 SKIP_PULL" >&2; exit 1; }
    log "拉取 $ref"
    docker pull -q "$ref" >/dev/null
  fi
  log "載入 $ref → $PLATFORM_NODES"
  load "$ref" "$PLATFORM_NODES"
done
for ref in $(python3 images.py built); do
  log "載入 $ref → $PLATFORM_NODES"
  load "$ref" "$PLATFORM_NODES"
done
for ref in $(python3 images.py jobs | sort -u); do
  docker image inspect "$ref" >/dev/null 2>&1 || { [ -z "${SKIP_PULL:-}" ] && docker pull -q "$ref" >/dev/null; }
  log "載入 $ref → $JOB_NODES"
  load "$ref" "$JOB_NODES"
done
log "完成"
