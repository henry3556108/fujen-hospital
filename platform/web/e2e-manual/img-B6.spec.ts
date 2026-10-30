import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B6（pi01）：建立訓練精靈：判斷影像類別 → 標註資料集「手冊-胸部影像研究 分類標註」（20 筆）→ 設定名稱 → 開始訓練，等到完成。
import { RUN1 } from './img-common';

test('B6 送出訓練', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  const s = await startScenario(browser, { id: 'B6', title: '送出訓練', role: 'pi01', manual: '02-計畫主持人', project: IMG_PROJECT });
  const p = s.page;
  // 鏡頭外：重跑時把上次同名的訓練設定改名（同名會被擋下「訓練設定「…」已存在」）
  psql(`UPDATE training_settings SET name = name || '-重跑前' || id WHERE name='${RUN1}' AND project_id=(SELECT id FROM projects WHERE name='${IMG_PROJECT}')`);
  s.section('目的', '用標註好的影像訓練分類模型，不用寫程式。');
  s.section('開始前準備', '專案裡已有確認過的分類標註，且至少有 2 種類別（本專案是 normal 與 abnormal，共 20 個研究）。');

  await s.step('按左側選單的「建立模型」', sideNav(p).getByRole('link', { name: SIDE.training, exact: true }), 'click');
  await s.step('按右上角「建立訓練」', p.getByRole('link', { name: '建立訓練', exact: true }).first(), 'click');
  await expect(p.getByRole('heading', { level: 1, name: '建立訓練' })).toBeVisible();
  await s.step('研究目的選「判斷影像類別」', p.locator('label.ui-option').filter({ hasText: '判斷影像類別' }), 'click', {
    detail: '影像可以選「判斷影像類別」（分類）、「圈出位置」（偵測）、「標出範圍」（分割）。',
  });
  await s.step('按「下一步：確認資料」', p.getByRole('button', { name: '下一步：確認資料' }), 'click');
  const ds = p.getByLabel('標註資料集', { exact: true });
  await expect(ds).toBeVisible();
  const options = await ds.locator('option').allInnerTexts();
  console.log(`[B6] 標註資料集選項：${options.join(' / ')}`);
  const pick = options.find((o) => o.includes('分類標註'))!;
  await s.step('「標註資料集」選分類標註（20 筆）', ds, { select: { label: pick } }, {
    detail: '專案的分類標註會自動整理成「<專案名稱> 分類標註」這份資料集；也可以選研究助理匯入診斷時建立的資料集。',
  });
  const card = p.getByTestId('label-dataset-summary');
  await expect(card).toBeVisible();
  console.log(`[B6] 資料集：${flat(await card.innerText())}`);
  await s.step('確認筆數與類別分布', card, undefined);
  await s.step('按「下一步：確認並送出」', p.getByRole('button', { name: '下一步：確認並送出' }), 'click');
  const form = p.getByRole('form', { name: '確認並送出' });
  await expect(form).toBeVisible();
  await s.note('第 3 步可調整資料分割比例與進階設定', {
    detail: '「進階設定」裡有影像範圍、Label、Resize、訓練回合、學習率與資料增強；不熟悉可以直接用預設值。',
  });
  await s.step(`在「設定名稱」輸入 ${RUN1}`, form.getByLabel('設定名稱'), { fill: RUN1 });
  await s.step('按「開始訓練」', form.getByRole('button', { name: '確認並送出訓練', exact: true }), 'click');
  await expect(p).toHaveURL(/\/training\/runs\/\d+$/, { timeout: 60_000 });
  const runId = /\/training\/runs\/(\d+)/.exec(p.url())![1];
  const st = p.getByTestId('run-status');
  console.log(`[B6] 已送出訓練 #${runId}：${flat(await st.innerText())}`);
  await s.step('畫面顯示這次訓練與目前狀態', st, undefined);
  await s.wait('等待訓練完成（自動更新）', () => expect(st).toHaveText(/目前狀態：(已完成|失敗|已取消)/, { timeout: 40 * 60_000 }));
  const final = flat(await st.innerText());
  console.log(`[B6] 訓練 #${runId}：${final}`);
  expect(final).toContain('已完成');
  const verdict = p.getByTestId('verdict');
  await expect(verdict.first()).toBeVisible();
  console.log(`[B6] 結果：${flat(await verdict.first().innerText())}`);
  await s.step('「模型好不好？」顯示結論', verdict.first(), undefined);

  s.section('完成後的樣子', `訓練頁顯示「目前狀態：已完成」，下方「模型好不好？」列出結論與重點指標。左側選單「建立模型」的訓練紀錄裡可以找到「${RUN1}」。`);
  s.section('常見問題', [
    '- 送出時被擋下「分類至少要有 2 個類別」：標註只有一種類別，請先補標另一類，或在進階設定的「Label」確認兩類都有列出。',
    '- 按「開始訓練」後出現「訓練設定「…」已存在」：設定名稱不能重複，請換一個名稱。',
    '- 送出後不知道去哪看：送出後會直接打開這次訓練的頁面，狀態會自動更新；之後也可以在「建立模型」的訓練紀錄找到。排隊時會顯示「排在第 N 位」。',
  ].join('\n'));
  await s.finish();
});
