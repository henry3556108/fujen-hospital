#!/usr/bin/env bash
# 還原演練（TC-D02-02）：備份 → 刪除所有資料（down -v）→ 以空資料重新啟動 → 還原 → 比對筆數，差異 0 才通過。
#   COMPOSE_PROJECT=ai-wp8 KEYCLOAK_HOST_PORT=18380 GATEWAY_HOST_PORT=19380 PACS_HTTP_PORT=18343 scripts/restore-drill.sh
# 目標環境必須已有資料（至少跑過 seed）。演練會刪除該 compose 專案的所有 volume，請勿對正式資料執行。
source "$(dirname "$0")/common.sh"
WORK="${DRILL_DIR:-$(mktemp -d)}"
[ "${CONFIRM_DESTROY:-}" = "$COMPOSE_PROJECT" ] || { echo "會刪除 $COMPOSE_PROJECT 的全部資料；確認請設 CONFIRM_DESTROY=$COMPOSE_PROJECT" >&2; exit 2; }

objects_before=$(dc exec -T api /app/.venv/bin/python -c 'import os; from app.storage import store_from_env; print(len(store_from_env(os.environ).list("")))')
[ "$objects_before" -gt 0 ] || log "警告：物件儲存是空的，演練不會驗證到物件還原"

backup_dir=$("$(dirname "$0")/backup.sh" "$WORK/backup")
log "刪除資料：down -v"
dc down -v >/dev/null 2>&1
log "以空資料重新啟動"
dc up -d --wait >/dev/null 2>&1
empty=$(dc exec -T postgres psql -U platform -d platform -tAc "select count(*) from audit_log" 2>/dev/null || echo 0)
log "還原前 audit_log 筆數：$empty"
"$(dirname "$0")/restore.sh" "$backup_dir"
counts > "$WORK/after.txt"

if diff -u "$backup_dir/manifest.txt" "$WORK/after.txt" > "$WORK/diff.txt"; then
  items=$(wc -l < "$WORK/after.txt")
  echo "PASS  TC-D02-02     還原後筆數差異 0（比對 $items 項，含資料表、物件 $objects_before 個、Orthanc 影像）；備份 $backup_dir"
else
  cat "$WORK/diff.txt" >&2
  echo "FAIL  TC-D02-02     還原後筆數有差異，見 $WORK/diff.txt"
  exit 1
fi
