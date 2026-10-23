#!/usr/bin/env bash
# 讓一個 kind 節點使用主機的真 NVIDIA GPU（WSL2 + Docker Engine + NVIDIA Container Toolkit）。可重複執行。
#   ./gpu-node.sh ai-platform-worker4
# 節點容器要以 REAL_GPU=1 ./add-node.sh 建立（掛 /dev/dxg 與 /usr/lib/wsl）。不動主機的 Docker daemon 設定。
#   1. 節點內安裝 NVIDIA Container Toolkit（主機 apt-get download 的 .deb），containerd 預設 runtime 改為 nvidia
#   2. 匯入 device plugin 映像、節點加標籤 platform/gpu-source=device-plugin
#   3. 建立時間片設定（gpu/time-slicing.yaml，只在不存在時）、部署 device plugin（gpu/nvidia-device-plugin.yaml）
#   4. 等節點回報 nvidia.com/gpu = 實體張數 × 份數
set -euo pipefail
cd "$(dirname "$0")"
NODE="${1:?節點名稱}"
CONTEXT="${KUBE_CONTEXT:-kind-ai-platform}"
PLUGIN_IMAGE="${PLUGIN_IMAGE:-nvcr.io/nvidia/k8s-device-plugin:v0.18.1}"
DEB_DIR="${DEB_DIR:-$HOME/.cache/kind-gpu-debs}"
PACKAGES="nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container1 libnvidia-container-tools"
k() { kubectl --context "$CONTEXT" "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

docker exec "$NODE" test -e /dev/dxg && docker exec "$NODE" test -d /usr/lib/wsl/lib \
  || { echo "$NODE 沒有掛載 /dev/dxg 與 /usr/lib/wsl：請以 REAL_GPU=1 ./add-node.sh 重建節點" >&2; exit 2; }

if ! docker exec "$NODE" sh -c 'command -v nvidia-ctk' >/dev/null 2>&1; then
  log "$NODE：安裝 NVIDIA Container Toolkit（版本同主機）"
  mkdir -p "$DEB_DIR"
  ls "$DEB_DIR"/*.deb >/dev/null 2>&1 || (cd "$DEB_DIR" && apt-get download $PACKAGES >/dev/null)
  docker exec "$NODE" mkdir -p /opt/debs   # 不放 /tmp：節點的 /tmp 是 tmpfs
  for f in "$DEB_DIR"/*.deb; do
    docker exec -i "$NODE" sh -c "cat > /opt/debs/$(basename "$f")" < "$f"
  done
  docker exec "$NODE" sh -c 'dpkg -i /opt/debs/*.deb >/dev/null'
fi
# WSL 的驅動程式庫（libcuda、libnvidia-ml）在 /usr/lib/wsl/lib
docker exec "$NODE" sh -c 'echo /usr/lib/wsl/lib > /etc/ld.so.conf.d/ld.wsl.conf && ldconfig'
if ! docker exec "$NODE" grep -qs 'default_runtime_name = "nvidia"' /etc/containerd/conf.d/99-nvidia.toml; then
  log "$NODE：containerd 預設 runtime 改為 nvidia"
  docker exec "$NODE" nvidia-ctk runtime configure --runtime=containerd --set-as-default >/dev/null
  docker exec "$NODE" systemctl restart containerd
  for i in $(seq 1 60); do docker exec "$NODE" systemctl is-active containerd >/dev/null 2>&1 && break; sleep 1; done
fi

# 節點只有 IPv4，從節點拉 nvcr.io 很慢：主機拉好再匯入（同 k8s/build-and-load.sh 的作法）
docker image inspect "$PLUGIN_IMAGE" >/dev/null 2>&1 || docker pull -q "$PLUGIN_IMAGE" >/dev/null
if ! docker exec "$NODE" ctr -n k8s.io images ls -q "name==$PLUGIN_IMAGE" | grep -q .; then
  log "$NODE：匯入 $PLUGIN_IMAGE"
  docker save --platform linux/amd64 "$PLUGIN_IMAGE" \
    | docker exec -i "$NODE" ctr -n k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
  docker exec "$NODE" sh -c 'ctr -n k8s.io images ls -q | grep "^import-" | while read r; do ctr -n k8s.io images rm "$r" >/dev/null 2>&1; done' || true
fi

k label node "$NODE" platform/gpu-source=device-plugin --overwrite >/dev/null
k taint node "$NODE" nvidia.com/gpu=present:NoSchedule --overwrite >/dev/null
k get configmap -n kube-system nvdp-config >/dev/null 2>&1 || k apply -f gpu/time-slicing.yaml >/dev/null
k apply -f gpu/nvidia-device-plugin.yaml >/dev/null
k -n kube-system rollout status ds/nvidia-device-plugin-daemonset --timeout=180s >/dev/null

physical=$(k get node "$NODE" -o jsonpath='{.metadata.labels.platform/gpu-physical}')
replicas=$(k get configmap -n kube-system nvdp-config -o jsonpath='{.data.config\.yaml}' | grep -o '"\?replicas"\?: *[0-9]*' | grep -o '[0-9]*$')
want=$(( ${physical:-1} * ${replicas:-1} ))
for i in $(seq 1 60); do
  got=$(k get node "$NODE" -o jsonpath='{.status.allocatable.nvidia\.com/gpu}')
  [ "$got" = "$want" ] && break
  sleep 2
done
[ "$got" = "$want" ] || { echo "$NODE 的 nvidia.com/gpu 是「${got:-無}」，預期 $want（看 device plugin 的 log）" >&2; exit 1; }
log "$NODE：真 GPU，nvidia.com/gpu=$got（實體 ${physical:-1} 張 × 時間片 ${replicas} 份）"
