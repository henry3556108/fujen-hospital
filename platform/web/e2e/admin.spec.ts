import { expect, loginAs, test } from './fixtures';

// A-03 第 1 項：Admin 建立標註群組、檢視 Account 與 Dashboard 頁（TC-A03-10，模擬 API）

test.describe('標註群組', () => {
  test('TC-A03-10 admin01 建立、修改、刪除標註群組各 1 次', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/admin');
    await page.getByRole('navigation', { name: '帳號管理分頁' }).getByRole('link', { name: '標註群組' }).click();
    const form = page.getByRole('form', { name: '新增標註群組' });
    await form.getByLabel('群組名稱（必填）').fill('肺結節標註組');
    await form.getByRole('checkbox', { name: /md01/ }).check();
    await form.getByRole('checkbox', { name: /ra01/ }).check();
    await form.getByRole('button', { name: '新增群組' }).click();
    await expect(page.getByText('已新增標註群組「肺結節標註組」')).toBeVisible();
    const row = page.getByRole('table', { name: '標註群組列表' }).getByRole('row', { name: /肺結節標註組/ });
    await expect(row).toContainText('md01、ra01');

    await row.getByRole('button', { name: '編輯 肺結節標註組' }).click();
    const edit = page.getByRole('form', { name: '編輯標註群組：肺結節標註組' });
    await edit.getByLabel('群組名稱（必填）').fill('肺結節第二輪');
    await edit.getByRole('button', { name: '儲存變更' }).click();
    await expect(page.getByText('已更新標註群組「肺結節第二輪」')).toBeVisible();

    await page.getByRole('button', { name: '刪除 肺結節第二輪' }).click();
    await page.getByRole('dialog', { name: '刪除標註群組' }).getByRole('button', { name: '確認刪除' }).click();
    await expect(page.getByText('已刪除標註群組「肺結節第二輪」')).toBeVisible();
    await expect(page.getByText('這個專案還沒有標註群組。')).toBeVisible();
  });
});

test.describe('Account 與 Dashboard', () => {
  test('TC-A03-10 admin01 檢視 Account 與 Dashboard；建立標註群組後 Dashboard 的數字跟著變', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/');
    await page.getByRole('navigation', { name: '功能選單' }).getByRole('link', { name: '帳號管理' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard（系統總覽）' })).toBeVisible();
    const overview = page.getByRole('list', { name: '平台總覽' });
    const value = (label: string) =>
      overview.getByRole('listitem').filter({ has: page.locator('.stat-tile__label', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-tile__value');
    await expect(value('帳號')).toHaveText('8');
    await expect(value('專案')).toHaveText('3');
    await expect(value('專案成員')).toHaveText('5');
    await expect(value('標註群組')).toHaveText('0');

    const tabs = page.getByRole('navigation', { name: '帳號管理分頁' });
    await tabs.getByRole('link', { name: 'Account 帳號' }).click();
    await expect(page.getByRole('heading', { name: 'Account（帳號）' })).toBeVisible();
    await expect(page.getByRole('table', { name: '帳號列表' }).getByRole('row')).toHaveCount(9);

    await tabs.getByRole('link', { name: '標註群組' }).click();
    const form = page.getByRole('form', { name: '新增標註群組' });
    await form.getByLabel('群組名稱（必填）').fill('Dashboard 驗證組');
    await form.getByRole('checkbox', { name: /md01/ }).check();
    await form.getByRole('button', { name: '新增群組' }).click();
    await expect(page.getByText('已新增標註群組「Dashboard 驗證組」')).toBeVisible();

    await tabs.getByRole('link', { name: 'Dashboard 總覽' }).click();
    await expect(value('標註群組')).toHaveText('1');
    const p1 = page.getByRole('table', { name: '各專案筆數' }).getByRole('row', { name: /P1-lung-ct/ });
    await expect(p1.getByRole('cell').nth(2)).toHaveText('1');
  });
});
