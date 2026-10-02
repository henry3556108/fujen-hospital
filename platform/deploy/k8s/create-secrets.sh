#!/usr/bin/env bash
# 建立平台的 Secret（platform-secrets）。密碼不進版控，也不寫進任何 ConfigMap。
#   ./create-secrets.sh          甲方：每個值以 openssl 隨機產生（只建立一次；已存在就不動）
#   ./create-secrets.sh --dev    kind：與 compose 相同的開發值（驗收測試用這些值登入）
#   ./create-secrets.sh --print-keys   只列出需要的鍵
# 已存在時不覆寫：PostgreSQL、Keycloak 只在第一次初始化時採用密碼，之後改 Secret 不會改到資料庫裡的密碼。
# 要換密碼請照 README「更換密碼」：先在服務內改，再更新 Secret、重啟。
set -euo pipefail
NAMESPACE="${NAMESPACE:-ai-platform}"
KEYS=(POSTGRES_PASSWORD KC_BOOTSTRAP_ADMIN_PASSWORD KC_API_CLIENT_SECRET KC_ADMIN01_PASSWORD
      ORTHANC_API_PASSWORD ORTHANC_GATEWAY_PASSWORD ORTHANC_GATEWAY_AUTH PACS_ADMIN_PASSWORD
      MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY INFERENCE_ADMIN_TOKEN WIKI_ADMIN_PASSWORD)
MODE="${1:-random}"
if [ "$MODE" = "--print-keys" ]; then printf '%s\n' "${KEYS[@]}"; exit 0; fi

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl apply -f "$(dirname "$0")/base/namespace.yaml" >/dev/null
if kubectl -n "$NAMESPACE" get secret platform-secrets >/dev/null 2>&1; then
  echo "platform-secrets 已存在，不覆寫（$NAMESPACE）"
  exit 0
fi

declare -A V
if [ "$MODE" = "--dev" ]; then
  # 與 platform/deploy/local/compose*.yaml、realm-ai-platform.json 相同的本機測試值。不可用於甲方環境。
  V=([POSTGRES_PASSWORD]=platform-dev [KC_BOOTSTRAP_ADMIN_PASSWORD]=kcadmin-dev [KC_API_CLIENT_SECRET]=api-secret-dev
     [KC_ADMIN01_PASSWORD]='Admin01-dev!' [ORTHANC_API_PASSWORD]=orthanc-api-dev [ORTHANC_GATEWAY_PASSWORD]=orthanc-gw-dev
     [PACS_ADMIN_PASSWORD]=pacs-dev [MINIO_ROOT_USER]=minio-dev [MINIO_ROOT_PASSWORD]=minio-dev-secret
     [S3_ACCESS_KEY]=platform-api [S3_SECRET_KEY]=platform-api-dev-secret [INFERENCE_ADMIN_TOKEN]=inference-admin-dev
     [WIKI_ADMIN_PASSWORD]=wiki-svc-dev)
elif [ "$MODE" = "random" ]; then
  command -v openssl >/dev/null || { echo "需要 openssl" >&2; exit 1; }
  rnd() { openssl rand -hex "${1:-24}"; }   # 只用十六進位：會被放進資料庫連線網址與 Basic 認證
  for k in "${KEYS[@]}"; do V[$k]=$(rnd); done
  V[MINIO_ROOT_USER]="minio-$(rnd 6)"
  V[S3_ACCESS_KEY]="platform-api-$(rnd 6)"
  # admin01 的初始密碼：第一次登入必須改（正式環境的 realm 設為 temporary）
  V[KC_ADMIN01_PASSWORD]="$(rnd 12)Aa1!"
else
  echo "用法：$0 [--dev|--print-keys]" >&2; exit 2
fi
# Gateway 換給 Orthanc 的 Basic 認證標頭（apisix.yaml 的 ${{ORTHANC_GATEWAY_AUTH}}）
V[ORTHANC_GATEWAY_AUTH]="Basic $(printf 'gateway:%s' "${V[ORTHANC_GATEWAY_PASSWORD]}" | base64 | tr -d '\n')"

args=()
for k in "${KEYS[@]}"; do args+=("--from-literal=$k=${V[$k]}"); done
kubectl -n "$NAMESPACE" create secret generic platform-secrets "${args[@]}" >/dev/null
kubectl -n "$NAMESPACE" label secret platform-secrets app.kubernetes.io/part-of=ai-platform >/dev/null
echo "已建立 platform-secrets（$NAMESPACE，${#KEYS[@]} 個鍵，模式 ${MODE#--}）"
if [ "$MODE" = "random" ]; then
  echo "admin01 的初始密碼（第一次登入後必須改）："
  echo "  kubectl -n $NAMESPACE get secret platform-secrets -o jsonpath='{.data.KC_ADMIN01_PASSWORD}' | base64 -d"
fi
