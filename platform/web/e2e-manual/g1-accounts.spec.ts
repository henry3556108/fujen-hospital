import { expect, test, type Page } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { startScenario } from './kit';
import { FHIR_PROJECT, ensureFhirProject } from './ops-common';

// G1 管帳號與權限（admin01）：總覽 → 新增示範帳號 → 加入示範專案並設定角色與權限 → 重設密碼 → 刪除帳號。
// 只動自己建立的帳號與示範專案「手冊-FHIR資料交換」，不改既有專案成員與其他帳號。
// 原訂帳號「手冊示範帳號」：中文帳號新增時 Keycloak 回 400、畫面顯示「錯誤：伺服器錯誤（HTTP 500）」（缺陷），改用英文 manual-demo。
const USER = 'manual-demo';
const INIT = 'Manual-Demo-2026!';
const RESET = 'Manual-Reset-2026!';

async function removeLeftover(p: Page) {
  await p.goto('/admin/users');
  const table = p.getByRole('table', { name: '帳號列表' });
  await expect(table.getByRole('rowheader', { name: 'admin01', exact: true })).toBeVisible();
  const del = p.getByRole('button', { name: `刪除 ${USER}`, exact: true });
  if (await del.count()) {
    await del.click();
    await p.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
    await expect(p.getByText(`已刪除帳號「${USER}」`)).toBeVisible();
  }
}

test('G1 管帳號與權限', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  ensureFhirProject();
  const s = await startScenario(browser, { id: 'G1', title: '管帳號與權限', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;
  await removeLeftover(p); // 上一輪殘留（鏡頭外）
  s.section('目的', '為新進人員建立帳號、把他加入專案並指定角色與功能權限；忘記密碼時幫他重設；離職或不再使用時刪除帳號。');
  s.section(
    '開始前準備',
    [
      '- 使用系統管理者帳號登入。',
      '- 確認新帳號的名稱、初始密碼，以及要加入哪個專案、擔任什麼角色。',
      `- 本節以帳號「${USER}」、專案「${FHIR_PROJECT}」示範，最後把示範帳號刪除。`,
    ].join('\n'),
  );

  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.note('「總覽」顯示全平台專案、帳號與工作狀態');
  await s.step('按左側選單的「帳號」', sideNav(p).getByRole('link', { name: '帳號', exact: true }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: '帳號管理' })).toBeVisible();

  // 新增帳號
  const form = p.getByRole('form', { name: '新增帳號' });
  await s.step('按右上角「新增帳號 ＋」', p.getByRole('button', { name: /新增帳號 ＋/ }), 'click');
  await s.step(`在「帳號」輸入 ${USER}`, form.getByLabel('帳號（必填）'), { fill: USER }, {
    detail: '帳號請用英文字母、數字與連字號，例如 manual-demo。',
  });
  await s.step('在「初始密碼」輸入密碼', form.getByLabel('初始密碼（必填）'), { fill: INIT }, {
    detail: '把初始密碼另外告知使用者，請他登入後自行更改。',
  });
  await s.step('「帳號類型」選擇 User', form.getByLabel('帳號類型'), { select: 'user' }, {
    detail: 'Admin 可進入系統管理；一般研究人員選 User，專案角色另在專案裡設定。',
  });
  await s.step('按「新增帳號」', form.getByRole('button', { name: '新增帳號' }), 'click');
  await expect(p.getByText(`已新增帳號「${USER}」`)).toBeVisible();
  await s.step('在搜尋欄輸入 manual 找到新帳號', p.getByLabel('搜尋帳號名稱或所屬專案'), { fill: 'manual' });
  const table = p.getByRole('table', { name: '帳號列表' });
  await expect(table.getByRole('rowheader', { name: USER, exact: true })).toBeVisible();
  await s.step('帳號清單出現新帳號', table.getByRole('row', { name: new RegExp(USER) }), undefined, { zoom: false });

  // 加入專案、設定角色
  await s.step('按左側選單的「專案」', sideNav(p).getByRole('link', { name: '專案', exact: true }), 'click');
  const projects = p.getByRole('table', { name: '專案列表' });
  await s.step(`按專案「${FHIR_PROJECT}」`, projects.getByRole('link', { name: FHIR_PROJECT, exact: true }), 'click');
  await s.step('按「成員與權限」分頁', p.getByRole('link', { name: '成員與權限' }), 'click');
  const member = p.getByRole('form', { name: '設定專案成員' });
  await s.step(`在「帳號」選擇 ${USER}`, member.locator('#member-user'), { select: { label: USER } });
  await expect(member.getByText(`「${USER}」還不是這個專案的成員，儲存後加入。`)).toBeVisible();
  await s.step('在「角色」選擇 Research Assistant', member.locator('#member-role'), { select: 'research_assistant' });
  await s.step('下方顯示這個角色預設的權限', member.locator('.adm-note'), undefined, {
    detail: '角色只是預設組合。「功能權限」可逐項打開或關閉，例如額外給 Training 權限。',
  });
  await s.step('「功能權限」可逐項調整', member.getByRole('group', { name: '功能權限' }), undefined, { zoom: false });
  await s.step('按「加入專案」', member.getByRole('button', { name: '加入專案' }), 'click');
  await expect(p.getByText(new RegExp(`已將「${USER}」設定為「${FHIR_PROJECT}」的`))).toBeVisible();
  await s.step('「目前的專案成員」列出角色與權限', p.getByRole('table', { name: '目前的專案成員' }).getByRole('row', { name: new RegExp(USER) }), undefined, {
    zoom: false,
    detail: '權限改了立即生效，成員下次操作就依新權限顯示功能。',
  });

  // 修改角色
  await s.step('要改角色時按該成員的「編輯」', p.getByRole('button', { name: `編輯 ${USER}`, exact: true }), 'click');
  await s.step('「角色」改成 Medical Doctor', member.locator('#member-role'), { select: 'medical_doctor' });
  await s.step('「變更摘要」列出角色與權限的變化', member.locator('.adm-summary'), undefined);
  await s.step('按「儲存變更」', member.getByRole('button', { name: '儲存變更' }), 'click');
  const change = p.getByRole('dialog');
  await expect(change).toContainText('變更角色');
  await s.step('確認內容後按「確認變更」', change.getByRole('button', { name: '確認變更' }), 'click');
  await expect(p.getByText(new RegExp(`已將「${USER}」設定為「${FHIR_PROJECT}」的 Medical Doctor`))).toBeVisible();

  // 重設密碼
  await s.step('回到左側選單的「帳號」', sideNav(p).getByRole('link', { name: '帳號', exact: true }), 'click');
  await p.getByLabel('搜尋帳號名稱或所屬專案').fill('manual');
  await s.step('按這個帳號的「重設密碼」', p.getByRole('button', { name: `重設 ${USER} 的密碼`, exact: true }), 'click');
  const reset = p.getByRole('form', { name: `重設密碼：${USER}` });
  await s.step('在「新密碼」輸入新的密碼', reset.getByLabel('新密碼（必填）'), { fill: RESET });
  await s.step('按「確認重設」', reset.getByRole('button', { name: '確認重設' }), 'click');
  await expect(p.getByText(`已重設「${USER}」的密碼`)).toBeVisible();
  await s.note('畫面上方顯示已重設密碼');

  // 刪除帳號
  await s.step('按這個帳號的「刪除」', p.getByRole('button', { name: `刪除 ${USER}`, exact: true }), 'click');
  const dlg = p.getByRole('dialog');
  await expect(dlg).toContainText(`確定要刪除帳號「${USER}」嗎？`);
  await s.step('確認內容後按「確認刪除」', dlg.getByRole('button', { name: '確認刪除' }), 'click', {
    detail: '刪除後該帳號的專案成員資格與登入身分會一併移除，此動作無法復原。',
  });
  await expect(p.getByText(`已刪除帳號「${USER}」`)).toBeVisible();
  await s.note('帳號清單不再出現這個帳號');

  s.section(
    '完成後的樣子',
    '新帳號建立後可以用初始密碼登入；加入專案後，登入就看得到該專案，功能依角色與權限顯示。重設密碼後舊密碼不能再用。刪除後帳號從清單消失，也不能再登入。以上每個動作都會記在「稽核與審核」的稽核紀錄。',
  );
  s.section(
    '常見問題',
    [
      '- 按「新增帳號」後出現「錯誤：伺服器錯誤（HTTP 500）」：帳號名稱含中文或特殊字元時會發生，請改用英文字母、數字與連字號。',
      '- 新使用者登入後看到「你尚未加入任何專案」：帳號還沒加入專案，到「專案」→ 該專案 →「成員與權限」加入。',
      '- 不確定該給什麼角色：選角色後下方會顯示「○○ 角色預設：…」，可再逐項調整「功能權限」。Viewer 只能看結果與報表。',
      '- 帳號類型（Admin／User）與專案角色是分開的：帳號類型決定能不能進系統管理，專案角色決定在專案裡能做什麼。',
      '- 要移出某個專案而不刪帳號：在該專案的「成員與權限」按「移除」，會出現「移除後立即失去該專案的存取權，也會移出這個專案的標註群組。」的確認。',
    ].join('\n'),
  );
  await s.finish();
});
