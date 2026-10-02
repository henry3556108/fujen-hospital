// 執行期設定：同一個映像要能部署到每個環境（kind、甲方），網址不能在打包時寫死。
// 容器啟動時寫出 /config.js（window.__PLATFORM_CONFIG__），index.html 在主程式之前載入它；
// 值的名稱沿用打包期的 VITE_*，執行期的值優先。dev server 用 public/config.js（空物件），維持 .env 的行為。
// 只放公開設定（網址、client id）；不可放任何密碼或金鑰（TC-SS-04 會掃打包檔與 config.js）。

export type PlatformEnv = Record<string, string | undefined>;

declare global {
  interface Window {
    __PLATFORM_CONFIG__?: PlatformEnv;
  }
}

export function platformEnv(
  buildEnv: PlatformEnv = import.meta.env as unknown as PlatformEnv,
  runtime: PlatformEnv | undefined = typeof window !== 'undefined' ? window.__PLATFORM_CONFIG__ : undefined,
): PlatformEnv {
  const out: PlatformEnv = { ...buildEnv };
  for (const [key, value] of Object.entries(runtime ?? {})) {
    if (key.startsWith('VITE_') && typeof value === 'string') out[key] = value;
  }
  return out;
}
