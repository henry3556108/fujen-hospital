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

rules() {  # rules <-I|-D>
  local n=$1 op=$2
  for chain in OUTPUT FORWARD; do
    docker exec "$n" iptables "$op" "$chain" -o eth0 ! -d "$V4" -m comment --comment "$TAG" -j REJECT
    [ -z "$V6" ] || docker exec "$n" ip6tables "$op" "$chain" -o eth0 ! -d "$V6" -m comment --comment "$TAG" -j REJECT
  done
}
case "${1:-}" in
  on)
    for n in $NODES; do rules "$n" -I; done
    echo "已在 $(echo $NODES | wc -w) 個節點擋掉對外連線（保留 $V4${V6:+、$V6}）"
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
    echo "節點 $n：拉取外部映像與外部 HTTPS 都失敗（離線）"
    ;;
  *) echo "用法：$0 on|off|check" >&2; exit 2 ;;
esac
