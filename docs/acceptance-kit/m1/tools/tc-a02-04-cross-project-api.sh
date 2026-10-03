#!/usr/bin/env bash
# TC-A02-04 跨專案隔離（API 部分）：user01（不屬於任何專案）帶自己的 token 呼叫 10 個 P1 資料 API。
# P1 的專案編號與第一份結構式資料集編號先用 admin01 查出（唯讀），再以 user01 呼叫。應全部 403，成功 0 次。
# 用法：bash tc-a02-04-cross-project-api.sh
set -uo pipefail
GATEWAY=${GATEWAY:-http://localhost:38980}
KEYCLOAK=${KEYCLOAK:-http://localhost:38180}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-Admin01-dev!}
USER_PASSWORD=${USER_PASSWORD:-Dev-Passw0rd!}
tok() { curl -s -X POST "$KEYCLOAK/realms/ai-platform/protocol/openid-connect/token" -d grant_type=password \
  -d client_id=ai-platform-web -d username="$1" --data-urlencode password="$2" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'; }
ADM=$(tok admin01 "$ADMIN_PASSWORD"); U1=$(tok user01 "$USER_PASSWORD")
[ -n "$ADM" ] && [ -n "$U1" ] || { echo "取不到 token，請檢查 Keycloak 位址與密碼"; exit 1; }
P1=$(curl -s -H "Authorization: Bearer $ADM" "$GATEWAY/api/admin/projects" | tr '{' '\n' | sed -n 's/^"id":\([0-9]*\),"name":"P1-lung-ct".*/\1/p')
DS=$(curl -s -H "Authorization: Bearer $ADM" "$GATEWAY/api/projects/$P1/tabular/datasets" | sed -n 's/^\[{"id":\([0-9]*\),.*/\1/p')
echo "P1-lung-ct 的專案編號：$P1；第一份結構式資料集編號：${DS:-（無）}"
paths=(
  "/api/projects/$P1/imaging/studies"
  "/api/projects/$P1/imaging/files"
  "/api/projects/$P1/imaging/jobs"
  "/api/projects/$P1/imaging/accession-allowlist"
  "/api/projects/$P1/tabular/datasets"
  "/api/projects/$P1/tabular/datasets/${DS:-1}"
  "/api/projects/$P1/tabular/datasets/${DS:-1}/preview"
  "/api/projects/$P1/jobs"
  "/api/projects/$P1/labels/annotations"
  "/api/projects/$P1/llm/prompts"
)
ok=0; n=0
for p in "${paths[@]}"; do
  n=$((n+1)); code=$(curl -s -o /tmp/tc-a02-04.body -w '%{http_code}' -H "Authorization: Bearer $U1" "$GATEWAY$p")
  [ "$code" = "200" ] && ok=$((ok+1))
  echo "$n. HTTP $code $p $(head -c 90 /tmp/tc-a02-04.body)"
done
echo "user01 存取 P1 共 $n 次，成功 $ok 次（應為 0）"
