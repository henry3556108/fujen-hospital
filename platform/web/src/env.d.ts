/// <reference types="vite/client" />

/** 編譯期常數：dev server 為 true，vite build 為 false（見 vite.config.ts）。 */
declare const __DEV_SERVER__: boolean;

interface ImportMetaEnv {
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_API_MOCK?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_OIDC_AUTHORITY?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
}
