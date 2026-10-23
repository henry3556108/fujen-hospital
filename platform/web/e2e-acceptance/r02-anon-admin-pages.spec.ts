import { expect, test } from '@playwright/test';
import { note, sideNav } from './helpers';
import { shotUrl } from './r-common';

// M1 補拍 02：未登入開管理頁 10 次（通用條件：安全，TC-SS-02 的網頁部分）。
const TC = 'TC-SS-02';
const URLS: [string, string][] = [
  ['/admin', '網頁-01-admin-總覽'],
  ['/admin/projects', '網頁-02-admin-專案'],
  ['/admin/users', '網頁-03-admin-帳號'],
  ['/admin/members', '網頁-04-admin-members（舊網址）'],
  ['/admin/compute/gpu', '網頁-05-運算資源-GPU使用對照'],
  ['/admin/compute/groups', '網頁-06-運算資源-GPU群組'],
  ['/admin/compute/nodes', '網頁-07-運算資源-節點'],
  ['/admin/scheduling/gpu-dashboard', '網頁-08-gpu-dashboard（舊網址）'],
  ['/admin/monitoring', '網頁-09-系統監控'],
  ['/admin/fhir/resources', '網頁-10-資料交換-FHIR'],
];

test('M1 補拍 02 未登入開管理頁 10 次（TC-SS-02 網頁）', async ({ browser }) => {
  const ctx = await browser.newContext(); // 沒有登入過的新視窗
  const page = await ctx.newPage();
  let redirected = 0;
  let entered = 0;
  for (const [p, name] of URLS) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    const toLogin = /\/login$/.test(page.url());
    const ui =
      (await page.getByRole('heading', { name: '登入', level: 1 }).isVisible()) &&
      (await page.getByText('使用醫院統一身分（單一登入）登入，將前往登入頁面。').isVisible()) &&
      (await page.getByRole('button', { name: '登入' }).isVisible());
    const inside = (await sideNav(page).count()) > 0;
    if (toLogin && ui) redirected++;
    if (inside) entered++;
    await shotUrl(page, TC, name);
    note(TC, `網頁 未登入開 ${p} → 網址 ${new URL(page.url()).pathname}，登入頁 ${toLogin && ui ? '是' : '否'}，進入管理頁 ${inside ? '是' : '否'}`);
  }
  note(TC, `網頁 未登入開管理頁 10 次：導向登入頁 ${redirected}/10，成功進入 ${entered}/10`);
  expect(redirected).toBe(10);
  expect(entered).toBe(0);
  await ctx.close();
});
