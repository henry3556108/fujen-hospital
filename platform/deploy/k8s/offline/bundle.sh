#!/usr/bin/env bash
# 離線安裝包：甲方內網不能上網時，部署與重建映像需要的東西都在這個目錄裡。
#   ./bundle.sh <輸出目錄>                       全部
#   SKIP_PACKAGES=1 ./bundle.sh <輸出目錄>       不收 Python／Node 套件快取（只要部署、不在內網重建映像時）
# 內容：
#   images/*.tar        所有映像（上游、平台建置、Job 用），docker save --platform linux/amd64；images.txt 是清單
#   clamav-db.tar       ClamAV 病毒碼（main、daily、bytecode）；叢集內的 clamav 在跑就從它取，否則以 freshclam 下載
#   source.tar          這個 commit 的原始碼（git archive）：manifest、腳本、Dockerfile
#   packages/uv-cache   重建平台映像用的 Python 套件（uv 快取；api、training〔含 keras〕、fakes、libs/tabular、acceptance、compliance）
#   packages/npm-cache  網頁前端的 Node 套件（npm 快取，platform/web 的 package-lock.json）
#   SHA256SUMS          全部檔案的雜湊；install.sh 先比對
# 離線安裝：install.sh（見 README）。
set -euo pipefail
OUT="${1:?用法：$0 <輸出目錄>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
K8S="$(cd "$HERE/.." && pwd)"
PLATFORM_DIR="$(cd "$K8S/../.." && pwd)"
REPO="$(cd "$PLATFORM_DIR/.." && pwd)"
PLATFORM="${PLATFORM:-linux/amd64}"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
mkdir -p "$OUT/images"
OUT="$(cd "$OUT" && pwd)"

: > "$OUT/images.txt"
for ref in $(python3 "$K8S/images.py" all; python3 "$K8S/images.py" jobs); do
  grep -qx "$ref" "$OUT/images.txt" && continue
  docker image inspect "$ref" >/dev/null 2>&1 || { log "拉取 $ref"; docker pull -q "$ref" >/dev/null; }
  save_ref=$ref
  if [[ "$ref" == *@sha256:* ]]; then save_ref="${ref%@*}:pinned"; docker tag "$ref" "$save_ref"; fi
  file="$OUT/images/$(echo "$ref" | tr '/:@' '___').tar"
  log "匯出 $ref"
  docker save --platform "$PLATFORM" -o "$file" "$save_ref"
  echo "$ref" >> "$OUT/images.txt"
done

log "ClamAV 病毒碼"
if kubectl -n ai-platform get pod clamav-0 >/dev/null 2>&1 \
   && kubectl -n ai-platform exec clamav-0 -- test -f /var/lib/clamav/daily.cvd -o -f /var/lib/clamav/daily.cld 2>/dev/null; then
  kubectl -n ai-platform exec clamav-0 -- sh -c 'cd /var/lib/clamav && tar cf - *.cvd *.cld 2>/dev/null' > "$OUT/clamav-db.tar"
else
  clam=$(python3 "$K8S/images.py" upstream | grep clamav)
  tmp=$(mktemp -d)
  docker run --rm --entrypoint sh -v "$tmp:/var/lib/clamav" "$clam" -c 'chown clamav /var/lib/clamav; freshclam --stdout --foreground'
  tar cf "$OUT/clamav-db.tar" -C "$tmp" .
  rm -rf "$tmp"
fi
tar tf "$OUT/clamav-db.tar" | grep -q '^\(\./\)\?main\.' || { echo "病毒碼不完整（沒有 main）" >&2; exit 1; }

log "原始碼（git archive HEAD）"
git -C "$REPO" archive --format=tar -o "$OUT/source.tar" HEAD

if [ -z "${SKIP_PACKAGES:-}" ]; then
  export UV_CACHE_DIR="$OUT/packages/uv-cache"
  for proj in api fakes libs/tabular acceptance compliance; do
    log "Python 套件：$proj"
    (cd "$PLATFORM_DIR/$proj" && uv sync --frozen -q)
  done
  log "Python 套件：training（含 keras）"
  (cd "$PLATFORM_DIR/training" && uv sync --frozen -q --extra keras)
  if [ -f "$PLATFORM_DIR/web/package-lock.json" ]; then
    log "Node 套件：web"
    tmp=$(mktemp -d)
    cp "$PLATFORM_DIR/web/package.json" "$PLATFORM_DIR/web/package-lock.json" "$tmp/"
    (cd "$tmp" && npm ci --ignore-scripts --cache "$OUT/packages/npm-cache" --no-audit --no-fund >/dev/null)
    rm -rf "$tmp"
  fi
fi

log "雜湊"
(cd "$OUT" && find . -type f ! -name SHA256SUMS ! -path './packages/*' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
du -sh "$OUT" "$OUT"/* 2>/dev/null
log "完成：$OUT"
