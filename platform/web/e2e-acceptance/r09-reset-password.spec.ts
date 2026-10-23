import { expect, test, type Page } from '@playwright/test';
import { login, note, shot } from './helpers';
import { psql } from './ops';
import { auditFilter, dbDump, freshPage, gotoAdmin, headerUser, loginFails, logout, maxAuditId, ok } from './r-common';

// M1 補拍 09：重設密碼 3 次（TC-A03-08）。演練帳號 KIT-A-pw，不動種子帳號；最後刪除。
const TC = 'TC-A03-08';
const U = 'KIT-A-pw';
const PWS = ['Kit-A-Init-2026!', 'Kit-A-Reset-1!', 'Kit-A-Reset-2!', 'Kit-A-Reset-3!'];

async function removeUser(page: Page) {
  await gotoAdmin(page, 'Account 帳號');
  // 等帳號列表載入（已在帳號頁時點側欄不會重新導覽）
  await expect(page.getByRole('table', { name: '帳號列表' }).getByRole('rowheader', { name: 'admin01', exact: true })).toBeVisible();
  const del = page.getByRole('button', { name: `刪除 ${U}`, exact: true });
  if (!(await del.count())) return false;
  await del.click();
  await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
  await ok(page, `已刪除帳號「${U}」`);
  return true;
}

test('M1 補拍 09 重設密碼 3 次（TC-A03-08）', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const { ctx, page } = await freshPage(browser);
  await login(page, 'admin01');
  await removeUser(page); // 上一輪殘留
  const startId = maxAuditId();
  let resetOk = 0;
  let newOk = 0;
  let oldOk = 0;
  try {
    const form = page.getByRole('form', { name: '新增帳號' });
    await form.getByLabel('帳號（必填）').fill(U);
    await form.getByLabel('初始密碼（必填）').fill(PWS[0]);
    await form.getByLabel('帳號類型').selectOption({ label: 'User' });
    await form.getByRole('button', { name: '新增帳號' }).click();
    await ok(page, `已新增帳號「${U}」`);
    await shot(page, TC, '01-新增KIT-A-pw');

    for (let round = 1; round <= 3; round++) {
      const oldPw = PWS[round - 1];
      const newPw = PWS[round];
      const base = (round - 1) * 3 + (round === 1 ? 1 : 2); // 第 1 輪 02～05，第 2 輪 06～08，第 3 輪 09～11
      await page.bringToFront();
      await page.getByRole('button', { name: `重設 ${U} 的密碼`, exact: true }).click();
      const rf = page.getByRole('form', { name: `重設密碼：${U}` });
      await expect(rf.getByRole('heading', { name: `重設密碼：${U}` })).toBeVisible();
      if (round === 1) {
        await rf.scrollIntoViewIfNeeded();
        await shot(page, TC, '02-重設密碼表單');
      }
      await rf.getByLabel('新密碼（必填）').fill(newPw);
      await rf.getByRole('button', { name: '確認重設' }).click();
      await ok(page, `已重設「${U}」的密碼`);
      resetOk++;
      const n1 = round === 1 ? 3 : base + 1;
      await shot(page, TC, `${String(n1).padStart(2, '0')}-第${round}次重設訊息`);

      const w = await freshPage(browser);
      let oldFailed = false;
      try {
        await loginFails(w.page, U, oldPw);
        oldFailed = true;
      } catch {
        oldOk++;
      }
      await shot(w.page, TC, `${String(n1 + 1).padStart(2, '0')}-第${round}次舊密碼失敗`);
      // 同一個 Keycloak 登入頁改用新密碼
      await w.page.locator('#username').fill(U);
      await w.page.locator('#password').fill(newPw);
      await w.page.locator('#kc-login').click();
      await expect(w.page.locator('.topbar__username')).toHaveText(U, { timeout: 15_000 });
      const h = await headerUser(w.page);
      if (h === U) newOk++; // 未加入專案：頂端只顯示帳號
      await shot(w.page, TC, `${String(n1 + 2).padStart(2, '0')}-第${round}次新密碼成功`);
      await logout(w.page);
      await w.ctx.close();
      note(TC, `第 ${round} 次：重設為 ${newPw} 成功；舊密碼 ${oldPw} 登入${oldFailed ? '失敗（使用者名稱或密碼無效。）' : '成功（不符）'}；新密碼登入成功，右上角「${h}」`);
    }

    await page.bringToFront();
    const rows = await auditFilter(page, '帳號（account）', 4);
    await shot(page, TC, '12-稽核紀錄-重設3筆');
    note(TC, `稽核紀錄頁最新 4 筆：${rows.map((r) => `${r[0]} ${r[4]} ${r[5]}`).join('；')}`);
  } finally {
    const removed = await removeUser(page);
    await shot(page, TC, '13-刪除KIT-A-pw');
    note(TC, removed ? `已刪除演練帳號 ${U}` : `${U} 不存在，不需刪除`);
  }
  dbDump(TC, 'TC-A03-08-audit', `select id, actor, at, category, action, target, result, source_ip from audit_log where id > ${startId} and category = 'account' order by id;`);
  const resets = psql(`select count(*) from audit_log where id > ${startId} and category='account' and action='reset_password' and result='success'`);
  note(TC, `重設 ${resetOk}/3、新密碼登入 ${newOk}/3、舊密碼登入 ${oldOk}/3；稽核 reset_password ${resets} 筆`);
  expect(resetOk).toBe(3);
  expect(newOk).toBe(3);
  expect(oldOk).toBe(0);
  expect(resets).toBe('3');
  await ctx.close();
});
