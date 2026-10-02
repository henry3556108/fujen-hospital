import { defineConfig, devices } from '@playwright/test';

// 真環境端對端：網頁 → APISIX Gateway → 平台 API，登入走真的 Keycloak。
// 先啟動 platform/deploy/local 的 Docker 環境並執行種子資料，再：
//   VITE_API_BASE=http://localhost:9080 VITE_AUTH_MODE=oidc npm run dev   （另一個終端）
//   npm run test:e2e:real
// 或對正式映像（platform/web/Dockerfile）：WEB_URL=http://localhost:38982 npm run test:e2e:real
export default defineConfig({
  testDir: './e2e-real',
  outputDir: './test-results/real',
  retries: 0,
  reporter: [['list']],
  // WEB_URL：網頁的位址。預設是 npm run dev；compose.web.yaml 是 http://localhost:9082，kind 是 http://localhost:38982
  use: { baseURL: process.env.WEB_URL || 'http://localhost:5173', locale: 'zh-TW', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});
