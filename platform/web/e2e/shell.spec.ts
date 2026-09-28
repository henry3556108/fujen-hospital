import { ENTRY_LABELS, expect, loginAs, navLabels, test } from './fixtures';

test.describe('登入', () => {
  test('未登入導向登入頁，測試模式選帳號登入後進入外殼', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
    await page.getByLabel('測試帳號').selectOption('vw01');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.getByRole('button', { name: '登出' })).toBeVisible();
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
  });

  test('API 回 401 時回到登入頁並說明原因', async ({ page }) => {
    await loginAs(page, 'ghost-user'); // 模擬 API 不認得的帳號 → 401
    await page.goto('/admin/projects');
    await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
    await expect(page.getByText('登入已失效，請重新登入。')).toBeVisible();
  });
});

test.describe('功能入口', () => {
  test('TC-A02-01 admin01 逐一點擊 8 個入口，成功率 100%', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: '功能選單' });
    let ok = 0;
    for (const label of ENTRY_LABELS) {
      await nav.getByRole('link', { name: label }).click();
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(label);
      await expect(page.getByRole('heading', { name: '無法存取此功能' })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
      ok++;
    }
    expect(ok).toBe(8);
  });

  const expected: Record<string, string[]> = {
    vw01: ['數據管理', 'AI 模型部署', '推論服務管理'],
    md01: ['數據管理', '影像標註', '自動影像分類標註', 'AI 模型部署', '推論服務管理'],
    ca01: ['數據管理', '建模管理', 'AI 模型部署', '推論服務管理', 'LLM No-code 開發'],
    admin01: ENTRY_LABELS,
  };
  for (const [username, labels] of Object.entries(expected)) {
    test(`TC-A02-02 ${username} 看到的入口與權限一致`, async ({ page }) => {
      await loginAs(page, username);
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: '功能選單' }).getByRole('link').first()).toBeVisible();
      expect(await navLabels(page)).toEqual(labels);
    });
  }

  test('TC-A02-04 / TC-A03-05 vw01 直接輸入隱藏入口網址 → 無權限頁與文字原因', async ({ page }) => {
    await loginAs(page, 'vw01');
    for (const [path, perm] of [
      ['/training', 'Training'],
      ['/labeling', 'Labeling'],
      ['/llm', 'Coding'],
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
      await expect(page.getByText(new RegExp(`沒有 ${perm} 權限`))).toBeVisible();
    }
  });

  test('TC-A03-03 非 Admin 直接進入帳號管理 → 無權限提示', async ({ page }) => {
    await loginAs(page, 'pi01');
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
    await expect(page.getByText(/需要 Admin 帳號類型/)).toBeVisible();
  });
});

test.describe('鍵盤操作', () => {
  test('Tab 先到「跳到主要內容」，且有可見 focus 外框', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: '功能選單' })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: '跳到主要內容' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    const outline = await skip.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });
});
