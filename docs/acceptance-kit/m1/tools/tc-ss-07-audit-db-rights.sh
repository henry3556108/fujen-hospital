#!/usr/bin/env bash
# TC-SS-07 第 2 部分：平台 API 的資料庫帳號對 audit_log 只有 INSERT 與 SELECT。
# 從 api Pod 的 DATABASE_URL 讀出應用程式帳號（密碼不會印出），以該帳號嘗試 UPDATE、DELETE、TRUNCATE（應被拒），
# 再嘗試 SELECT 與 INSERT（應成功；INSERT 會留下一筆 actor = tc-ss-07 的標記紀錄，屬正常）。
# 用法：bash tc-ss-07-audit-db-rights.sh     （環境變數 NS 預設 ai-platform，CTX 可指定 kubectl context）
set -uo pipefail
NS=${NS:-ai-platform}
K="kubectl ${CTX:+--context $CTX} -n $NS"
URL=$($K exec deploy/api -- printenv DATABASE_URL)
APP_USER=$(echo "$URL" | sed -E 's#^[^:]+://([^:]+):.*#\1#')
APP_PW=$(echo "$URL" | sed -E 's#^[^:]+://[^:]+:([^@]+)@.*#\1#')
echo "平台 API 的資料庫帳號：$APP_USER"
echo "== 帳號屬性（rolsuper、rolcreatedb、rolcreaterole 應皆為 f）"
$K exec postgres-0 -- psql -U platform -d platform -tAc "select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = '$APP_USER'"
echo "== audit_log 權限（$APP_USER 應只有 ar = INSERT、SELECT）"
$K exec postgres-0 -- psql -U platform -d platform -c "\dp audit_log"
as_app() { $K exec postgres-0 -- env PGPASSWORD="$APP_PW" psql -h 127.0.0.1 -U "$APP_USER" -d platform -v ON_ERROR_STOP=1 -qtAc "$1" 2>&1; }
for sql in "update audit_log set actor = 'tampered' where id = (select max(id) from audit_log)" \
           "delete from audit_log where id = (select max(id) from audit_log)" \
           "truncate audit_log"; do
  echo "== 以 $APP_USER 執行：$sql（應被拒）"; as_app "$sql"
done
echo "== 以 $APP_USER 執行 SELECT（應成功）"; as_app "select count(*) from audit_log"
echo "== 以 $APP_USER 執行 INSERT（應成功）"
as_app "insert into audit_log (at, actor, category, action, target, result, source_ip, detail) values (now(), 'tc-ss-07', 'account', 'acceptance.insert_check', 'tc-ss-07-$(date +%s)', 'success', 'local:acceptance', '{}') returning id"
echo "== 確認沒有被竄改的紀錄（應為 0）"
$K exec postgres-0 -- psql -U platform -d platform -tAc "select count(*) from audit_log where actor = 'tampered'"
