// 測試用登入：不連 Keycloak，直接以種子帳號名稱產生 "test-token:<username>"，
// 由 MSW 模擬 API 辨識。只會在 dev server + VITE_AUTH_MODE=test 時被載入。
import type { AuthAdapter, AuthUser, LoginOptions } from './adapter';

const STORAGE_KEY = '__AI_PLATFORM_TEST_AUTH__.user';

export class TestAuthAdapter implements AuthAdapter {
  readonly mode = 'test' as const;

  async getUser(): Promise<AuthUser | null> {
    const username = window.localStorage.getItem(STORAGE_KEY);
    return username ? { username, accessToken: `test-token:${username}` } : null;
  }

  async login(options: LoginOptions = {}): Promise<void> {
    window.localStorage.setItem(STORAGE_KEY, options.username ?? 'admin01');
  }

  async handleCallback(): Promise<string> {
    return '/';
  }

  async logout(): Promise<void> {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  async clearSession(): Promise<void> {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
