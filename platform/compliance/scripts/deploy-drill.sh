#!/usr/bin/env bash
# 部署演練（TC-D02-01）：照 docs/delivery/部署說明.md 的步驟，從空環境（沒有容器、沒有 volume）部署一次並驗證。
# 每一步印一行 PASS／FAIL；任何一步失敗就停止並回報「無法完成的步驟」。
#   COMPOSE_PROJECT=ai-wp8 KEYCLOAK_HOST_PORT=18380 GATEWAY_HOST_PORT=19380 PACS_HTTP_PORT=18343 scripts/deploy-drill.sh
source "$(dirname "$0")/common.sh"
[ "${CONFIRM_DESTROY:-}" = "$COMPOSE_PROJECT" ] || { echo "會先刪除 $COMPOSE_PROJECT 的全部資料；確認請設 CONFIRM_DESTROY=$COMPOSE_PROJECT" >&2; exit 2; }
GATEWAY="http://localhost:${GATEWAY_HOST_PORT:-9080}"
KEYCLOAK="http://localhost:${KEYCLOAK_HOST_PORT:-8080}"
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

step "確認工具：docker、git、uv；Docker 可執行" check_tools
step "清空環境（刪除容器與 volume）" empty_env
step "建置並啟動服務（docker compose up -d --build --wait）" dc up -d --build --wait
step "等待 Keycloak 就緒" wait_keycloak
step "建立測試基線（python -m app.seed）" dc exec -T api /app/.venv/bin/python -m app.seed
step "admin01 經 Keycloak 登入" login_admin
step "經 Gateway 呼叫管理 API（200）" call_gateway
step "未登入呼叫被擋（401）" unauthenticated_blocked
rm -f "$TOKEN_FILE"
echo "PASS  TC-D02-01     部署說明 $STEPS 個步驟全部完成，無法完成的步驟 0"
