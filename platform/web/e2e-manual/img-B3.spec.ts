import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B3（md01）：B4 匯入診斷後還剩 5 個研究待處理（ACC0016–ACC0020）。醫師在工作台調窗位、逐筆分類標註、打信心分數。
// 判讀答案：合成資料 Accession 編號單數為 abnormal、雙數為 normal（與診斷 CSV 同一規則）。
const answerOf = (acc: string) => (Number(acc.replace(/\D/g, '')) % 2 === 1 ? 'abnormal' : 'normal');

test('B3 醫師逐張判讀與標註', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const s = await startScenario(browser, { id: 'B3', title: '逐張判讀與標註', role: 'md01', manual: '03-醫師', project: IMG_PROJECT });
  const p = s.page;
  s.section('目的', '在標註工作台看影像、調整窗寬窗位，把判讀結果存成分類標註，並給每筆標註打信心分數。');
  s.section('開始前準備', '專案裡已有影像，且有待處理（還沒確認標註）的研究。分類用的類別本專案是 normal（正常）與 abnormal（異常）。');

  await s.step('按左側選單的「影像標註」', sideNav(p).getByRole('link', { name: SIDE.labeling, exact: true }), 'click');
  const progress = p.getByTestId('label-progress');
  await expect(progress).toBeVisible();
  console.log(`[B3] 標註前：${flat(await progress.innerText())}`);
  await s.step('進度卡顯示已確認與待處理數', progress, undefined);
  await s.step('按「繼續標註」', p.getByRole('button', { name: '繼續標註', exact: true }), 'click');
  await expect(p).toHaveURL(/\/labeling\/studies\//);
  const viewport = p.getByTestId('viewport').first();
  await s.wait('等待影像載入', () => expect(viewport).toHaveAttribute('data-ready', '1', { timeout: 60_000 }), { manual: false });
  await s.note('左邊是切片，中間是影像，右邊是標註');

  // 檢視：窗位、器官窗、換張
  const toolbar = p.getByRole('toolbar', { name: '檢視工具列' });
  await s.step('在工具列按「窗位」', toolbar.getByRole('button', { name: '窗位' }), 'click');
  await s.step('在「器官窗」選「肺窗」', p.getByTestId('window-menu').getByRole('button', { name: '肺窗' }), 'click');
  await expect(p.getByTestId('workbench-status')).toContainText('窗寬');
  await s.step('上方顯示目前的窗寬與窗位', p.getByTestId('workbench-status'), undefined);
  await s.step('按「軟組織窗」換回一般檢視', p.getByTestId('window-menu').getByRole('button', { name: '軟組織窗' }), 'click');
  await s.step('按影像下方的「下一張」看下一張切片', p.getByRole('button', { name: '下一張', exact: true }), 'click');

  const panel = p.getByRole('region', { name: '標註' });
  const field = p.getByRole('combobox', { name: '標籤' });
  const actions = p.getByTestId('workbench-actions');
  const caseName = async () => (await panel.locator('h2.lb-panel__case').innerText()).trim();
  const uidNow = () => decodeURIComponent(/\/labeling\/studies\/([^/?#]+)/.exec(p.url())?.[1] ?? '');

  // 第 1 筆：分類＋只儲存＋打分數
  let acc = await caseName();
  await s.step('「標註種類」維持「分類」', p.getByRole('group', { name: '標註種類' }).getByRole('button', { name: '分類' }), undefined);
  await s.step('「標註對象」選「整個研究」', panel.getByLabel('整個研究'), 'click', {
    detail: '分類可以標整個研究，也可以只標目前這張影像。',
  });
  await s.step(`在「標註類別」輸入 ${answerOf(acc)}`, field, { fill: answerOf(acc) }, {
    detail: '輸入時會列出專案既有的類別，可以直接點選。',
  });
  await s.step('按「只儲存」', p.getByRole('button', { name: '只儲存', exact: true }), 'click');
  await expect(p.getByTestId('workbench-status')).toContainText('已儲存');
  await s.step('影像左上角顯示剛標的類別', p.getByRole('list', { name: '這張影像的分類標註' }).first(), undefined);
  await s.step('在「標註信心」按 4 分', p.getByRole('group', { name: /的標註信心$/ }).getByRole('button', { name: '4 分' }), 'click');
  await expect(p.getByRole('group', { name: /的標註信心$/ }).getByRole('button', { name: '4 分' })).toHaveAttribute('aria-pressed', 'true');
  console.log(`[B3] ${acc} → ${answerOf(acc)}（4 分）`);
  // 存過後類別沒有再改，主要按鈕變成「開啟下一筆」，直接開下一筆待處理研究（不會重複存）
  const uid1 = uidNow();
  await s.step('按「開啟下一筆」', actions.getByRole('button', { name: '開啟下一筆', exact: true }), 'click', {
    detail: '剛存好的類別沒有再修改時，按鈕會顯示「開啟下一筆」，直接打開下一筆還沒標的研究。',
  });
  await expect.poll(() => uidNow() !== uid1, { timeout: 30_000 }).toBe(true);

  // 其餘待處理：輸入類別 →「儲存並開啟下一筆」
  const done = [acc];
  for (let i = 0; i < 10; i++) {
    const last = p.getByTestId('workbench-status').filter({ hasText: '已經沒有待處理的影像了' });
    if (await last.isVisible()) break;
    await expect(viewport).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
    acc = await caseName();
    if (done.includes(acc)) break;
    const uid = uidNow();
    const first = done.length === 1;
    await s.step(`在「標註類別」輸入 ${answerOf(acc)}`, field, { fill: answerOf(acc) });
    await s.step('按「儲存並開啟下一筆」', actions.getByRole('button', { name: '儲存並開啟下一筆' }), 'click', first
      ? { detail: '存檔後自動打開下一筆還沒標的研究，不用回清單。' }
      : {});
    console.log(`[B3] ${acc} → ${answerOf(acc)}`);
    done.push(acc);
    await expect.poll(async () => uidNow() !== uid || (await last.isVisible()), { timeout: 30_000 }).toBe(true);
  }
  await expect(p.getByTestId('workbench-status')).toContainText('已經沒有待處理的影像了');
  await s.step('顯示「已經沒有待處理的影像了」', p.getByTestId('workbench-status'), undefined);
  await s.step('按「← 回待處理清單」', p.getByRole('link', { name: '← 回待處理清單' }), 'click');
  await expect(progress).toBeVisible();
  console.log(`[B3] 標註後：${flat(await progress.innerText())}（本次標 ${done.length} 筆：${done.join('、')}）`);
  await expect(p.getByTestId('pending-count')).toHaveText('0');
  await s.note('進度變成全部已確認，類別欄顯示結果');

  s.section('完成後的樣子', '待處理清單的進度卡顯示全部已確認、待處理 0；每個研究的「類別」欄顯示 normal 或 abnormal。回到工作台，影像左上角會標出這個研究的分類。');
  s.section('常見問題', [
    '- 「只儲存」按不下去：還沒輸入類別。畫面提示「先在「標註類別」輸入類別（例如 normal、abnormal），才能儲存。」',
    '- 換張或離開時被擋下：畫面顯示「目前影像有尚未儲存的標註，請先儲存或捨棄草稿再換張。」請先儲存或按「捨棄草稿」。',
    '- 窗寬窗位輸入錯誤：畫面顯示「窗寬必須是大於 0 的數字，窗位必須是數字。」也可以直接選「器官窗」的預設值。',
  ].join('\n'));
  await s.finish();
});
