import { defineConfig, devices } from '@playwright/test';

// M1 驗收輔助腳本：對已部署的平台（kind 預設 http://localhost:38982；甲方環境設 WEB_URL）以真的 Keycloak 登入，
// 依驗收劇本操作網頁並把截圖存到 EVIDENCE_DIR（預設 ./acceptance-evidence）。
//   WEB_URL=http://localhost:38982 EVIDENCE_DIR=<存證資料夾> npx playwright test -c playwright.acceptance.config.ts [檔名或 -g 關鍵字]
// 加 --headed 可看到瀏覽器實際操作。檔案依序執行（4-5 會暫時改動 md01，排在最後並自動還原）。
export default defineConfig({
  testDir: './e2e-acceptance',
  outputDir: './test-results/acceptance',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_URL || 'http://localhost:38982',
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    trace: 'retain-on-failure',
    launchOptions: { slowMo: Number(process.env.SLOW_MO || 0) },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
