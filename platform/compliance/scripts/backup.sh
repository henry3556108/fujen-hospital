#!/usr/bin/env bash
# 備份平台資料（TC-D02-02）：PostgreSQL（平台與 Keycloak 資料庫＋角色）、物件儲存、檔案型 volume（Orthanc 等）、Keycloak realm 設定。
#   COMPOSE_PROJECT=ai-platform scripts/backup.sh [輸出目錄]
# 輸出目錄預設 ./backups/<時間>；內含 manifest.txt（筆數清單）供還原後比對。
source "$(dirname "$0")/common.sh"
OUT="${1:-$PWD/backups/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT/postgres" "$OUT/volumes"
OUT="$(cd "$OUT" && pwd)"

log "筆數清單"
counts > "$OUT/manifest.txt"

log "PostgreSQL 角色"
dc exec -T postgres pg_dumpall -U platform --roles-only > "$OUT/postgres/roles.sql"
for db in $(databases); do
  log "PostgreSQL 資料庫 $db"
  dc exec -T postgres pg_dump -U platform -Fc "$db" > "$OUT/postgres/$db.dump"
done

log "物件儲存（經平台 API 匯出）"
dc exec -T api /app/.venv/bin/python -c "$OBJECTS_EXPORT" > "$OUT/objects.tar"

log "Keycloak realm 設定（可讀的參考副本；還原以資料庫為準）"
if dc exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master \
     --user "${KC_ADMIN:-kcadmin}" --password "${KC_ADMIN_PASSWORD:-kcadmin-dev}" >/dev/null 2>&1; then
  dc exec -T keycloak /opt/keycloak/bin/kcadm.sh get realms/ai-platform > "$OUT/keycloak-realm.json"
else
  log "警告：無法登入 Keycloak 管理介面，略過 realm 參考副本"
fi

for volume in $(project_volumes); do
  services=$(volume_services "$volume" | tr '\n' ' ')
  log "volume $volume（暫停 ${services:-無}）"
  [ -n "$services" ] && dc stop $services >/dev/null
  docker run --rm -v "$volume:/src:ro" -v "$OUT/volumes:/dst" busybox:1.36 tar -C /src -cf "/dst/$volume.tar" .
  [ -n "$services" ] && dc start $services >/dev/null
done

( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
log "完成：$OUT（$(du -sh "$OUT" | cut -f1)）"
echo "$OUT"
