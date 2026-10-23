import { expect, test, type Page } from '@playwright/test';
import { login, note, shot } from './helpers';
import { psql } from './ops';
import { auditFilter, dbDump, gotoAdmin, maxAuditId, ok } from './r-common';

// M1 補拍 03：專案新增、修改、刪除各 3 次（TC-A03-01）。演練專案 KIT-A-p1～p3，最後刪除。
const TC = 'TC-A03-01';
const NAMES = ['KIT-A-p1', 'KIT-A-p2', 'KIT-A-p3'];

async function cleanup(page: Page) {
  await gotoAdmin(page, '專案');
  for (const n of NAMES) {
    const del = page.getByRole('button', { name: `刪除 ${n}`, exact: true });
    if (await del.count()) {
      await del.click();
      await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
      await ok(page, `已刪除專案「${n}」`);
    }
  }
}

test('M1 補拍 03 專案新增修改刪除（TC-A03-01）', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await login(page, 'admin01');
  await cleanup(page); // 上一輪若有殘留先清掉
  const table = page.getByRole('table', { name: '專案列表' });
  const names = async () => (await table.locator('tbody th').allInnerTexts()).map((s) => s.trim());
  const before = await names();
  await shot(page, TC, '01-專案清單');
  const startId = maxAuditId();
  let success = 0;

  // 新增 3 次
  for (const [i, n] of NAMES.entries()) {
    const form = page.getByRole('form', { name: '新增專案' });
    await form.getByLabel('專案名稱（必填）').fill(n);
    await form.getByLabel('說明').fill(`驗收示範 ${i + 1}`);
    await expect(form.getByLabel('GPU 群組').locator('option:checked')).toHaveText('不綁定');
    await form.getByRole('button', { name: '新增專案' }).click();
    await ok(page, `已新增專案「${n}」`);
    success++;
    await shot(page, TC, `0${i + 2}-新增${n}訊息`);
  }
  for (const n of NAMES) await expect(table.getByRole('rowheader', { name: n, exact: true })).toBeVisible();
  await table.getByRole('rowheader', { name: 'KIT-A-p3', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, TC, '05-新增後列表');

  // 修改 3 次
  for (const [i, n] of NAMES.entries()) {
    await page.getByRole('button', { name: `編輯 ${n}`, exact: true }).click();
    const form = page.getByRole('form', { name: '編輯專案' });
    await expect(form.getByRole('heading', { name: '編輯專案' })).toBeVisible();
    if (i === 0) {
      await form.scrollIntoViewIfNeeded();
      await shot(page, TC, '06-編輯專案表單');
    }
    await form.getByLabel('說明').fill(`驗收示範 ${i + 1}（已修改）`);
    await form.getByRole('button', { name: '儲存' }).click();
    await ok(page, `已更新專案「${n}」`);
    success++;
    await shot(page, TC, `${String(i + 7).padStart(2, '0')}-修改${n}訊息`);
  }
  const descs: string[] = [];
  for (const n of NAMES) {
    const row = table.locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: n, exact: true }) });
    descs.push((await row.locator('td').first().innerText()).trim());
  }
  await table.getByRole('rowheader', { name: 'KIT-A-p3', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, TC, '10-修改後列表');
  note(TC, `修改後說明欄：${descs.join('、')}`);

  // 刪除 3 次
  for (const [i, n] of NAMES.entries()) {
    await page.getByRole('button', { name: `刪除 ${n}`, exact: true }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('刪除專案');
    await expect(dlg).toContainText(`確定要刪除專案「${n}」嗎？專案成員資格會一併移除，此動作無法復原。`);
    if (i === 0) await shot(page, TC, '11-刪除確認視窗');
    await dlg.getByRole('button', { name: '確認刪除' }).click();
    await ok(page, `已刪除專案「${n}」`);
    success++;
    await shot(page, TC, `${12 + i}-刪除${n}訊息`);
  }
  const after = await names();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, TC, '15-刪除後列表');
  note(TC, `刪除後列表 ${after.length} 個專案：${after.join('、')}（與開始前${after.join() === before.join() ? '相同' : '不同'}）`);

  // 稽核
  const rows = await auditFilter(page, '專案（project）', 9);
  await shot(page, TC, '16-稽核紀錄-專案9筆');
  note(TC, `稽核紀錄頁最新 9 筆：${rows.map((r) => `${r[0]} ${r[4]} ${r[5]}`).join('；')}`);
  const out = dbDump(
    TC,
    'TC-A03-01-audit',
    `select id, actor, at, category, action, target, result, source_ip from audit_log where id > ${startId} and category = 'project' order by id;`,
  );
  const counts = psql(
    `select action, count(*) from audit_log where id > ${startId} and category='project' and actor='admin01' and result='success' group by action order by action`,
  ).replace(/\n/g, '、');
  note(TC, `資料庫稽核（id > ${startId}，專案類，admin01，成功）：${counts}`);
  note(TC, `新增 3、修改 3、刪除 3，成功 ${success}/9`);
  expect(success).toBe(9);
  expect(descs).toEqual(NAMES.map((_, i) => `驗收示範 ${i + 1}（已修改）`));
  expect(after).toEqual(before);
  expect(counts).toBe('create|3、delete|3、update|3');
  expect(out).toContain('(9 rows)');
});
