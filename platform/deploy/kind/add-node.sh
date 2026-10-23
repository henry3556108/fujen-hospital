#!/usr/bin/env bash
# 在既有 kind 叢集加入一個 worker 並加上池標籤（TC-C01-07）。kind 本身不支援擴充既有叢集，
# 這裡用與 kind worker 相同的容器參數啟動節點映像，再以 kubeadm join 加入。
# 用法：add-node.sh <節點名稱> <池：cpu-web|cpu-data|gpu-exclusive|gpu-shared> [實體 GPU 數]
#   REAL_GPU=1 add-node.sh ai-platform-worker4 gpu-shared 1
#     接上主機的真 GPU（WSL2）：節點容器掛 /dev/dxg 與 /usr/lib/wsl，再由 gpu-node.sh 裝 NVIDIA Container Toolkit
#     與 device plugin；GPU 份數由 device plugin 回報，不用假 GPU 的 status patch。
set -euo pipefail
NAME="${1:?節點名稱}"
POOL="${2:?池名稱}"
GPUS="${3:-1}"
CLUSTER=ai-platform
CONTEXT="kind-$CLUSTER"
k() { kubectl --context "$CONTEXT" "$@"; }

GPU_MOUNTS=()
if [ -n "${REAL_GPU:-}" ]; then
  case "$POOL" in gpu-*) ;; *) echo "REAL_GPU 只能用在 GPU 池" >&2; exit 2 ;; esac
  [ -e /dev/dxg ] && [ -d /usr/lib/wsl/lib ] || { echo "主機沒有 /dev/dxg 或 /usr/lib/wsl/lib（只支援 WSL2 的 GPU）" >&2; exit 2; }
  GPU_MOUNTS=(--volume /dev/dxg:/dev/dxg --volume /usr/lib/wsl:/usr/lib/wsl:ro)
fi

IMAGE=$(docker inspect "$CLUSTER-control-plane" --format '{{.Config.Image}}')
echo "== 啟動節點容器 ${NAME}（${IMAGE}${REAL_GPU:+，真 GPU}）"
docker run -d --name "$NAME" --hostname "$NAME" --network kind --privileged \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt label=disable \
  --tmpfs /run --tmpfs /tmp --volume /var --volume /lib/modules:/lib/modules:ro "${GPU_MOUNTS[@]}" \
  --cgroupns=private --restart=on-failure:1 \
  -e KIND_EXPERIMENTAL_CONTAINERD_SNAPSHOTTER -e container=docker \
  --label "io.x-k8s.kind.cluster=$CLUSTER" --label io.x-k8s.kind.role=worker \
  "$IMAGE" >/dev/null

for i in $(seq 1 60); do
  if docker exec "$NAME" systemctl is-active containerd >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "== kubeadm join"
JOIN=$(docker exec "$CLUSTER-control-plane" kubeadm token create --print-join-command)
# shellcheck disable=SC2086
docker exec "$NAME" $JOIN --ignore-preflight-errors=all >/dev/null

echo "== 加標籤 platform/pool=$POOL"
for i in $(seq 1 60); do
  if k get node "$NAME" >/dev/null 2>&1; then break; fi
  sleep 2
done
k label node "$NAME" "platform/pool=$POOL" --overwrite >/dev/null
case "$POOL" in
  gpu-*)
    k label node "$NAME" "platform/gpu-physical=$GPUS" --overwrite >/dev/null
    # 真 GPU 節點先加 platform/gpu-source，fake-gpus.sh 才會略過它（只加 taint，不改份數）
    [ -z "${REAL_GPU:-}" ] || k label node "$NAME" platform/gpu-source=device-plugin --overwrite >/dev/null
    "$(dirname "$0")/fake-gpus.sh"
    ;;
esac
k wait --for=condition=Ready "node/$NAME" --timeout=240s
if [ -n "${REAL_GPU:-}" ]; then
  echo "== 真 GPU：NVIDIA Container Toolkit 與 device plugin"
  "$(dirname "$0")/gpu-node.sh" "$NAME"
fi
