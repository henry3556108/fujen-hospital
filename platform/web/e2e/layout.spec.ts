import { expect, expectNoHorizontalOverflow, loginAs, snap, test } from './fixtures';

// TC-A02-08：主要頁面在桌機（1280×800）與手機（375×812）不破版，並截圖存檔。
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '375x812', width: 375, height: 812 },
];

const ADMIN_PAGES: { name: string; path: string; heading: string }[] = [
  { name: 'home', path: '/', heading: '首頁' },
  { name: 'admin-projects', path: '/admin/projects', heading: '帳號管理' },
  { name: 'admin-users', path: '/admin/users', heading: '帳號管理' },
  { name: 'admin-members', path: '/admin/members', heading: '帳號管理' },
  { name: 'admin-scheduling', path: '/admin/scheduling', heading: '共享排程設定' },
  { name: 'data', path: '/data', heading: '數據管理' },
  { name: 'labeling', path: '/labeling', heading: '影像標註' },
  { name: 'auto-labeling', path: '/auto-labeling', heading: '自動影像分類標註' },
  { name: 'training', path: '/training', heading: '建模管理' },
  { name: 'deployment', path: '/deployment', heading: 'AI 模型部署' },
  { name: 'inference', path: '/inference', heading: '推論服務管理' },
  { name: 'llm', path: '/llm', heading: 'LLM No-code 開發' },
];

for (const vp of VIEWPORTS) {
  test.describe(`TC-A02-08 版面 ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`admin 主要頁面不破版並截圖（${vp.name}）`, async ({ page }, testInfo) => {
      await loginAs(page, 'admin01');
      for (const p of ADMIN_PAGES) {
        await page.goto(p.path);
        await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await snap(page, testInfo.project.name, `${vp.name}/${p.name}`);
      }
    });

    test(`登入頁與無權限頁不破版並截圖（${vp.name}）`, async ({ page }, testInfo) => {
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/login`);

      await loginAs(page, 'vw01');
      await page.goto('/training');
      await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/access-denied`);
    });

    test(`錯誤訊息與確認視窗不破版（${vp.name}）`, async ({ page }, testInfo) => {
      await loginAs(page, 'admin01');
      await page.goto('/admin/projects');
      await page.getByRole('button', { name: '新增專案' }).click();
      await expect(page.getByRole('alert')).toContainText('專案名稱：不可空白');
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/admin-projects-422`);
      await page.getByRole('button', { name: '刪除 P3-llm' }).click();
      await expect(page.getByRole('dialog', { name: '刪除專案' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/confirm-dialog`);
    });
  });
}

test.describe('手機選單', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('375 寬時以「選單」按鈕展開功能選單，viewer 只看到允許的入口', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/');
    const menu = page.getByRole('button', { name: '選單' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    const nav = page.getByRole('navigation', { name: '功能選單' });
    await expect(nav.getByRole('link')).toHaveText(['數據管理', 'AI 模型部署', '推論服務管理']);
    await nav.getByRole('link', { name: '推論服務管理' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '推論服務管理' })).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('深色模式', () => {
  test('prefers-color-scheme: dark 時套用深色 Token', async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginAs(page, 'admin01');
    await page.goto('/admin/projects');
    await expect(page.getByRole('table', { name: '專案列表' })).toBeVisible();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(15, 19, 24)'); // --primitive-neutral-950
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'dark/admin-projects');
    await page.goto('/');
    await snap(page, testInfo.project.name, 'dark/home');
    await page.goto('/data');
    await snap(page, testInfo.project.name, 'dark/placeholder');
  });

  test('手動切換深色後重新載入仍保留，且可切回淺色', async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await loginAs(page, 'admin01');
    await page.goto('/');
    await page.getByLabel('色彩主題').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(15, 19, 24)');
    await snap(page, testInfo.project.name, 'dark/home-manual');
    await page.getByLabel('色彩主題').selectOption('light');
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light).toBe('rgb(246, 248, 250)'); // --primitive-neutral-50
  });
});
