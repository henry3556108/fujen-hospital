import { defineConfig, devices } from '@playwright/test';

// 結案操作手冊與教學影片：對已部署的平台（kind 預設 http://localhost:38982；其他環境設 WEB_URL）以真的 Keycloak 登入，
// 依情境操作網頁，產出手冊截圖＋Markdown 片段、錄影＋時間軸（見 e2e-manual/README.md）。
//   MANUAL_OUT=<這次輸出暫存> npx playwright test -c playwright.manual.config.ts <spec 檔名>
// 一律開視窗（headed）、1 個 worker；錄影 1440×900、裝置像素比 1（截圖、錄影、時間軸 bbox 座標一致）。
const SIZE = { width: 1440, height: 900 };

export default defineConfig({
  testDir: './e2e-manual',
  outputDir: process.env.MANUAL_OUT || './test-results/manual',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.WEB_URL || 'http://localhost:38982',
    headless: false,
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    video: { mode: 'on', size: SIZE },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
