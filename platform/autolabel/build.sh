#!/usr/bin/env bash
# 建置自動標註工具的兩個映像（名稱與標籤來自 deploy/k8s/components/images，與 manifest 一致）：
#   platform-autolabel   轉接服務
#   platform-monailabel  MONAI Label＋預訓練權重（第一次要下載 PyTorch 基底與權重）
#   ./build.sh
#   WEIGHTS_BASE_URL=http://<內部鏡像>/monailabel ./build.sh     權重改從內部鏡像站下載（SHA-256 照樣檢查）
#   PIP_WHEELS=http://<內部鏡像>/wheels/ ./build.sh               Python 套件改從內部 wheel 目錄安裝（--no-index）
#   BUILD_NETWORK=host ./build.sh                                  建置時用主機網路（WSL2 mirrored 網路下 Docker bridge 對外很慢時）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
K8S="$HERE/../deploy/k8s"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
ref_for() { python3 "$K8S/images.py" autolabel | grep "^$1:"; }

log "建置 $(ref_for platform-autolabel)"
docker build -q -t "$(ref_for platform-autolabel)" "$HERE/adapter" >/dev/null
log "建置 $(ref_for platform-monailabel)"
docker build -q -f "$HERE/Dockerfile.monailabel" -t "$(ref_for platform-monailabel)" \
  ${BUILD_NETWORK:+--network "$BUILD_NETWORK"} \
  ${WEIGHTS_BASE_URL:+--build-arg WEIGHTS_BASE_URL="$WEIGHTS_BASE_URL"} \
  ${PIP_WHEELS:+--build-arg PIP_WHEELS="$PIP_WHEELS"} "$HERE" >/dev/null
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E '^platform-(autolabel|monailabel):'
