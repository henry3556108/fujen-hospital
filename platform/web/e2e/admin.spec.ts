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
