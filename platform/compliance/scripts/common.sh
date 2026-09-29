# 備份、還原、演練腳本共用設定。以環境變數覆寫：
#   COMPOSE_PROJECT   compose 專案名稱（預設 ai-platform）
#   COMPOSE_OVERLAYS  以空白分隔的疊加檔（相對於 platform/deploy/local），例："compose.kind.yaml compose.compliance.yaml"
set -euo pipefail
PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_DIR="$PLATFORM_DIR/deploy/local"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-ai-platform}"
COMPOSE_OVERLAYS="${COMPOSE_OVERLAYS:-}"
# 不備份的 volume：資料庫檔（改用邏輯備份）、MinIO 磁碟格式（改匯出物件）、病毒碼（可重新下載）、模擬 PACS（不是平台資料）
SKIP_VOLUMES_RE="${SKIP_VOLUMES_RE:-_(pgdata|minio-data|clamav-db|orthanc-pacs-db)$}"

dc() {
  local args=(-p "$COMPOSE_PROJECT" -f "$LOCAL_DIR/compose.yaml")
  for f in $COMPOSE_OVERLAYS; do args+=(-f "$LOCAL_DIR/$f"); done
  docker compose "${args[@]}" "$@"
}

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

databases() {
  dc exec -T postgres psql -U platform -d postgres -tAc \
    "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1"
}

project_volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" | grep -Ev "$SKIP_VOLUMES_RE" || true
}

# volume 名稱 → 使用它的 compose 服務（還原或備份時先停下）
volume_services() {
  local volume=$1
  docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter "volume=$volume" \
    --format '{{.Label "com.docker.compose.service"}}' | sort -u
}

# 以平台 API 容器（它自己的最小權限帳號）操作物件儲存
OBJECTS_EXPORT='
import io, os, sys, tarfile
from app.storage import store_from_env
store = store_from_env(os.environ)
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w") as tar:
    for key in store.list(""):
        data = store.get(key)
        info = tarfile.TarInfo(name=key.lstrip("/")); info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
sys.stdout.buffer.write(buf.getvalue())
'
OBJECTS_IMPORT='
import io, os, sys, tarfile
from app.storage import store_from_env
store = store_from_env(os.environ)
n = 0
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())) as tar:
    for m in tar.getmembers():
        if m.isfile():
            store.put(m.name, tar.extractfile(m).read()); n += 1
print(n)
'

# 筆數清單：每個資料庫每張表的列數、物件數、Orthanc 影像數、Keycloak 帳號數。還原演練以此比對。
counts() {
  local db
  for db in $(databases); do
    dc exec -T postgres psql -U platform -d "$db" -tAF' ' -c "
      select 'db.$db.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
      from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
  done
  dc exec -T api /app/.venv/bin/python -c '
import os, httpx
from app.storage import store_from_env
print("objects.count", len(store_from_env(os.environ).list("")))
url = os.environ.get("ORTHANC_URL")
if url:
    import time
    for attempt in range(60):   # Orthanc 剛重啟時可能還沒就緒
        try:
            s = httpx.get(url + "/statistics", auth=(os.environ["ORTHANC_USERNAME"], os.environ["ORTHANC_PASSWORD"]), timeout=30).json()
            break
        except httpx.HTTPError:
            time.sleep(2)
    else:
        raise SystemExit("Orthanc 無法連線")
    for k in ("CountPatients", "CountStudies", "CountSeries", "CountInstances"):
        print("orthanc." + k, s[k])
'
}
