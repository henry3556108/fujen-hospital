import { expect, loginAs, navLabels, test } from './fixtures';

// TC-D02-03 示範可重現：依教育訓練教材的無程式碼流程，逐步操作網頁。
// 目前可示範的是平台管理段（WP1）；其餘段落的頁面由其他工作包開發中，以 test.fixme 標出並註明所屬工作包，
// 合併後把 fixme 換成實際步驟。教材步驟見 docs/delivery/教育訓練示範流程.md。
test.describe('TC-D02-03 教育訓練示範流程', () => {
  test('段落 1：Admin 建立專案、指派成員；成員登入後看到對應入口', async ({ page }) => {
    const project = `DEMO-${Date.now()}`;
    await loginAs(page, 'admin01');
    await page.goto('/');
    // 全程用頁面上的連結操作（與教材一致）；測試模式的模擬 API 在重新載入頁面時會重設資料
    await page.getByRole('navigation', { name: '功能選單' }).getByRole('link', { name: '帳號管理' }).click();
    await page.getByRole('link', { name: '專案', exact: true }).click();

    const form = page.getByRole('form', { name: '新增專案' });
    await form.getByLabel('專案名稱（必填）').fill(project);
    await form.getByLabel('說明').fill('教育訓練示範');
    await form.getByRole('button', { name: '新增專案' }).click();
    await expect(page.getByText(`已新增專案「${project}」`)).toBeVisible();
    await expect(page.getByRole('table', { name: '專案列表' }).getByText(project)).toBeVisible();

    await page.getByRole('link', { name: '專案成員' }).click();
    const members = page.getByRole('form', { name: '設定專案成員' });
    await members.getByLabel('專案').selectOption({ label: project });
    await members.getByLabel('帳號').selectOption({ label: 'md01' });
    await members.getByLabel('角色').selectOption({ index: 0 });
    await members.getByRole('button', { name: '儲存成員設定' }).click();
    await expect(page.getByRole('table', { name: '本次設定的成員' })).toContainText('md01');

    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
    await page.getByLabel('測試帳號').selectOption('md01');
    await page.getByRole('button', { name: '登入' }).click();
    const labels = await navLabels(page);
    expect(labels).not.toContain('帳號管理');
    expect(labels.length).toBeGreaterThan(0);
  });

  test.fixme('段落 2：上傳影像與 CSV、檢視統計（等網頁補齊工作包的資料頁面）', async () => {});
  test.fixme('段落 3：影像標註與自動標註（等 WP5a）', async () => {});
  test.fixme('段落 4：建立訓練、匯出模型、部署與推論（等 WP5b）', async () => {});
  test.fixme('段落 5：FHIR 資料交換設定（等 WP6）', async () => {});
  test.fixme('段落 6：LLM Playground 與知識庫（等 WP7）', async () => {});
});
