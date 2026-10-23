import { expect, test, type Page } from '@playwright/test';
import { P1, login, menuLabels, note, shot, useProject } from './helpers';
import { psql } from './ops';
import { freshPage, gotoAdmin, logout, ok } from './r-common';

// M1 補拍 08：權限 10 秒內生效（TC-A03-06）。視窗 A admin01、視窗 B ra01。
// 會暫時移除 ra01 在 P1 的 Training 權限；無論成功失敗，最後一定還原為 Research Assistant 預設。
const TC = 'TC-A03-06';
const RA_DEFAULT = 'Research Assistant｜Project、Labeling、Training、Prediction';
const MENU_WITH = ['數據管理', '影像標註', '自動影像分類標註', '建模管理', 'AI 模型部署', '推論服務管理'];
const MENU_WITHOUT = MENU_WITH.filter((m) => m !== '建模管理');

async function openMembers(admin: Page) {
  await gotoAdmin(admin, '專案成員');
  await admin.locator('#member-project').selectOption({ label: P1 });
  await expect(admin.getByRole('button', { name: '編輯 ra01', exact: true })).toBeVisible();
}

async function raRow(admin: Page) {
  const row = admin.getByRole('table', { name: '目前的專案成員' }).locator('tbody tr').filter({ has: admin.getByRole('rowheader', { name: 'ra01', exact: true }) });
  return (await row.locator('td').allInnerTexts()).slice(0, 2).map((s) => s.trim()).join('｜');
}

const training = (admin: Page) => admin.getByRole('group', { name: '權限' }).getByRole('checkbox', { name: /^Training/ });

async function fillJob(page: Page) {
  const form = page.getByRole('form', { name: '送出工作' });
  await form.getByLabel('工作種類').selectOption({ label: '訓練（GPU）' });
  await form.getByLabel('執行秒數（1–3600）').fill('10');
  return form;
}

/** 還原 ra01 為 Research Assistant 預設權限（已是預設就不動） */
async function restore(admin: Page) {
  await openMembers(admin);
  if ((await raRow(admin)) === RA_DEFAULT) return false;
  await admin.getByRole('button', { name: '編輯 ra01', exact: true }).click();
  await admin.locator('#member-role').selectOption('research_assistant'); // 換角色會帶入該角色預設權限
  for (const p of [/^Project/, /^Labeling/, /^Training/, /^Prediction/]) {
    const cb = admin.getByRole('group', { name: '權限' }).getByRole('checkbox', { name: p });
    if (!(await cb.isChecked())) await cb.check();
  }
  const coding = admin.getByRole('group', { name: '權限' }).getByRole('checkbox', { name: /^Coding/ });
  if (await coding.isChecked()) await coding.uncheck();
  await admin.getByRole('button', { name: '儲存變更' }).click();
  const dlg = admin.getByRole('dialog');
  if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: '確認變更' }).click();
  await ok(admin, '已將「ra01」設定為「P1-lung-ct」的 Research Assistant（權限：Project、Labeling、Training、Prediction）');
  return true;
}

test('M1 補拍 08 權限 10 秒內生效（TC-A03-06）', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const A = await freshPage(browser);
  const B = await freshPage(browser);
  const admin = A.page;
  const ra = B.page;
  await login(admin, 'admin01');
  try {
    // 1 視窗 B：準備送出
    await login(ra, 'ra01');
    await useProject(ra);
    await ra.goto('/training/jobs');
    await expect(ra.getByRole('heading', { level: 1, name: '專案工作' })).toBeVisible();
    let form = await fillJob(ra);
    await shot(ra, TC, '01-ra01-準備送出');

    // 2–4 視窗 A：移除 Training
    await admin.bringToFront();
    await openMembers(admin);
    await admin.getByRole('button', { name: '編輯 ra01', exact: true }).click();
    await expect(admin.getByText('「ra01」目前是 Research Assistant，權限：Project、Labeling、Training、Prediction')).toBeVisible();
    await admin.getByRole('table', { name: '目前的專案成員' }).scrollIntoViewIfNeeded();
    await shot(admin, TC, '02-專案成員-ra01編輯');
    await training(admin).uncheck();
    await admin.getByRole('form', { name: '設定專案成員' }).scrollIntoViewIfNeeded();
    await shot(admin, TC, '03-移除Training-表單');
    await admin.getByRole('button', { name: '儲存變更' }).click();
    let t0 = Date.now();
    await ok(admin, '已將「ra01」設定為「P1-lung-ct」的 Research Assistant（權限：Project、Labeling、Prediction）');
    await shot(admin, TC, '04-移除Training-儲存訊息');
    note(TC, `移除後表格 ra01：${await raRow(admin)}`);

    // 5 視窗 B：10 秒內送出，應被拒
    await ra.bringToFront();
    await form.getByRole('button', { name: '送出工作' }).click();
    await expect(ra.getByText('沒有權限：你沒有 training 權限').first()).toBeVisible({ timeout: 10_000 });
    const s1 = (Date.now() - t0) / 1000;
    await shot(ra, TC, '05-ra01送出被拒');
    note(TC, `移除 Training 儲存後 ${s1.toFixed(1)} 秒，ra01 送出工作被拒「沒有權限：你沒有 training 權限」`);

    // 6 F5
    await ra.reload();
    await expect(ra.getByText(`你在專案「${P1}」沒有 Training 權限，無法使用「建模管理」。`)).toBeVisible();
    const m0 = await menuLabels(ra);
    await shot(ra, TC, '06-ra01重新整理-無建模管理');
    note(TC, `重新整理後選單：${m0.join('、')}；頁面「你在專案「${P1}」沒有 Training 權限，無法使用「建模管理」。」`);
    let diff = m0.join() === MENU_WITHOUT.join() ? 0 : 1;

    // 7 重新登入 3 次（移除狀態）
    for (let i = 1; i <= 3; i++) {
      await logout(ra);
      await login(ra, 'ra01');
      await useProject(ra);
      const m = await menuLabels(ra);
      if (m.join() !== MENU_WITHOUT.join()) diff++;
      await shot(ra, TC, `0${6 + i}-移除後重新登入${i}`);
      note(TC, `移除後重新登入第 ${i} 次選單：${m.join('、')}（有建模管理：${m.includes('建模管理') ? '是' : '否'}）`);
    }

    // 8 視窗 A：加回 Training
    await admin.bringToFront();
    await admin.getByRole('button', { name: '編輯 ra01', exact: true }).click();
    await training(admin).check();
    await admin.getByRole('button', { name: '儲存變更' }).click();
    t0 = Date.now();
    await ok(admin, '已將「ra01」設定為「P1-lung-ct」的 Research Assistant（權限：Project、Labeling、Training、Prediction）');
    await shot(admin, TC, '10-加回Training-儲存訊息');

    // 9 視窗 B：10 秒內送出成功
    await ra.bringToFront();
    await ra.goto('/training/jobs');
    form = await fillJob(ra);
    await form.getByRole('button', { name: '送出工作' }).click();
    const msg = ra.getByRole('status').filter({ hasText: /完成：已送出工作 \d+，進入佇列/ });
    await expect(msg).toBeVisible({ timeout: 10_000 });
    const s2 = (Date.now() - t0) / 1000;
    const msgText = (await msg.innerText()).trim();
    await msg.scrollIntoViewIfNeeded();
    await shot(ra, TC, '11-ra01送出成功');
    note(TC, `加回 Training 儲存後 ${s2.toFixed(1)} 秒，ra01 送出成功「${msgText}」`);

    // 10 重新登入 3 次（加回狀態）
    for (let i = 1; i <= 3; i++) {
      await logout(ra);
      await login(ra, 'ra01');
      await useProject(ra);
      const m = await menuLabels(ra);
      if (m.join() !== MENU_WITH.join()) diff++;
      await shot(ra, TC, `${11 + i}-加回後重新登入${i}`);
      note(TC, `加回後重新登入第 ${i} 次選單：${m.join('、')}（有建模管理：${m.includes('建模管理') ? '是' : '否'}）`);
    }
    note(TC, `兩次生效時間 ${s1.toFixed(1)} 秒、${s2.toFixed(1)} 秒（皆需 < 10）；重新登入 3＋3 次與設定差異 ${diff}`);
    expect(s1).toBeLessThan(10);
    expect(s2).toBeLessThan(10);
    expect(msgText).toContain('進入佇列 gpu-exclusive');
    expect(diff).toBe(0);
  } finally {
    // 11 還原確認（失敗時也一定執行）
    await admin.bringToFront();
    const changed = await restore(admin);
    const row = await raRow(admin);
    await admin.getByRole('table', { name: '目前的專案成員' }).scrollIntoViewIfNeeded();
    await shot(admin, TC, '15-還原確認');
    const db = psql(`select m.role, m.permissions from memberships m join users u on u.id=m.user_id join projects p on p.id=m.project_id where u.username='ra01' and p.name='${P1}'`);
    note(TC, `還原確認：表格 ra01「${row}」${changed ? '（finally 另做了還原）' : ''}；資料庫 ${db}`);
    await A.ctx.close();
    await B.ctx.close();
    expect(row).toBe(RA_DEFAULT);
  }
});
