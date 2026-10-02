#!/bin/sh
# 容器啟動時把 WEB_* 環境變數寫成 /config.js（window.__PLATFORM_CONFIG__，見 src/runtimeConfig.ts）。
# 只接受網址會用到的字元，避免把任意內容寫進頁面。
set -eu
out=/usr/share/nginx/html/config.js
pairs=""
for spec in API_BASE:VITE_API_BASE OIDC_AUTHORITY:VITE_OIDC_AUTHORITY OIDC_CLIENT_ID:VITE_OIDC_CLIENT_ID \
            OHIF_BASE:VITE_OHIF_BASE GRAFANA_URL:VITE_GRAFANA_URL PROMETHEUS_URL:VITE_PROMETHEUS_URL \
            ALERTMANAGER_URL:VITE_ALERTMANAGER_URL MAILPIT_URL:VITE_MAILPIT_URL; do
  name="WEB_${spec%%:*}"; key="${spec#*:}"
  eval "set=\${$name+x}"; [ -n "$set" ] || continue
  eval "value=\${$name}"
  if [ -n "$value" ] && ! printf '%s\n' "$value" | grep -Eq '^[A-Za-z0-9:/._~%?=&+-]*$'; then
    echo "40-platform-config：$name 含不允許的字元" >&2; exit 1
  fi
  pairs="$pairs\"$key\":\"$value\","
done
printf 'window.__PLATFORM_CONFIG__ = {%s};\n' "${pairs%,}" > "$out"
echo "40-platform-config：已寫出 $out"
