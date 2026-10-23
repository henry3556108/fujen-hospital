import { expect, test } from '@playwright/test';
import { note, shot } from './helpers';
import { freshPage, headerUser, kcSubmit, logout, shotUrl, toKeycloak } from './r-common';

// M1 補拍 01：登入與登出（TC-SS-01）。8 個帳號各開新視窗登入 1 次、登出。
const TC = 'TC-SS-01';
const PW: Record<string, string> = { admin01: 'Admin01-dev!' };
const EXPECT: [string, string][] = [
  ['admin01', 'admin01（系統管理者）'],
  ['pi01', 'pi01（計畫主持人）'],
  ['md01', 'md01（醫師）'],
  ['ra01', 'ra01（研究助理）'],
  ['ca01', 'ca01（程式開發助理）'],
  ['vw01', 'vw01（檢視者）'],
  ['user01', 'user01（一般使用者）'],
  ['user02', 'user02（一般使用者）'],
];

test('M1 補拍 01 登入與登出 8 個帳號（TC-SS-01）', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  let okCount = 0;
  for (const [i, [user, header]] of EXPECT.entries()) {
    const { ctx, page } = await freshPage(browser);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    if (i === 0) await shotUrl(page, TC, '01-平台登入頁');
    await toKeycloak(page);
    if (i === 0) await shotUrl(page, TC, '02-Keycloak登入頁');
    await kcSubmit(page, user, PW[user] ?? 'Dev-Passw0rd!');
    await expect(page.locator('.topbar__username')).toHaveText(user, { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    const h = await headerUser(page);
    const noProject = (await page.locator('.topbar__tools').getByText('尚未加入任何專案').count()) > 0;
    const name = i === 0 ? '03-admin01-登入後' : `${String(i + 4).padStart(2, '0')}-${user}-登入後`;
    await shotUrl(page, TC, name);
    await logout(page);
    await expect(page).toHaveURL(/\/login$/);
    if (i === 0) await shotUrl(page, TC, '04-admin01-登出後');
    const pass = h === header && (!user.startsWith('user') || noProject);
    if (pass) okCount++;
    note(TC, `${user}：右上角「${h}」${user.startsWith('user') ? `，目前專案處「${noProject ? '尚未加入任何專案' : '（未顯示）'}」` : ''}，登出後回到 /login；${pass ? '成功' : '不符'}`);
    await ctx.close();
  }
  note(TC, `登入成功 ${okCount}/8，登出後回到登入頁 8/8`);
  expect(okCount).toBe(8);
});
