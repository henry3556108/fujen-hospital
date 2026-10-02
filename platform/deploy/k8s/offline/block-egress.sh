#!/usr/bin/env bash
# 離線演練用：只在 kind 節點容器內暫時擋掉往叢集外（kind Docker 網路以外）的連線。不動主機的防火牆。
#   ./block-egress.sh on      每個節點加 iptables／ip6tables 規則（註解 ai-platform-offline-drill）
#   ./block-egress.sh off     移除這些規則（可重複執行；呼叫端要以 trap 確保一定會執行）
#   ./block-egress.sh check   確認節點連不到外部（拉映像、HTTPS 都失敗）
# 擋的是節點自己的對外連線（OUTPUT：containerd 拉映像）與 Pod 的對外連線（FORWARD）；叢集內部與 kind 網路不受影響。
set -euo pipefail
CLUSTER="${KIND_CLUSTER:-ai-platform}"
TAG=ai-platform-offline-drill
NODES=$(kind get nodes --name "$CLUSTER")
V4=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -v : | head -1)
V6=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep : | head -1 || true)

# 叢集內部的流量也走 eth0：節點之間的 Pod 網段（kindnet 直接路由）與 Service 網段（kube-proxy DNAT 前後），都要放行，
# 否則 API server 呼叫 webhook（例如 Kueue）、跨節點的 Pod 連線都會被擋（第一次演練就因此失敗）
POD_CIDR="${POD_CIDR:-$(kubectl get nodes -o jsonpath='{.items[0].spec.podCIDR}' | sed 's#\.[0-9]*\.0/24$#.0.0/16#')}"
SVC_CIDR="${SVC_CIDR:-$(kubectl -n kube-system get pod -l component=kube-apiserver -o yaml | grep -o 'service-cluster-ip-range=[^ "]*' | head -1 | cut -d= -f2)}"
rules() {  # rules <節點>：先加 REJECT，再把放行規則插在它前面
  local n=$1 dst
  for chain in OUTPUT FORWARD; do
    docker exec "$n" iptables -I "$chain" -o eth0 -m comment --comment "$TAG" -j REJECT
    for dst in "$V4" "$POD_CIDR" "$SVC_CIDR"; do
      docker exec "$n" iptables -I "$chain" -o eth0 -d "$dst" -m comment --comment "$TAG" -j ACCEPT
    done
    if [ -n "$V6" ]; then
      docker exec "$n" ip6tables -I "$chain" -o eth0 -m comment --comment "$TAG" -j REJECT
      docker exec "$n" ip6tables -I "$chain" -o eth0 -d "$V6" -m comment --comment "$TAG" -j ACCEPT
    fi
  done
}
case "${1:-}" in
  on)
    [ -n "$POD_CIDR" ] && [ -n "$SVC_CIDR" ] || { echo "找不到 Pod 或 Service 網段" >&2; exit 1; }
    "$0" off >/dev/null
    for n in $NODES; do rules "$n"; done
    echo "已在 $(echo $NODES | wc -w) 個節點擋掉對外連線（放行 kind 網路 $V4、Pod $POD_CIDR、Service $SVC_CIDR${V6:+、$V6}）"
    ;;
  off)
    for n in $NODES; do
      for tool in iptables ip6tables; do
        for chain in OUTPUT FORWARD; do
          while docker exec "$n" $tool -S "$chain" 2>/dev/null | grep -q "$TAG"; do
            spec=$(docker exec "$n" $tool -S "$chain" | grep "$TAG" | head -1 | sed "s/^-A /-D /")
            eval docker exec "$n" $tool $spec
          done
        done
      done
    done
    echo "已移除所有節點的離線演練規則"
    ;;
  check)
    n=$(echo "$NODES" | grep -- '-worker$' | head -1)
    if docker exec "$n" timeout 20 crictl pull docker.io/library/hello-world:latest >/dev/null 2>&1; then
      echo "節點 $n 仍能拉取外部映像" >&2; exit 1; fi
    if docker exec "$n" timeout 10 curl -sS -m 8 -o /dev/null https://database.clamav.net 2>/dev/null; then
      echo "節點 $n 仍能連外部 HTTPS" >&2; exit 1; fi
    # 對照組：叢集內部仍然正常（API server 經 Service 呼叫 webhook、跨節點的 Pod）
    kubectl get --raw /readyz >/dev/null
    echo "節點 $n：拉取外部映像與外部 HTTPS 都失敗（離線）；叢集內部正常"
    ;;
  *) echo "用法：$0 on|off|check" >&2; exit 2 ;;
esac
