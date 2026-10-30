import { expect, test } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { startScenario } from './kit';

// G4 稽核與合規（admin01）：稽核紀錄依類別、操作者、時間篩選 → 看一筆角色變更的「變更前後」→ 模型下載審核 → 白名單模型與授權。
// 需先跑 G1（今天有 admin01 對 manual-demo 的角色變更紀錄）。只看不改；沒有待審核申請時只說明。

test('G4 稽核與合規', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  expect(Number(psql(`select count(*) from audit_log where category='role' and action='change' and actor='admin01'`))).toBeGreaterThan(0);
  const s = await startScenario(browser, { id: 'G4', title: '稽核與合規', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;
  s.section('目的', '定期查核誰在什麼時候存取或修改了什麼；審核語言模型下載申請，確認只有白名單內、授權合適的模型進入平台。');
  s.section('開始前準備', '使用系統管理者帳號登入。決定要查的範圍，例如某一類操作、某個人或某段時間。');

  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.step('按左側選單的「稽核與審核」', sideNav(p).getByRole('link', { name: '稽核與審核', exact: true }), 'click');
  await expect(p.getByRole('table', { name: '稽核紀錄' })).toBeVisible();
  await s.note('「稽核紀錄」列出所有操作，只能查詢', { detail: '每筆紀錄有時間、操作者、類別、動作、對象、結果與來源 IP，不能修改或刪除。' });

  const filter = p.getByRole('form', { name: '篩選稽核紀錄' });
  await s.step('「類別」選擇 角色（role）', filter.getByLabel('類別'), { select: 'role' });
  await s.step('「操作者」輸入 admin01', filter.getByLabel('操作者'), { fill: 'admin01' });
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00`;
  await s.step('「開始時間」選今天 00:00', filter.getByLabel('開始時間'), { fill: today }, {
    detail: '也可填「結束時間（不含）」只看一段期間；「動作（開頭符合）」可用動作名稱的開頭過濾，例如 change。',
  });
  await s.step('按「查詢」', filter.getByRole('button', { name: '查詢' }), 'click');
  const table = p.getByRole('table', { name: '稽核紀錄' });
  await expect(table.locator('tbody tr').first()).toContainText('admin01');
  await s.step('清單只剩符合條件的紀錄', table, undefined, { zoom: false });
  const row = table.locator('tbody tr').filter({ hasText: 'change' }).first();
  await s.step('點一筆動作為 change 的紀錄', row, 'click');
  await expect(p.getByRole('table', { name: '變更前後' })).toBeVisible();
  await s.step('右側「操作詳情」顯示變更前後', p.getByRole('table', { name: '變更前後' }), undefined, {
    detail: '「變更內容」逐欄列出變更前與變更後；「原始內容（JSON）」可展開看完整紀錄。',
  });

  // 模型下載審核
  await s.step('按「模型下載審核」分頁', p.getByRole('link', { name: '模型下載審核' }), 'click');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.note('待審核的模型下載申請列在這裡', {
    detail: '有申請時，每筆顯示模型、申請人與時間，按「核准」或「駁回」。核准後使用者才能下載。',
  });

  // 白名單與授權
  await p.goto('/llm/models');
  await expect(p.getByRole('table', { name: '白名單模型' })).toBeVisible();
  await s.step('「語言模型管理」列出白名單模型與授權', p.getByRole('table', { name: '白名單模型' }), undefined, {
    zoom: false,
    detail: '從左側選單「語言模型」→「模型」進入。「來源與授權」欄列出每個模型的來源與授權條款；只有白名單內的模型可以申請下載。',
  });

  s.section(
    '完成後的樣子',
    '依條件篩出要查核的紀錄，點開可看到誰、何時、對什麼對象做了什麼變更與變更前後的內容；模型下載申請都經過審核。',
  );
  s.section(
    '常見問題',
    [
      '- 查不到紀錄（顯示「沒有符合條件的紀錄。」）：放寬條件，或按「清除條件」重新查詢。時間以瀏覽器所在時區顯示。',
      '- 點一筆紀錄後顯示「這筆紀錄沒有變更前後的內容。」：新增、刪除類的紀錄只有內容，沒有變更前後。',
      '- 「模型下載審核」顯示「目前沒有待審核的申請。」：使用者在語言模型「模型」分頁申請下載後，會出現在這裡。',
      '- 稽核紀錄目前沒有匯出按鈕；需要報表時請以篩選後的畫面截圖，或請資訊室由資料庫匯出。',
    ].join('\n'),
  );
  await s.finish();
});
