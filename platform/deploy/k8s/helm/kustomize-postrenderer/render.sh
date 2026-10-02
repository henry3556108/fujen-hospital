#!/usr/bin/env bash
# 參數：overlay 目錄（絕對路徑）。chart 沒有樣板，stdin 應該是空的；讀掉以免 Helm 寫入時阻塞。
set -euo pipefail
cat >/dev/null
exec kubectl kustomize "${1:?需要 overlay 目錄}"
