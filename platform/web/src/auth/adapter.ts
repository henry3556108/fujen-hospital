// 登入抽象層：正式環境用 OIDC（Keycloak），開發／測試可用 test 模式。
// test 模式只在 dev server（編譯期常數 __DEV_SERVER__ = true）且 VITE_AUTH_MODE=test 時啟用；
// 任何 `vite build` 產物中 __DEV_SERVER__ 都是常數 false（不受 NODE_ENV、--mode 影響），
// 整段 test 程式碼會被移除（見 tests/unit/prod-build.test.ts）。

export interface AuthUser {
  username: string;
  accessToken: string;
}

export interface LoginOptions {
  /** 登入後回到的路徑 */
  returnTo?: string;
  /** 只有 test 模式使用：要登入的種子帳號 */
  username?: string;
}

export interface AuthAdapter {
  readonly mode: AuthMode;
  getUser(): Promise<AuthUser | null>;
  login(options?: LoginOptions): Promise<void>;
  /** 處理 /auth/callback，回傳登入後要去的路徑 */
  handleCallback(): Promise<string>;
  logout(): Promise<void>;
  /** API 回 401 時清掉本機登入狀態（不導向 IdP 登出頁） */
  clearSession(): Promise<void>;
}

export type AuthMode = 'oidc' | 'test';

export interface AuthEnv {
  testAuthAllowed: boolean;
  VITE_AUTH_MODE?: string;
}

export function selectAuthMode(env: AuthEnv): AuthMode {
  return env.testAuthAllowed === true && env.VITE_AUTH_MODE === 'test' ? 'test' : 'oidc';
}

export async function createAuthAdapter(): Promise<AuthAdapter> {
  // 必須保留 `__DEV_SERVER__ &&` 這個靜態條件，打包時才會整段移除 test adapter。
  if (
    __DEV_SERVER__ &&
    selectAuthMode({ testAuthAllowed: __DEV_SERVER__, VITE_AUTH_MODE: import.meta.env.VITE_AUTH_MODE }) === 'test'
  ) {
    const { TestAuthAdapter } = await import('./testAdapter');
    return new TestAuthAdapter();
  }
  const { OidcAuthAdapter } = await import('./oidcAdapter');
  return new OidcAuthAdapter(window.location.origin, import.meta.env);
}
