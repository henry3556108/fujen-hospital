import { expect, test, type Page } from '@playwright/test';
import { P1, login, note, shot, useProject } from './helpers';
import { membersOf } from './r-common';

// 情境 4-5：把 md01 移出 P1，確認 10 秒內失去存取、不需重新登入；最後一定把 md01 以 Medical Doctor 加回（TC-A03-07）。
const TC = 'TC-A03-07';

/** 管理區「專案」→ P1 專案頁「成員與權限」 */
async function openMembers(admin: Page) {
  await membersOf(admin, P1);
}

async function addBack(admin: Page) {
  await openMembers(admin);
  if (await admin.getByRole('button', { name: '移除 md01' }).count()) return false; // 已是成員，不必加回
  await admin.locator('#member-user').selectOption({ label: 'md01' });
  await expect(admin.getByText('「md01」還不是這個專案的成員，儲存後加入。')).toBeVisible();
  await admin.locator('#member-role').selectOption('medical_doctor');
  await admin.getByRole('button', { name: '加入專案' }).click();
  await expect(admin.getByText(`已將「md01」設定為「${P1}」的 Medical Doctor（權限：Project、Labeling、Prediction）`)).toBeVisible();
  return true;
}

test('4-5 移出專案即時生效，並還原 md01（TC-A03-07）', async ({ browser }) => {
  const ctxA = await browser.newContext(); // 視窗 A：admin01
  const ctxB = await browser.newContext(); // 視窗 B：md01
  const admin = await ctxA.newPage();
  const md = await ctxB.newPage();
  try {
    await login(md, 'md01');
    await useProject(md);
    await md.goto('/data/tabular');
    await expect(md.getByRole('link', { name: 'cohort_02.csv', exact: true }).first()).toBeVisible();
    await shot(md, TC, '1-md01-看得到資料集');

    await login(admin, 'admin01');
    await openMembers(admin);
    await admin.getByRole('button', { name: '移除 md01' }).click();
    await expect(admin.getByText(`確定要將「md01」移出專案「${P1}」嗎？`)).toBeVisible();
    await shot(admin, TC, '2-移除確認視窗');
    await admin.getByRole('button', { name: '確認移除' }).click();
    const t0 = Date.now();
    await expect(admin.getByText(`已將「md01」移出「${P1}」`)).toBeVisible();
    await shot(admin, TC, '3-移除成功訊息');

    await md.getByRole('link', { name: 'cohort_02.csv', exact: true }).first().click();
    await expect(md.getByText('沒有權限：你沒有 project 權限').first()).toBeVisible({ timeout: 10_000 });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    await shot(md, TC, '4-md01-立即被拒');
    note(TC, `移出後 ${sec} 秒 md01 存取資料集被拒（未重新登入）`);

    // 重新整理：P1 不再出現在 md01 的專案中（md01 若只在 P1 就顯示「尚未加入任何專案」；還在其他專案時，頂端「目前專案」下拉已沒有 P1）
    await md.reload();
    await md.waitForLoadState('networkidle');
    const sw = md.locator('select#project-switcher');
    await expect(md.getByText('尚未加入任何專案').first().or(sw)).toBeVisible();
    const options = (await sw.count()) ? (await sw.locator('option').allInnerTexts()).map((x) => x.trim()) : [];
    await shot(md, TC, '5-md01-重新整理後');
    note(TC, `重新整理後 md01 的專案：${options.length ? options.join('、') : '尚未加入任何專案'}（有 ${P1}：${options.includes(P1) ? '是' : '否'}）`);
    expect(options).not.toContain(P1);
  } finally {
    const restored = await addBack(admin);
    await shot(admin, TC, '6-還原為Medical-Doctor');
    note(TC, restored ? '已將 md01 以 Medical Doctor 加回 P1' : 'md01 本來就在 P1，未做加回');
    await md.reload();
    await useProject(md);
    await md.goto('/data/tabular');
    await expect(md.getByRole('link', { name: 'cohort_02.csv', exact: true }).first()).toBeVisible();
    await shot(md, TC, '7-md01-恢復存取');
    await ctxA.close();
    await ctxB.close();
  }
});
