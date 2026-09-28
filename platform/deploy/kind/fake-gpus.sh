#!/usr/bin/env bash
# 假 GPU：依節點標籤 platform/gpu-physical 與時間片份數，在 node status 宣告 nvidia.com/gpu，並加上 GPU 節點的 taint。
# 獨占池：份數 = 實體張數；共享池：份數 = 實體張數 × TIME_SLICE_REPLICAS（等同 NVIDIA time-slicing 的 replicas）。
set -euo pipefail
CONTEXT="${KUBE_CONTEXT:-kind-ai-platform}"
TIME_SLICE_REPLICAS="${TIME_SLICE_REPLICAS:-4}"
k() { kubectl --context "$CONTEXT" "$@"; }

for pool in gpu-exclusive gpu-shared; do
  for node in $(k get nodes -l "platform/pool=$pool" -o jsonpath='{.items[*].metadata.name}'); do
    physical=$(k get node "$node" -o jsonpath='{.metadata.labels.platform/gpu-physical}')
    physical="${physical:-1}"
    count="$physical"
    [ "$pool" = gpu-shared ] && count=$((physical * TIME_SLICE_REPLICAS))
    k patch node "$node" --subresource=status --type=json \
      -p "[{\"op\":\"add\",\"path\":\"/status/capacity/nvidia.com~1gpu\",\"value\":\"$count\"}]" >/dev/null
    # 只有會用 GPU 的工作（帶 toleration）可以排上 GPU 節點；監控等服務不會佔用
    k taint node "$node" nvidia.com/gpu=present:NoSchedule --overwrite >/dev/null
    echo "  $node（$pool）：nvidia.com/gpu=$count（實體 $physical 張）"
  done
done
