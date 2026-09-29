#!/usr/bin/env bash
# 從 backup.sh 的輸出還原（TC-D02-02）。目標是同一套 compose 服務（可以是剛以空資料啟動的環境）。
#   COMPOSE_PROJECT=ai-platform scripts/restore.sh <備份目錄>
# 會覆蓋目標環境的資料庫、物件儲存與檔案型 volume。
source "$(dirname "$0")/common.sh"
IN="$(cd "${1:?用法：restore.sh <備份目錄>}" && pwd)"

log "檢查備份完整性"
( cd "$IN" && sha256sum --quiet -c SHA256SUMS )

log "停下會寫資料的服務"
dc stop api keycloak >/dev/null

log "PostgreSQL 角色（已存在的角色會略過）"
dc exec -T postgres psql -U platform -d postgres -q -v ON_ERROR_STOP=0 < "$IN/postgres/roles.sql" >/dev/null 2>&1 || true
for dump in "$IN"/postgres/*.dump; do
  db=$(basename "$dump" .dump)
  log "PostgreSQL 資料庫 $db"
  dc exec -T postgres psql -U platform -d postgres -q -c "drop database if exists \"$db\" with (force)" -c "create database \"$db\""
  dc exec -T postgres pg_restore -U platform -d "$db" --no-owner --role=platform < "$dump"
done

for archive in "$IN"/volumes/*.tar; do
  [ -e "$archive" ] || continue
  volume=$(basename "$archive" .tar)
  services=$(volume_services "$volume" | tr '\n' ' ')
  log "volume $volume（暫停 ${services:-無}）"
  [ -n "$services" ] && dc stop $services >/dev/null
  docker volume create "$volume" >/dev/null
  docker run --rm -v "$volume:/dst" -v "$IN/volumes:/src:ro" busybox:1.36 sh -c "find /dst -mindepth 1 -delete && tar -C /dst -xf /src/$volume.tar"
  [ -n "$services" ] && dc start $services >/dev/null
done

log "啟動 Keycloak 與平台 API"
dc start keycloak api >/dev/null
for i in $(seq 1 60); do dc exec -T api /app/.venv/bin/python -c "import httpx; httpx.get('http://localhost:8000/healthz').raise_for_status()" >/dev/null 2>&1 && break; sleep 2; done

log "物件儲存"
n=$(dc exec -T api /app/.venv/bin/python -c "$OBJECTS_IMPORT" < "$IN/objects.tar")
log "已寫回物件 $n 個"
log "完成"
