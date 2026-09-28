import { expect, test, type Page } from '@playwright/test';

// 種子帳號的本機測試密碼，與 platform/api/app/seed.py、keycloak realm 設定相同
const PASSWORDS: Record<string, string> = { admin01: 'Admin01-dev!' };
const DEV_PASSWORD = 'Dev-Passw0rd!';

async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '登入' }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(PASSWORDS[username] ?? DEV_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('navigation', { name: '功能選單' })).toBeVisible({ timeout: 15_000 });
}

async function entryLabels(page: Page) {
  const nav = page.getByRole('navigation', { name: '功能選單' });
  return (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim());
}

test('TC-A02-01 admin01 經 Keycloak 登入，看到全部 8 個入口', async ({ page }) => {
  await login(page, 'admin01');
  const labels = await entryLabels(page);
  for (const name of ['帳號管理', '數據管理', '影像標註', '自動影像分類標註', '建模管理', 'AI 模型部署', '推論服務管理', 'LLM No-code 開發']) {
    expect(labels.some((l) => l.includes(name)), name).toBe(true);
  }
});

test('TC-A02-02 vw01（Viewer）只看到 project 與 prediction 對應的入口', async ({ page }) => {
  await login(page, 'vw01');
  const labels = await entryLabels(page);
  for (const shown of ['數據管理', 'AI 模型部署', '推論服務管理']) expect(labels.some((l) => l.includes(shown)), shown).toBe(true);
  for (const hidden of ['帳號管理', '影像標註', '建模管理', 'LLM No-code 開發']) expect(labels.some((l) => l.includes(hidden)), hidden).toBe(false);
});

test('TC-A03-05 vw01 直接輸入網址進建模管理，看到文字說明的拒絕頁', async ({ page }) => {
  await login(page, 'vw01');
  await page.goto('/training');
  await expect(page.getByText(/沒有.*權限|無法存取|權限不足/).first()).toBeVisible();
});
