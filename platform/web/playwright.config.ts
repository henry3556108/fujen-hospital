import { defineConfig, devices } from '@playwright/test';
import { EDGE_MISSING, edgeInstalled } from './e2e/edge';

// 瀏覽器測試：Vite dev server + MSW 模擬 API + test 登入模式（不需要 Docker、Keycloak）。
// 預設 5199 port，避免與開發者手動開的 5173 衝突；多個 worktree 同時跑時用 PW_PORT 換埠。
const PORT = Number(process.env.PW_PORT ?? 5199);

// 只在主程序印一次，讓執行者知道 msedge 的測試為何被略過
if (!process.env.TEST_WORKER_INDEX && !edgeInstalled()) console.warn(`⚠ ${EDGE_MISSING}`);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-TW',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // TC-A02-08 需要 Edge；未安裝時 e2e/fixtures.ts 會把本 project 的測試標為 skipped 並說明原因。
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: { VITE_AUTH_MODE: 'test', VITE_API_MOCK: '1' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
