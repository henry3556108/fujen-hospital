import { expect as baseExpect, loginAs, test } from './fixtures';

// 這台開發機由多個工作共用，負載高時 dev server 首次編譯頁面較慢：等待上限放寬到 15 秒
const expect = baseExpect.configure({ timeout: 15_000 });

test.describe('共享排程設定', () => {
  test('TC-A02-07 修改設定 3 次，每次重新載入後一致', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling');
    await expect(page.getByTestId('current-replicas')).toHaveText('4');
    const changes = [
      ['2', '30'],
      ['8', '120'],
      ['16', '1440'],
    ];
    let consistent = 0;
    for (const [replicas, timeout] of changes) {
      await page.getByLabel(/^時間片份數/).fill(replicas);
      await page.getByLabel(/^工作時限/).fill(timeout);
      await page.getByRole('button', { name: '儲存設定' }).click();
      await expect(page.getByText(`已儲存：時間片 ${replicas} 份、工作時限 ${timeout} 分鐘`)).toBeVisible();

      await page.reload();
      await expect(page.getByTestId('current-replicas')).toHaveText(replicas);
      await expect(page.getByTestId('current-timeout')).toHaveText(timeout);
      await expect(page.getByLabel(/^時間片份數/)).toHaveValue(replicas);
      await expect(page.getByLabel(/^工作時限/)).toHaveValue(timeout);
      consistent++;
    }
    expect(consistent).toBe(3);
  });

  test('超出範圍的值顯示欄位錯誤，設定不變', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling');
    await page.getByLabel(/^時間片份數/).fill('0');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByRole('alert')).toContainText('時間片份數：數值超出允許範圍');
    await page.reload();
    await expect(page.getByTestId('current-replicas')).toHaveText('4');
  });

  test('TC-A03-03 非 Admin 直接輸入網址被擋', async ({ page }) => {
    await loginAs(page, 'pi01');
    for (const path of ['/admin/scheduling', '/admin/scheduling/groups', '/admin/scheduling/gpu-dashboard']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
    }
  });
});

test.describe('GPU 群組與叢集', () => {
  test('TC-C01-02 建立 2 個群組，重新載入後一致', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling/groups');
    const form = page.getByRole('form', { name: '新增 GPU 群組' });
    for (const [name, pool, count] of [
      ['team-a', 'gpu-exclusive', '2'],
      ['team-b', 'gpu-shared', '1'],
    ]) {
      await form.getByLabel(/^群組名稱/).fill(name);
      await form.getByLabel('GPU 池').selectOption(pool);
      await form.getByLabel('GPU 數量').fill(count);
      await form.getByRole('button', { name: '新增群組' }).click();
      await expect(page.getByText(`已新增 GPU 群組「${name}」`)).toBeVisible();
    }
    await page.reload();
    const table = page.getByRole('table', { name: 'GPU 群組列表' });
    await expect(table.getByRole('row', { name: /^team-a/ })).toContainText('獨占');
    await expect(table.getByRole('row', { name: /^team-b/ })).toContainText('共享（時間片）');
    await expect(table.getByRole('row')).toHaveCount(5);
  });

  test('TC-C01-01 節點清單列出所有節點與 GPU 數', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling/nodes');
    const table = page.getByRole('table', { name: '叢集節點列表' });
    await expect(table.getByRole('row')).toHaveCount(6);
    await expect(table.getByRole('row', { name: /^ai-platform-worker3/ })).toContainText('gpu-exclusive');
    await expect(page.getByRole('list', { name: '叢集摘要' })).toContainText('可排程 GPU 份數6');
  });
});

test.describe('專案工作', () => {
  test('TC-A02-05 送出訓練工作：排隊→執行→完成；Dashboard 在執行期間顯示該工作', async ({ page, context }) => {
    test.setTimeout(60_000); // 模擬工作真的要跑幾秒
    await loginAs(page, 'admin01');
    await page.goto('/training');
    await page.getByRole('link', { name: /專案工作/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: '專案工作' })).toBeVisible();

    const form = page.getByRole('form', { name: '送出工作' });
    await form.getByLabel(/^執行秒數/).fill('6');
    await form.getByRole('button', { name: '送出工作' }).click();
    await expect(page.getByText('已送出工作 1，進入佇列 gpu-exclusive')).toBeVisible();
    const row = page.getByRole('table', { name: '工作列表' }).getByRole('row', { name: /^1 / });
    await expect(row).toContainText('執行中');

    // TC-C01-04：同一個瀏覽器分頁的模擬狀態；Dashboard 的 Project ID、Training ID、使用者與工作一致
    await page.goto('/admin/scheduling/gpu-dashboard');
    const running = page.getByRole('table', { name: '執行中的 GPU 工作' }).getByRole('row').nth(1);
    await expect(running).toContainText('ai-platform-worker3');
    await expect(running.getByRole('cell')).toHaveText(['ai-platform-worker3', '0', '0', 'P1-lung-ct', '1', '1', '1', 'admin01', /^job-1-/]);

    await page.goto('/training/jobs');
    await expect(page.getByRole('table', { name: '工作列表' }).getByRole('row', { name: /^1 / })).toContainText('已完成', { timeout: 15_000 });
    await expect(page.getByText('沒有進行中的工作。')).toBeVisible();
    expect(context.pages()).toHaveLength(1);
  });

  test('TC-C01-08 取消排隊中的工作後，下一件照順序執行', async ({ page }) => {
    test.setTimeout(60_000); // 模擬工作真的要跑幾秒
    await loginAs(page, 'pi01');
    await page.goto('/training/jobs');
    const form = page.getByRole('form', { name: '送出工作' });
    await form.getByLabel(/^執行秒數/).fill('5');
    for (let i = 1; i <= 4; i++) {
      await form.getByRole('button', { name: '送出工作' }).click();
      await expect(page.getByText(`已送出工作 ${i}，進入佇列 gpu-exclusive`)).toBeVisible();
    }
    const table = page.getByRole('table', { name: '工作列表' });
    await expect(table.getByRole('row', { name: /^3 / })).toContainText('排隊中');
    await expect(table.getByRole('row', { name: /^4 / })).toContainText('排隊中');
    await table.getByRole('button', { name: '取消工作 3' }).click();
    await page.getByRole('dialog', { name: '取消工作' }).getByRole('button', { name: '確定取消工作' }).click();
    await expect(table.getByRole('row', { name: /^3 / })).toContainText('已取消');
    await expect(table.getByRole('row', { name: /^4 / })).toContainText('已完成', { timeout: 20_000 });
    await expect(table.getByRole('row', { name: /^1 / })).toContainText('已完成');
    await expect(table.getByRole('row', { name: /^2 / })).toContainText('已完成');
  });

  test('TC-A03-05 沒有 Training 權限的帳號直接輸入網址被擋', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/training/jobs');
    await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
    await expect(page.getByText(/沒有 Training 權限/)).toBeVisible();
  });
});

test.describe('監控儀表板', () => {
  test('入口頁連到 Grafana、Prometheus、Alertmanager、Mailpit', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling/monitoring');
    const links = page.getByRole('list', { name: '監控工具' }).getByRole('link');
    await expect(links).toHaveCount(4);
    await expect(links.first()).toHaveAttribute('href', /^http:\/\/127\.0\.0\.1:33000$/);
    await expect(links.first()).toHaveAttribute('target', '_blank');
  });
});

test.describe('磚與卡片對齊', () => {
  // `.section > * + *` 曾讓格線裡第 2 個起的磚往下掉約 16px（TC-C01-01、TC-C01-04 的截圖）
  async function tops(list: import('@playwright/test').Locator) {
    await expect(list.getByRole('listitem').first()).toBeVisible();
    const boxes = await list.locator(':scope > li').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    return boxes;
  }

  test('TC-C01-01 叢集節點的摘要磚同一列頂端對齊', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling/nodes');
    const t = await tops(page.getByRole('list', { name: '叢集摘要' }));
    expect(t.length).toBeGreaterThan(1);
    expect(new Set(t).size, `頂端：${t.join(', ')}`).toBe(1);
  });

  test('TC-C01-04 GPU Dashboard 的卡片同一列頂端對齊', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/scheduling/gpu-dashboard');
    const t = await tops(page.getByRole('list', { name: 'GPU 使用狀況' }));
    expect(t.length).toBe(3);
    expect(new Set(t).size, `頂端：${t.join(', ')}`).toBe(1);
  });

  test('Admin Dashboard 的總覽磚同一列頂端對齊', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin/dashboard');
    const t = await tops(page.getByRole('list', { name: '平台總覽' }));
    expect(t.length).toBe(8);
    const firstRow = t.filter((y) => y === t[0]);
    expect(firstRow.length, `頂端：${t.join(', ')}`).toBeGreaterThan(1);
  });
});
