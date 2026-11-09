import { expect, test, type Page } from '@playwright/test';
import { P1, clickMenu, login, menuLabels, note, shot, useProject } from './helpers';
import { psql, sh } from './ops';
import { freshPage, logout, membersOf, ok } from './r-common';

// M1 補拍 08：權限 10 秒內生效（TC-A03-06）。視窗 A admin01、視窗 B ra01。
// 會暫時移除 ra01 在 P1 的 Training 權限；無論成功失敗，最後一定還原為 Research Assistant 預設。
const TC = 'TC-A03-06';
const RA_DEFAULT = 'Research Assistant｜Project、Labeling、Training、Prediction';
const MENU_WITH = ['數據管理', '影像標註', '自動影像分類標註', '建模管理', 'AI 模型部署', '推論服務管理'];
const MENU_WITHOUT = MENU_WITH.filter((m) => m !== '建模管理');

async function openMembers(admin: Page) {
  await membersOf(admin, P1);
  await expect(admin.getByRole('button', { name: '編輯 ra01', exact: true })).toBeVisible();
}

async function raRow(admin: Page) {
  const row = admin.getByRole('table', { name: '目前的專案成員' }).locator('tbody tr').filter({ has: admin.getByRole('rowheader', { name: 'ra01', exact: true }) });
  return (await row.locator('td').allInnerTexts()).slice(0, 2).map((s) => s.trim()).join('｜');
}

const training = (admin: Page) => admin.getByRole('group', { name: '權限' }).getByRole('checkbox', { name: /^Training/ });

/**
 * 新版「送出測試工作」表單只有 Admin 看得到，研究者改以「建模管理 › 訓練紀錄」的「重新整理」驗證：
 * 該請求（GET /training/runs）需要 Training 權限，移除後立即被拒、加回後立即可讀。
 */
const runsSection = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '訓練紀錄' }) });
async function openRuns(page: Page) {
  await clickMenu(page, '建模管理'); // 功能目錄 → 建模管理（新位置：建模管理／訓練紀錄）
  await expect(page.getByRole('heading', { level: 1, name: '建模管理' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '訓練紀錄' })).toBeVisible();
}
const refreshRuns = (page: Page) => runsSection(page).getByRole('button', { name: '重新整理', exact: true }).click();

/**
 * 寫入動作：以 ra01 的登入身分呼叫「送出工作」API（與舊版頁面上的「送出工作」同一支，需要 Training）。
 * 新版畫面上這張表單只有 Admin 看得到，所以改由終端機送出，指令與回應存到 TC-A03-06-ra01送出工作.txt。
 */
function raSubmit(p1: string) {
  const r = sh(
    TC,
    'TC-A03-06-ra01送出工作',
    `T=$(curl -s -X POST $KEYCLOAK/realms/ai-platform/protocol/openid-connect/token \\
  -d grant_type=password -d client_id=ai-platform-web -d username=ra01 --data-urlencode password='Dev-Passw0rd!' \\
  | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
curl -s -w '\\nHTTP %{http_code}\\n' -X POST $GATEWAY/api/projects/${p1}/jobs \\
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \\
  -d '{"kind":"training","duration_seconds":10,"fail":false}'`,
  );
  const code = /HTTP (\d+)/.exec(r.out)?.[1] ?? '';
  return { code, out: r.out.replace(/\s+/g, ' ').trim() };
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
  const p1 = psql(`select id from projects where name='${P1}'`);
  try {
    // 1 視窗 B：開啟建模管理 › 訓練紀錄
    await login(ra, 'ra01');
    await useProject(ra);
    await openRuns(ra);
    await shot(ra, TC, '01-ra01-訓練紀錄');

    // 2–4 視窗 A：移除 Training
    await admin.bringToFront();
    await openMembers(admin);
    await admin.getByRole('button', { name: '編輯 ra01', exact: true }).click();
    await expect(admin.getByText('「ra01」目前是 Research Assistant，權限：Project、Labeling、Training、Prediction')).toBeVisible();
    await admin.getByRole('table', { name: '目前的專案成員' }).scrollIntoViewIfNeeded();
    await shot(admin, TC, '02-專案頁成員與權限-ra01編輯');
    await training(admin).uncheck();
    await admin.getByRole('form', { name: '設定專案成員' }).scrollIntoViewIfNeeded();
    await shot(admin, TC, '03-移除Training-表單');
    await admin.getByRole('button', { name: '儲存變更' }).click();
    let t0 = Date.now();
    await ok(admin, '已將「ra01」設定為「P1-lung-ct」的 Research Assistant（權限：Project、Labeling、Prediction）');
    await shot(admin, TC, '04-移除Training-儲存訊息');
    note(TC, `移除後表格 ra01：${await raRow(admin)}`);

    // 5 視窗 B：10 秒內重新整理訓練紀錄，應被拒
    await ra.bringToFront();
    await refreshRuns(ra);
    await expect(ra.getByText('沒有權限：你沒有 training 權限').first()).toBeVisible({ timeout: 10_000 });
    const w1 = raSubmit(p1);
    const s1 = (Date.now() - t0) / 1000;
    await shot(ra, TC, '05-ra01訓練紀錄被拒');
    note(TC, `移除 Training 儲存後 ${s1.toFixed(1)} 秒，ra01 重新整理訓練紀錄被拒「沒有權限：你沒有 training 權限」；送出工作 API：${w1.out}`);

    // 6 F5
    await ra.reload();
    await expect(ra.getByText(`你在專案「${P1}」沒有 Training 權限，無法使用「建模管理」。`)).toBeVisible();
    await shot(ra, TC, '06-ra01重新整理-建模管理被拒');
    const m0 = await menuLabels(ra);
    await shot(ra, TC, '06-2-ra01功能目錄無建模管理');
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

    // 9 視窗 B：10 秒內開啟訓練紀錄並重新整理成功
    await ra.bringToFront();
    await ra.reload(); // 重新載入帳號權限（功能目錄才會出現建模管理）
    await openRuns(ra);
    await refreshRuns(ra);
    await ra.waitForLoadState('networkidle');
    await expect(ra.getByText('沒有權限：你沒有 training 權限')).toHaveCount(0, { timeout: 10_000 });
    const s2 = (Date.now() - t0) / 1000;
    const w2 = raSubmit(p1);
    const s2w = (Date.now() - t0) / 1000;
    const msgText = w2.out;
    await shot(ra, TC, '11-ra01訓練紀錄可讀');
    note(TC, `加回 Training 儲存後 ${s2.toFixed(1)} 秒 ra01 訓練紀錄重新整理成功；${s2w.toFixed(1)} 秒送出工作 API：${msgText}`);

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
    expect(w1.code).toBe('403');
    expect(w1.out).toContain('你沒有 training 權限');
    expect(w2.code).toBe('201');
    expect(s2w).toBeLessThan(10);
    expect(msgText).toContain('gpu-exclusive');
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
