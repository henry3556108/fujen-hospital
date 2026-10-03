import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { EDGE_MISSING, edgeInstalled } from './edge';

export const test = base.extend<{ edgeGuard: void }>({
  // auto fixture 先於 page 建立，Edge 不存在時在啟動瀏覽器前就 skip。
  edgeGuard: [
    async ({}, use, testInfo) => {
      if (testInfo.project.name === 'msedge' && !edgeInstalled()) testInfo.skip(true, EDGE_MISSING);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

const AUTH_KEY = '__AI_PLATFORM_TEST_AUTH__.user';

/** 以 test 登入模式預先登入（每次載入頁面前寫入 localStorage）。 */
export async function loginAs(page: Page, username: string) {
  await page.addInitScript(
    ([key, user]) => {
      // switchUser() 在同一個分頁換人：以 sessionStorage 記住換成誰（模擬狀態也在同一個分頁的 sessionStorage）
      const switched = window.sessionStorage.getItem('e2e-switch-user');
      if (!window.sessionStorage.getItem('e2e-logged-out')) window.localStorage.setItem(key, switched ?? user);
    },
    [AUTH_KEY, username],
  );
}

/** 同一個分頁改以另一個帳號登入（例如分享模型後換同事 md01 看），模擬的資料保留；之後 goto 生效。 */
export async function switchUser(page: Page, username: string) {
  await page.evaluate(([key, user]) => {
    window.sessionStorage.setItem('e2e-switch-user', user);
    window.localStorage.setItem(key, user);
  }, [AUTH_KEY, username]);
}

export const ENTRY_LABELS = [
  '帳號管理',
  '數據管理',
  '影像標註',
  '自動影像分類標註',
  '建模管理',
  'AI 模型部署',
  '推論服務管理',
  'LLM No-code 開發',
];

export async function navLabels(page: Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: '功能選單' });
  return (await nav.getByRole('link').allTextContents()).map((s) => s.trim());
}

/** 截圖存到 platform/web/test-results/screenshots/<project>/<name>.png */
export async function snap(page: Page, project: string, name: string) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const file = join(root, 'test-results', 'screenshots', project, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
}

/** 頁面不可出現水平捲動（破版判定） */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `水平溢出 ${scrollWidth - clientWidth}px`).toBeLessThanOrEqual(clientWidth);
}
