// WP6 FHIR 管理頁（C-03）。模擬 API 的狀態在整頁重新載入時會重設，所以「重新載入」以站內導覽離開再回來，
// 頁面會重新向 API 讀取設定。路由修改在真的 Gateway 上生效，由 platform/acceptance/test_tc_c03.py 驗證。
import { expect, expectNoHorizontalOverflow, loginAs, snap, test } from './fixtures';

test('TC-C03-03 在網頁管理介面查看並修改路由 3 次，重新載入一致', async ({ page }, testInfo) => {
  await loginAs(page, 'admin01');
  await page.goto('/fhir/gateway');
  const table = page.getByRole('table', { name: 'Gateway 路由' });
  await expect(table.getByRole('row', { name: /fhir-rest/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /dicomweb/ })).toBeVisible();
  await snap(page, testInfo.project.name, 'fhir-gateway');

  const settings: [boolean, string[], string][] = [
    [false, ['GET', 'HEAD'], '30'],
    [true, ['GET', 'HEAD', 'POST'], '60'],
    [true, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], '120'],
  ];
  const tabs = page.getByRole('navigation', { name: 'FHIR 分頁' });
  for (const [enabled, methods, threshold] of settings) {
    const form = page.getByRole('form', { name: '修改路由 fhir-rest' });
    await form.getByRole('checkbox', { name: '啟用這條路由' }).setChecked(enabled);
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      await form.getByRole('checkbox', { name: m, exact: true }).setChecked(methods.includes(m));
    }
    await form.getByLabel(/流量告警門檻/).fill(threshold);
    await form.getByRole('button', { name: '儲存路由設定' }).click();
    await expect(page.getByText(/已儲存路由「fhir-rest」/)).toBeVisible();

    await tabs.getByRole('link', { name: '資源' }).click();
    await expect(page.getByRole('list', { name: '資源筆數' })).toBeVisible();
    await tabs.getByRole('link', { name: 'Gateway 路由' }).click();
    const row = page.getByRole('table', { name: 'Gateway 路由' }).getByRole('row', { name: /fhir-rest/ });
    await expect(row.getByRole('cell').nth(2)).toHaveText(methods.join(' '));
    await expect(row.getByRole('cell').nth(4)).toHaveText(enabled ? '啟用' : '停用');
    await expect(row.getByRole('cell').nth(5)).toHaveText(threshold);
    const reloaded = page.getByRole('form', { name: '修改路由 fhir-rest' });
    await expect(reloaded.getByRole('checkbox', { name: '啟用這條路由' })).toBeChecked({ checked: enabled });
    await expect(reloaded.getByLabel(/流量告警門檻/)).toHaveValue(threshold);
  }
});

test('TC-C03-10 Resource 關聯圖與 API 資料差異 0', async ({ page }, testInfo) => {
  await loginAs(page, 'admin01');
  await page.goto('/fhir/graph');
  await page.getByLabel('病歷號').fill('SYN-42-0001');
  await page.getByRole('button', { name: '顯示關聯圖' }).click();
  const svg = page.getByTestId('fhir-graph');
  await expect(svg).toBeVisible();

  // 在頁面內向同一個 API 取資料（經 MSW），和畫出來的節點、邊逐一比對
  const api = await page.evaluate(async () => {
    const res = await fetch('/api/projects/1/fhir/graph?patient=SYN-42-0001', {
      headers: { Authorization: 'Bearer test-token:admin01' },
    });
    return (await res.json()) as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
  });
  const drawnNodes = await svg.locator('[data-node-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')));
  const drawnEdges = await svg.locator('[data-edge]').evaluateAll((els) => els.map((e) => e.getAttribute('data-edge')));
  expect(drawnNodes.sort()).toEqual(api.nodes.map((n) => n.id).sort());
  expect(drawnEdges.sort()).toEqual(api.edges.map((e) => `${e.from}->${e.to}`).sort());
  expect(api.nodes.length).toBe(4);

  // 每個節點都在畫面內、彼此不重疊
  const boxes = await svg.locator('[data-node-id] circle').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `節點 ${i} 與 ${j} 重疊`).toBe(false);
    }
  }
  await expectNoHorizontalOverflow(page);
  await snap(page, testInfo.project.name, 'fhir-graph');
});

test('FHIR 各分頁可開啟且不破版', async ({ page }, testInfo) => {
  await loginAs(page, 'admin01');
  const pages: [string, string][] = [
    ['/fhir/resources', 'Patient 列表'],
    ['/fhir/sources', '來源列表'],
    ['/fhir/schedules', '排程列表'],
    ['/fhir/alerts', '流量告警'],
  ];
  for (const [path, table] of pages) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: '醫療資料交換（FHIR）' })).toBeVisible();
    await expect(page.getByRole('table', { name: table })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, `fhir-${path.split('/').pop()}`);
  }
});

test('非 Admin 進入 FHIR 管理頁看到拒絕說明', async ({ page }) => {
  await loginAs(page, 'pi01');
  await page.goto('/fhir/gateway');
  await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
});
