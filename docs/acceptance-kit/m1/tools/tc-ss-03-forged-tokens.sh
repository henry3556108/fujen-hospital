#!/usr/bin/env bash
# TC-SS-03 偽造與過期 token：錯誤簽章、別的 issuer 各呼叫 3 次；過期 token 另見 expired 子指令。
# 用法：
#   bash tc-ss-03-forged-tokens.sh forge             # 錯誤簽章 3 次 + 別的 issuer 3 次
#   bash tc-ss-03-forged-tokens.sh save-expired      # 取得一張真的 token 存檔（5 分鐘後過期）
#   bash tc-ss-03-forged-tokens.sh expired           # 用存檔的 token 呼叫 3 次（需等 6 分鐘以上）
# 環境變數：GATEWAY（預設 http://localhost:38980）、KEYCLOAK（預設 http://localhost:38180）
set -euo pipefail
GATEWAY=${GATEWAY:-http://localhost:38980}
KEYCLOAK=${KEYCLOAK:-http://localhost:38180}
USER_NAME=${USER_NAME:-vw01}
USER_PASSWORD=${USER_PASSWORD:-Dev-Passw0rd!}
WORK=${WORK:-$(mktemp -d)}
SAVED=${SAVED:-./tc-ss-03-saved-token.txt}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
b64url_decode() { local s=${1//-/+}; s=${s//_//}; while (( ${#s} % 4 )); do s+="="; done; printf '%s' "$s" | openssl base64 -A -d; }
real_token() {
  curl -s -X POST "$KEYCLOAK/realms/ai-platform/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=ai-platform-web -d username="$USER_NAME" --data-urlencode password="$USER_PASSWORD" |
    sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}
call() {  # $1 標籤 $2 token
  for i in 1 2 3; do
    code=$(curl -s -o "$WORK/body" -w '%{http_code}' -H "Authorization: Bearer $2" "$GATEWAY/api/me")
    echo "$1 第 $i 次：HTTP $code $(head -c 80 "$WORK/body")"
  done
}

case "${1:-forge}" in
  forge)
    tok=$(real_token); [ -n "$tok" ] || { echo "取不到 $USER_NAME 的 token，請檢查 Keycloak 位址與密碼"; exit 1; }
    echo "對照組（真的 token）：HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" "$GATEWAY/api/me")（應為 200）"
    IFS=. read -r h p s <<<"$tok"
    # 1. 錯誤簽章：內容不變，換成另一把自產私鑰的簽章
    openssl genrsa -out "$WORK/other.pem" 2048 2>/dev/null
    sig=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$WORK/other.pem" -binary | b64url)
    call "錯誤簽章" "$h.$p.$sig"
    # 2. 別的 issuer：iss 改成別的網址，並用自產私鑰簽（模擬另一個身分提供者發的 token）
    payload=$(b64url_decode "$p" | sed 's#"iss":"[^"]*"#"iss":"https://evil.example.com/realms/ai-platform"#')
    p2=$(printf '%s' "$payload" | b64url)
    sig2=$(printf '%s.%s' "$h" "$p2" | openssl dgst -sha256 -sign "$WORK/other.pem" -binary | b64url)
    call "別的 issuer" "$h.$p2.$sig2"
    ;;
  save-expired)
    real_token > "$SAVED"; echo "已存到 $SAVED，$(date '+%H:%M:%S') 取得；請在 6 分鐘後執行：bash $0 expired" ;;
  expired)
    [ -s "$SAVED" ] || { echo "先執行 save-expired"; exit 1; }
    call "過期 token" "$(cat "$SAVED")" ;;
  *) echo "用法見檔案開頭"; exit 1 ;;
esac
