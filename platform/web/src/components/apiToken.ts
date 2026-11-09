// 外部工具取得 Token 的步驟（B-07-6、B-06-5）。
// 正式環境關閉帳密換 Token，所以用 device-code：在瀏覽器以授權帳號登入一次。範例只有網址與公開的 client id，沒有密鑰。
import { platformEnv } from '../runtimeConfig';

export const TOKEN_CLIENT_ID = 'ai-platform-importer';

export function tokenSteps(authority: string): string {
  const oidc = `${authority.replace(/\/$/, '')}/protocol/openid-connect`;
  return [
    '# 1. 申請登入碼，用瀏覽器打開回應裡的 verification_uri_complete，以授權帳號登入',
    `curl -s -X POST "${oidc}/auth/device" -d "client_id=${TOKEN_CLIENT_ID}"`,
    '',
    '# 2. 登入後用回應裡的 device_code 換 Token，取出 access_token（有效 5 分鐘，過期重做）',
    `curl -s -X POST "${oidc}/token" \\`,
    '  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \\',
    `  -d "client_id=${TOKEN_CLIENT_ID}" \\`,
    '  -d "device_code=<device_code>"',
    '',
    'export TOKEN=<access_token>',
  ].join('\n');
}

export function platformTokenSteps(): string {
  return tokenSteps(platformEnv().VITE_OIDC_AUTHORITY || 'http://localhost:8080/realms/ai-platform');
}

export function serviceCallExample(origin: string, endpoint: string): string {
  return [
    `curl -X POST "${origin}${endpoint}" \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"question": "請輸入問題"}'`,
  ].join('\n');
}
