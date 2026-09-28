// Keycloak OIDC：Authorization Code + PKCE（oidc-client-ts 預設啟用 PKCE），public client，無 client secret。
import { UserManager, WebStorageStateStore, type UserManagerSettings } from 'oidc-client-ts';
import type { AuthAdapter, AuthUser, LoginOptions } from './adapter';

export interface OidcEnv {
  VITE_OIDC_AUTHORITY?: string;
  VITE_OIDC_CLIENT_ID?: string;
}

export function oidcSettings(origin: string, env: OidcEnv): UserManagerSettings {
  return {
    authority: env.VITE_OIDC_AUTHORITY || 'http://localhost:8080/realms/ai-platform',
    client_id: env.VITE_OIDC_CLIENT_ID || 'ai-platform-web',
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: `${origin}/login`,
    response_type: 'code',
    scope: 'openid profile',
    automaticSilentRenew: true,
  };
}

export class OidcAuthAdapter implements AuthAdapter {
  readonly mode = 'oidc' as const;
  private readonly manager: UserManager;

  constructor(origin: string, env: OidcEnv) {
    this.manager = new UserManager({
      ...oidcSettings(origin, env),
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    });
  }

  async getUser(): Promise<AuthUser | null> {
    const user = await this.manager.getUser();
    if (!user || user.expired) return null;
    const username = (user.profile.preferred_username as string | undefined) ?? user.profile.sub;
    return { username, accessToken: user.access_token };
  }

  async login(options: LoginOptions = {}): Promise<void> {
    await this.manager.signinRedirect({ state: { returnTo: options.returnTo ?? '/' } });
  }

  async handleCallback(): Promise<string> {
    const user = await this.manager.signinRedirectCallback();
    const state = user.state as { returnTo?: string } | undefined;
    const returnTo = state?.returnTo;
    // 只接受站內路徑，避免開放式重新導向
    return returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  }

  async logout(): Promise<void> {
    await this.manager.signoutRedirect();
  }

  async clearSession(): Promise<void> {
    await this.manager.removeUser();
  }
}
