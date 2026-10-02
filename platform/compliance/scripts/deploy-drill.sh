#!/usr/bin/env bash
# 部署演練（TC-D02-01）：照 docs/delivery/部署說明.md 的步驟，從空環境（沒有容器、沒有 volume）部署一次並驗證。
# 每一步印一行 PASS／FAIL；任何一步失敗就停止並回報「無法完成的步驟」。
#   COMPOSE_PROJECT=ai-wp8 KEYCLOAK_HOST_PORT=18380 GATEWAY_HOST_PORT=19380 PACS_HTTP_PORT=18343 scripts/deploy-drill.sh
#
# Kubernetes 路徑（docs/delivery/部署說明.md 第二部分；本機 kind 叢集 ai-platform）：
#   DRILL_TARGET=k8s CONFIRM_DESTROY=ai-platform scripts/deploy-drill.sh
#   SKIP_BUILD=1 沿用本機已建的平台映像（仍會匯入節點）
# 離線路徑：從離線安裝包安裝，安裝期間 kind 節點容器擋掉對外連線（deploy/k8s/offline/block-egress.sh；結束時一定移除）：
#   DRILL_TARGET=k8s-offline OFFLINE_BUNDLE=/root/offline-bundle CONFIRM_DESTROY=ai-platform scripts/deploy-drill.sh
#   KEEP_BLOCKED=1 演練結束後不移除規則（呼叫端自己負責移除，例如接著在離線狀態跑驗收）
source "$(dirname "$0")/common.sh"
DRILL_TARGET="${DRILL_TARGET:-compose}"
K8S_DIR="$PLATFORM_DIR/deploy/k8s"
K8S_NAMESPACE=ai-platform
if [ "$DRILL_TARGET" = k8s ] || [ "$DRILL_TARGET" = k8s-offline ]; then
  [ "${CONFIRM_DESTROY:-}" = "$K8S_NAMESPACE" ] || { echo "會先刪除命名空間 $K8S_NAMESPACE 與它的全部資料（PVC）；確認請設 CONFIRM_DESTROY=$K8S_NAMESPACE" >&2; exit 2; }
  GATEWAY="http://localhost:38980"
  KEYCLOAK="http://localhost:38180"
else
  [ "${CONFIRM_DESTROY:-}" = "$COMPOSE_PROJECT" ] || { echo "會先刪除 $COMPOSE_PROJECT 的全部資料；確認請設 CONFIRM_DESTROY=$COMPOSE_PROJECT" >&2; exit 2; }
  GATEWAY="http://localhost:${GATEWAY_HOST_PORT:-9080}"
  KEYCLOAK="http://localhost:${KEYCLOAK_HOST_PORT:-8080}"
fi
STEPS=0

step() {  # step <說明> <指令...>
  local name=$1; shift
  STEPS=$((STEPS + 1))
  local out
  if out=$("$@" 2>&1); then
    echo "PASS  步驟 $STEPS    $name"
  else
    echo "$out" | tail -8 >&2
    echo "FAIL  TC-D02-01     無法完成的步驟：$STEPS $name"
    exit 1
  fi
}

check_tools() { for t in docker git uv; do command -v "$t" >/dev/null || { echo "缺少 $t"; return 1; }; done; docker info >/dev/null; }
empty_env() { dc down -v --remove-orphans >/dev/null 2>&1 || true; [ -z "$(docker volume ls -q --filter label=com.docker.compose.project=$COMPOSE_PROJECT)" ]; }
wait_keycloak() { for i in $(seq 1 90); do curl -sf -o /dev/null "$KEYCLOAK/realms/ai-platform" && return 0; sleep 2; done; return 1; }
login_admin() {
  curl -sf "$KEYCLOAK/realms/ai-platform/protocol/openid-connect/token" -d grant_type=password -d client_id=ai-platform-web \
    -d username=admin01 --data-urlencode "password=Admin01-dev!" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' > "$TOKEN_FILE"
}
call_gateway() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$GATEWAY/api/admin/projects")
  [ "$code" = 200 ]
}
unauthenticated_blocked() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/api/admin/projects")" = 401 ]; }
TOKEN_FILE=$(mktemp)

k8s_tools() {
  for t in docker kubectl kind python3 uv; do command -v "$t" >/dev/null || { echo "缺少 $t"; return 1; }; done
  [ "$(kubectl config current-context)" = kind-ai-platform ] && kubectl get nodes >/dev/null
}
k8s_empty() {
  kubectl delete namespace "$K8S_NAMESPACE" --ignore-not-found --wait=true --timeout=600s >/dev/null
  kubectl delete clusterrole,clusterrolebinding -l app.kubernetes.io/part-of=ai-platform --ignore-not-found >/dev/null
  kubectl -n platform-jobs delete role,rolebinding -l app.kubernetes.io/part-of=ai-platform --ignore-not-found >/dev/null
  ! kubectl get namespace "$K8S_NAMESPACE" >/dev/null 2>&1 || return 1
  for _ in $(seq 60); do   # local-path 刪除 PV 要幾秒
    [ -z "$(kubectl get pv -o jsonpath="{range .items[?(@.spec.claimRef.namespace=='$K8S_NAMESPACE')]}{.metadata.name}{end}")" ] && return 0
    sleep 2
  done
  return 1
}
k8s_seeded() {   # deploy.sh kind 的最後一步就是種子；這裡確認種子工作成功
  kubectl -n "$K8S_NAMESPACE" get jobs -o jsonpath='{range .items[*]}{.metadata.name} {.status.succeeded}{"\n"}{end}' | grep -q '^seed-.* 1$'
}

BLOCK="$K8S_DIR/offline/block-egress.sh"
offline_bundle_ok() { [ -n "${OFFLINE_BUNDLE:-}" ] && (cd "$OFFLINE_BUNDLE" && sha256sum -c --quiet SHA256SUMS); }
remove_platform_images() {   # cpu-web 節點上刪掉安裝包裡的映像，證明映像確實來自安裝包（busybox、Mailpit 監控堆疊也在用，保留）
  local n=ai-platform-worker ref name
  while read -r ref; do
    [ -n "$ref" ] && [[ "$ref" != busybox:* && "$ref" != axllent/mailpit:* ]] || continue
    for name in $(docker exec "$n" ctr -n k8s.io images ls -q | grep -F "$(echo "${ref%%[:@]*}" | sed 's#^\([^./]*\)$#library/\1#')" || true); do
      docker exec "$n" ctr -n k8s.io images rm "$name" >/dev/null
    done
  done < "$OFFLINE_BUNDLE/images.txt"
  ! docker exec "$n" crictl images -q platform-api:dev 2>/dev/null | grep -q .
}
if [ "$DRILL_TARGET" = k8s-offline ]; then
  [ -n "${KEEP_BLOCKED:-}" ] || trap '"$BLOCK" off >/dev/null 2>&1 || true' EXIT
  step "確認工具：docker、kubectl、kind、python3、uv；叢集 kind-ai-platform 可連" k8s_tools
  step "確認離線安裝包完整（SHA256SUMS）" offline_bundle_ok
  step "清空環境（刪除命名空間 $K8S_NAMESPACE、它的 PVC 與平台的 RBAC）" k8s_empty
  step "刪除平台節點上的平台映像" remove_platform_images
  step "擋掉 kind 節點的對外連線（block-egress.sh on）" "$BLOCK" on
  step "確認節點連不到外部" "$BLOCK" check
  step "由安裝包安裝（offline/install.sh：匯入映像、預載病毒碼、deploy.sh kind）" "$K8S_DIR/offline/install.sh" "$OFFLINE_BUNDLE" kind
  step "等待 Keycloak 就緒" wait_keycloak
  step "建立測試基線（seed 工作已完成）" k8s_seeded
elif [ "$DRILL_TARGET" = k8s ]; then
  step "確認工具：docker、kubectl、kind、python3、uv；叢集 kind-ai-platform 可連" k8s_tools
  step "清空環境（刪除命名空間 $K8S_NAMESPACE、它的 PVC 與平台的 RBAC）" k8s_empty
  step "建置平台映像並匯入叢集節點（build-and-load.sh）" "$K8S_DIR/build-and-load.sh"
  step "部署（deploy.sh kind：Secret、套用、一次性工作、主機連接埠）" "$K8S_DIR/deploy.sh" kind
  step "等待 Keycloak 就緒" wait_keycloak
  step "建立測試基線（seed 工作已完成）" k8s_seeded
else
  step "確認工具：docker、git、uv；Docker 可執行" check_tools
  step "清空環境（刪除容器與 volume）" empty_env
  step "建置並啟動服務（docker compose up -d --build --wait）" dc up -d --build --wait
  step "等待 Keycloak 就緒" wait_keycloak
  step "建立測試基線（python -m app.seed）" dc exec -T api /app/.venv/bin/python -m app.seed
fi
step "admin01 經 Keycloak 登入" login_admin
step "經 Gateway 呼叫管理 API（200）" call_gateway
step "未登入呼叫被擋（401）" unauthenticated_blocked
rm -f "$TOKEN_FILE"
echo "PASS  TC-D02-01     部署說明 $STEPS 個步驟全部完成，無法完成的步驟 0"
