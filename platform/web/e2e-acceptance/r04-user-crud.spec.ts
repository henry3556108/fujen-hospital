import { expect, test, type Page } from '@playwright/test';
import { login, note, shot } from './helpers';
import { psql } from './ops';
import { auditFilter, dbDump, freshPage, gotoAdmin, headerUser, loginFails, loginWith, maxAuditId, ok } from './r-common';

// M1 補拍 04：帳號新增、修改、刪除各 3 次（TC-A03-02），另驗 Keycloak 同步。演練帳號 KIT-A-u1～u3，最後刪除。
const TC = 'TC-A03-02';
const NAMES = ['KIT-A-u1', 'KIT-A-u2', 'KIT-A-u3'];
const INIT = 'Kit-A-Init-2026!';
const SEED = ['admin01', 'pi01', 'md01', 'ra01', 'ca01', 'vw01', 'user01', 'user02'];

async function deleteUser(page: Page, n: string) {
  await page.getByRole('button', { name: `刪除 ${n}`, exact: true }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: '確認刪除' }).click();
  await ok(page, `已刪除帳號「${n}」`);
}

test('M1 補拍 04 帳號新增修改刪除（TC-A03-02）', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { ctx, page } = await freshPage(browser);
  await login(page, 'admin01');
  await gotoAdmin(page, 'Account 帳號');
  const table = page.getByRole('table', { name: '帳號列表' });
  const names = async () => (await table.locator('tbody th').allInnerTexts()).map((s) => s.trim());
  await expect(table.getByRole('rowheader', { name: 'admin01', exact: true })).toBeVisible();
  for (const n of NAMES) if ((await names()).includes(n)) await deleteUser(page, n); // 上一輪殘留
  const before = await names();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, TC, '01-帳號清單-8個');
  note(TC, `開始前帳號 ${before.length} 個：${before.join('、')}`);
  const startId = maxAuditId();
  let success = 0;

  for (const [i, n] of NAMES.entries()) {
    const form = page.getByRole('form', { name: '新增帳號' });
    await form.getByLabel('帳號（必填）').fill(n);
    await form.getByLabel('初始密碼（必填）').fill(INIT);
    await form.getByLabel('帳號類型').selectOption({ label: 'User' });
    await form.getByRole('button', { name: '新增帳號' }).click();
    await ok(page, `已新增帳號「${n}」`);
    success++;
    await shot(page, TC, `0${i + 2}-新增${n.replace('KIT-A-', 'KIT-A-')}訊息`);
  }
  await table.getByRole('rowheader', { name: 'KIT-A-u3', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, TC, '05-新增後列表');
  const afterCreate = await names();

  // Keycloak 同步：新帳號可登入
  const u = await freshPage(browser);
  await loginWith(u.page, 'KIT-A-u1', INIT);
  await expect(u.page.getByText('你尚未加入任何專案，請聯絡管理者將你加入專案。').first()).toBeVisible();
  const h1 = await headerUser(u.page);
  await shot(u.page, TC, '06-KIT-A-u1登入成功');
  note(TC, `新帳號登入：右上角「${h1}」，首頁「你尚未加入任何專案，請聯絡管理者將你加入專案。」`);
  await u.ctx.close();

  // 修改 3 次：帳號類型改為 Admin
  await page.bringToFront();
  for (const [i, n] of NAMES.entries()) {
    await table.getByLabel(`${n} 的帳號類型`).selectOption({ label: 'Admin' });
    await ok(page, `已將「${n}」改為 Admin`);
    success++;
    await shot(page, TC, `0${i + 7}-改為Admin-${n.slice(-2)}訊息`);
  }
  const types: string[] = [];
  for (const n of NAMES) types.push((await table.getByLabel(`${n} 的帳號類型`).locator('option:checked').innerText()).trim());
  await table.getByRole('rowheader', { name: 'KIT-A-u3', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, TC, '10-修改後列表');
  note(TC, `修改後帳號類型：${NAMES.map((n, i) => `${n} ${types[i]}`).join('、')}`);

  // 刪除 3 次
  for (const [i, n] of NAMES.entries()) {
    await page.getByRole('button', { name: `刪除 ${n}`, exact: true }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('刪除帳號');
    await expect(dlg).toContainText(`確定要刪除帳號「${n}」嗎？該帳號的專案成員資格與登入身分會一併移除，此動作無法復原。`);
    if (i === 0) await shot(page, TC, '11-刪除確認視窗');
    await dlg.getByRole('button', { name: '確認刪除' }).click();
    await ok(page, `已刪除帳號「${n}」`);
    success++;
    await shot(page, TC, `${12 + i}-刪除${n.slice(-2)}訊息`);
  }
  const after = await names();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, TC, '15-刪除後列表-8個');
  note(TC, `刪除後帳號 ${after.length} 個：${after.join('、')}`);

  // Keycloak 同步：刪除後不能登入
  const d = await freshPage(browser);
  await loginFails(d.page, 'KIT-A-u1', INIT);
  await shot(d.page, TC, '16-刪除後登入失敗');
  note(TC, '刪除後以 KIT-A-u1／Kit-A-Init-2026! 登入：Keycloak 顯示「使用者名稱或密碼無效。」');
  await d.ctx.close();

  // 稽核
  await page.bringToFront();
  const rows = await auditFilter(page, '帳號（account）', 9);
  await shot(page, TC, '17-稽核紀錄-帳號9筆');
  note(TC, `稽核紀錄頁最新 9 筆：${rows.map((r) => `${r[0]} ${r[4]} ${r[5]}`).join('；')}`);
  dbDump(
    TC,
    'TC-A03-02-audit',
    `select id, actor, at, category, action, target, result, source_ip from audit_log where id > ${startId} and category = 'account' order by id;`,
  );
  const counts = psql(
    `select action, count(*) from audit_log where id > ${startId} and category='account' and actor='admin01' and result='success' group by action order by action`,
  ).replace(/\n/g, '、');
  note(TC, `資料庫稽核（id > ${startId}，帳號類，admin01，成功）：${counts}`);
  note(TC, `新增 3、修改 3、刪除 3，成功 ${success}/9；登入同步 2/2（新帳號可登入、刪除後不能登入）`);
  expect(before).toEqual(SEED);
  expect(afterCreate.length).toBe(11);
  expect(h1).toBe('KIT-A-u1'); // 未加入專案：頂端只顯示帳號與「尚未加入任何專案」
  expect(types).toEqual(['Admin', 'Admin', 'Admin']);
  expect(after).toEqual(SEED);
  expect(counts).toBe('create|3、delete|3、update|3');
  expect(success).toBe(9);
  await ctx.close();
});
