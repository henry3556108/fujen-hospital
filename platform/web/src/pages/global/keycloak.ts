// Keycloak 帳號頁與忘記密碼的網址：沿用登入用的 VITE_OIDC_AUTHORITY / VITE_OIDC_CLIENT_ID。
// 預設值與 auth/oidcAdapter.ts 的 oidcSettings 相同（不在這裡 import，避免把 oidc-client-ts 拉進主程式）。
import { platformEnv } from '../../runtimeConfig';

function settings() {
  const env = platformEnv();
  const authority = env.VITE_OIDC_AUTHORITY || 'http://localhost:8080/realms/ai-platform';
  return { authority: authority.replace(/\/$/, ''), clientId: env.VITE_OIDC_CLIENT_ID || 'ai-platform-web' };
}

/** Keycloak 帳號頁（改密碼、看登入紀錄） */
export function keycloakAccountUrl(): string {
  return `${settings().authority}/account`;
}

/** Keycloak 忘記密碼（寄重設信） */
export function keycloakResetPasswordUrl(): string {
  const { authority, clientId } = settings();
  const redirect = `${window.location.origin}/login`;
  return `${authority}/login-actions/reset-credentials?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}`;
}
