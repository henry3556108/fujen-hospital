import { expect, test } from '@playwright/test';
import { SIDE, sideNav, startsWith } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { startScenario } from './kit';

// V1 檢視者（vw01）：登入選專案 → 專案首頁 → 使用模型看結果與預測紀錄 → 研究資料 → 沒有權限的功能顯示「無法存取此功能」→ 功能目錄。
// 只看不改。vw01 是下列專案的 Viewer（Project、Prediction 權限）；P1-lung-ct 沒有完成的模型，改用有模型的示範專案。
const CANDIDATES = ['手冊-胸部影像研究', '手冊-臨床表格研究', 'F-走查'];
test('V1 檢視者看結果與報表', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const P1 = CANDIDATES.find((n) => Number(psql(`select count(*) from training_runs r join projects p on p.id=r.project_id where p.name='${n}' and r.status='succeeded'`)) > 0);
  if (!P1) throw new Error('檢視者的專案都沒有完成的模型');
  const s = await startScenario(browser, { id: 'V1', title: '看結果與報表', role: 'vw01', manual: '06-檢視者', login: false });
  const p = s.page;
  s.section('目的', '以檢視者身分查看研究專案的進度、模型結果與預測紀錄。檢視者只看結果與報表，不能標註、訓練或改設定。');
  s.section('開始前準備', `向系統管理者取得帳號與密碼，並確認已被加入研究專案（本節以「${P1}」示範）。`);

  await s.login();
  if (!/\/projects/.test(p.url())) await p.goto('/projects');
  const main = p.locator('main');
  await s.step(`點選專案「${P1}」`, main.getByRole('button', { name: startsWith(P1) }), 'click');
  await s.step('按「進入專案」', main.getByRole('button', { name: /進入專案/ }), 'click');
  await expect(p.locator('select#project-switcher option:checked')).toHaveText(P1);
  await s.note('專案首頁顯示資料、標註與訓練進度');
  await s.step('左側只列出你能使用的功能', sideNav(p), undefined, {
    zoom: false,
    detail: '檢視者看得到「專案首頁」「研究資料」「使用模型」；「影像標註」「建立模型」「語言模型」不會出現。',
  });

  // 使用模型：結果
  await s.step('按左側選單的「使用模型」', sideNav(p).getByRole('link', { name: SIDE.models, exact: true }), 'click');
  const list = p.getByRole('table', { name: '模型清單' });
  await expect(list).toBeVisible();
  await s.step('「模型清單」列出完成的模型與主要指標', list, undefined, { zoom: false });
  await s.step('按一個模型的名稱', list.locator('tbody th a').first(), 'click');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.note('「模型結果」顯示指標與圖表', { detail: '可看到準確率等主要指標、ROC 曲線與混淆矩陣（依模型類型不同）。', hold: 1200 });
  const tabs = p.getByRole('navigation').filter({ has: p.getByRole('link', { name: '預測紀錄' }) });
  await s.step('按「預測紀錄」分頁', tabs.getByRole('link', { name: '預測紀錄' }).first(), 'click');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.note('列出這個模型做過的預測與結果');

  // 研究資料
  await s.step('按左側選單的「研究資料」', sideNav(p).getByRole('link', { name: SIDE.data, exact: true }), 'click');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.note('「研究資料」可查看專案內的影像與表格');

  // 沒有權限的功能
  await p.goto('/training');
  await expect(p.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
  await s.note('沒有權限的功能顯示「無法存取此功能」', {
    detail: '例如從書籤或別人傳來的網址進入「建立模型」時會看到這個畫面，並說明缺少哪一項權限。',
    hold: 1500,
  });
  await s.step('按「回專案首頁」回到首頁', p.getByRole('link', { name: '回專案首頁' }), 'click');
  await p.goto('/admin');
  await expect(p.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
  await s.note('「系統管理」也只有管理者能進入', { hold: 1200 });

  // 功能目錄
  await p.goto('/');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.step('按左側選單的「功能目錄」', sideNav(p).getByRole('link', { name: SIDE.catalog, exact: true }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: SIDE.catalog })).toBeVisible();
  await s.note('功能目錄只列出你能使用的功能');

  s.section(
    '完成後的樣子',
    `頂端「目前專案」顯示 ${P1}；可在「使用模型」看模型結果與預測紀錄，在「研究資料」看資料清單。沒有權限的功能不會出現在選單，直接輸入網址也會被擋下。`,
  );
  s.section(
    '常見問題',
    [
      '- 看到「無法存取此功能」：你的角色沒有這項權限。畫面註明「如需使用，請聯絡專案負責人或系統管理者調整權限。」',
      '- 登入後看到「你尚未加入任何專案」：帳號還沒加入專案，請聯絡系統管理者。',
      '- 「使用模型」顯示「這個專案還沒有訓練完成的模型。」：專案還沒有完成的訓練，等有訓練權限的成員建立訓練後再看。',
      '- 參與多個專案：從頂端「目前專案」切換，各專案的資料分開顯示。',
    ].join('\n'),
  );
  await s.finish();
});
