#!/usr/bin/env bash
# TC-SS-05 繞過 Gateway：從平台以外的機器直接連平台 API、推論服務、HAPI FHIR、Orthanc 的內部位址，各 10 次。
# 內部位址（Pod IP 與 Service IP）以 kubectl 讀出；每次連線逾時 2 秒。成功 = 拿到任何 HTTP 回應碼且不是 401。
# 用法：bash tc-ss-05-bypass-gateway.sh        （環境變數 NS 預設 ai-platform）
set -uo pipefail
NS=${NS:-ai-platform}
declare -A PORT=([api]=8000 [inference]=8000 [hapi]=8080 [orthanc]=8042)
declare -A PATHS=([api]=/api/me [inference]=/ [hapi]=/fhir/metadata [orthanc]=/system)
total_ok=0
for svc in api inference hapi orthanc; do
  pod_ip=$(kubectl -n "$NS" get pod -l app=$svc -o jsonpath='{.items[0].status.podIP}')
  svc_ip=$(kubectl -n "$NS" get svc $svc -o jsonpath='{.spec.clusterIP}')
  [ "$svc_ip" = "None" ] && svc_ip=""   # headless Service 沒有 Service IP，只測 Pod IP
  for target in ${pod_ip:+$pod_ip} ${svc_ip:+$svc_ip}; do
    ok=0; codes=""
    for i in $(seq 10); do
      code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$target:${PORT[$svc]}${PATHS[$svc]}")
      codes+="$code "
      if [ "$code" != "000" ] && [ "$code" != "401" ]; then ok=$((ok+1)); fi
    done
    echo "$svc $target:${PORT[$svc]} 10 次，成功 $ok 次（回應碼：$codes）"
    total_ok=$((total_ok+ok))
  done
done
echo "合計成功 $total_ok 次（000 = 網路不可達，應為 0 次成功）"
