import { expect, test, type APIRequestContext } from '@playwright/test';

// 與 platform/deploy/kind/monitoring/grafana.yaml、platform/acceptance/kind_harness.py 相同的本機開發值
const GRAFANA = process.env.GRAFANA_URL ?? 'http://127.0.0.1:33000';
const USER = process.env.GRAFANA_USER ?? 'admin';
const PASSWORD = process.env.GRAFANA_PASSWORD ?? 'Grafana-dev-01!';

async function grafanaReady(request: APIRequestContext): Promise<string | null> {
  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await request.get(`${GRAFANA}/api/health`, { timeout: 3_000 });
      if (r.ok()) return null;
      last = `HTTP ${r.status()}`;
    } catch (e) {
      last = (e as Error).message.split('\n')[0];
      // 連不上且不是重啟中：叢集不存在，不必等
      if (/ECONNREFUSED/.test(last) && Date.now() > deadline - 85_000) break;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return last || '沒有回應';
}

test('TC-C02-03 客製儀表板：2 種視覺效果，在網頁改更新頻率並儲存，重新載入後一致', async ({ page, request }) => {
  const problem = await grafanaReady(request);
  test.skip(problem !== null, `kind 叢集的 Grafana（${GRAFANA}）連不上：${problem}。先執行 platform/deploy/kind/up.sh`);

  // 1. 以 Grafana 帳號從登入頁登入
  await page.goto(`${GRAFANA}/login`);
  await page.getByLabel(/username/i).first().fill(USER, { timeout: 30_000 });
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000, waitUntil: 'commit' });

  // 2. 建立 1 個儀表板、2 種視覺效果（時間序列＋儀表）。用同一個已登入的瀏覽器工作階段呼叫 Grafana 的儀表板 API，
  //    與 Grafana 網頁「匯入儀表板」送出的內容相同；逐步拖拉面板的 UI 操作不在驗收範圍，也最容易因 Grafana 改版而失效。
  const uid = `tc-c02-03-web-${Date.now()}`;
  const panels = [
    {
      id: 1, type: 'timeseries', title: 'Pod 記憶體', gridPos: { x: 0, y: 0, w: 12, h: 8 },
      datasource: { type: 'prometheus', uid: 'prometheus' },
      targets: [{ refId: 'A', expr: 'sum by (namespace) (container_memory_working_set_bytes{container!=""})' }],
    },
    {
      id: 2, type: 'gauge', title: '假 GPU 可用份數', gridPos: { x: 12, y: 0, w: 12, h: 8 },
      datasource: { type: 'prometheus', uid: 'prometheus' },
      targets: [{ refId: 'A', expr: 'sum(kube_node_status_allocatable{resource="nvidia_com_gpu"})' }],
    },
  ];
  const created = await page.request.post(`${GRAFANA}/api/dashboards/db`, {
    data: { dashboard: { uid, title: `TC-C02-03 ${uid}`, refresh: '10s', schemaVersion: 39, panels }, overwrite: false },
  });
  expect(created.status(), await created.text()).toBe(200);

  try {
    // 3. 開啟儀表板：兩個面板都顯示，更新頻率為 10s
    await page.goto(`${GRAFANA}/d/${uid}`);
    await expect(page.getByTestId('data-testid Panel header Pod 記憶體')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('data-testid Panel header 假 GPU 可用份數')).toBeVisible();
    const picker = page.getByTestId('data-testid RefreshPicker interval button');
    await expect(picker).toHaveAttribute('aria-label', /10 seconds/);

    // 4. 在網頁上改更新頻率為 1 分鐘並儲存為預設
    await page.getByTestId('data-testid Edit dashboard button').click();
    await picker.click();
    await page.getByTestId('data-testid ButtonSelect option 1m').click();
    await expect(picker).toHaveAttribute('aria-label', /1 minute/);
    await page.getByTestId('data-testid Save dashboard button').click();
    await page.getByTestId('Dashboard settings Save Dashboard Modal Save refresh checkbox').check();
    await page.getByTestId('data-testid Save dashboard drawer button').click();
    await expect(page.getByTestId('data-testid Save dashboard drawer button')).toHaveCount(0, { timeout: 15_000 });

    // 5. 以不帶 refresh 參數的網址重新開啟，更新頻率與兩種視覺效果都一致
    await page.goto(`${GRAFANA}/d/${uid}`);
    await expect(page.getByTestId('data-testid Panel header Pod 記憶體')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('data-testid Panel header 假 GPU 可用份數')).toBeVisible();
    await expect(page.getByTestId('data-testid RefreshPicker interval button')).toHaveAttribute('aria-label', /1 minute/);
    await expect(page).toHaveURL(/refresh=1m/);
    const saved = await (await page.request.get(`${GRAFANA}/api/dashboards/uid/${uid}`)).json();
    expect(saved.dashboard.refresh).toBe('1m');
    expect(saved.dashboard.panels.map((p: { type: string; title: string }) => [p.type, p.title])).toEqual(
      panels.map((p) => [p.type, p.title]),
    );
  } finally {
    await page.request.delete(`${GRAFANA}/api/dashboards/uid/${uid}`);
  }
});
