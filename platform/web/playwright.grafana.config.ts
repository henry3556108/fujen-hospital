import { defineConfig, devices } from '@playwright/test';

// TC-C02-03 客製儀表板：直接操作 kind 叢集裡的真 Grafana（platform/deploy/kind/up.sh）。
// 叢集或 Grafana 不在時測試標為 skipped 並說明原因。
//   npm run test:e2e:grafana
// 只用 1 個 worker：kind 裡的 Grafana 記憶體上限 384 MiB，同時多個瀏覽器登入會被 OOMKilled。
export default defineConfig({
  testDir: './e2e-grafana',
  outputDir: './test-results/grafana',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: { locale: 'zh-TW', trace: 'retain-on-failure', viewport: { width: 1400, height: 900 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } },
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1400, height: 900 } } },
  ],
});
