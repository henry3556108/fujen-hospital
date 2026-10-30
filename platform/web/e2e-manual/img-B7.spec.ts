import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { IMG_PROJECT, flat } from './img-common';
import { RUN1 } from './img-common';
import { startScenario } from './kit';

// B7（pi01）：看 B6 訓練的結果 → 套用同一份已存設定、把訓練回合數改成 5 再跑一次 → 到「使用模型」比較兩次訓練，選定要用的模型。
test('B7 看訓練結果、比較、決定用哪個', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  const s = await startScenario(browser, { id: 'B7', title: '看結果、比較並選定模型', role: 'pi01', manual: '02-計畫主持人', project: IMG_PROJECT });
  const p = s.page;
  s.section('目的', '判斷模型能不能用；同一份設定改一點再跑一次，把兩次結果放在一起比較，決定用哪一個。');
  s.section('開始前準備', `已經有一次完成的訓練（本手冊用「${RUN1}」，見「送出訓練」）。`);

  await s.step('按左側選單的「建立模型」', sideNav(p).getByRole('link', { name: SIDE.training, exact: true }), 'click');
  const table = p.getByRole('table', { name: '訓練清單' });
  const row = table.locator('tbody tr').filter({ has: p.getByRole('cell', { name: RUN1, exact: true }) }).first();
  await expect(row).toBeVisible();
  await s.step('訓練紀錄列出每次訓練的狀態與分數', row, undefined);
  await s.step('按這一列的「查看結果」', row.getByRole('link', { name: /^查看結果 #\d+$/ }), 'click');
  await expect(p).toHaveURL(/\/training\/runs\/\d+$/);
  const firstId = Number(/\/training\/runs\/(\d+)/.exec(p.url())![1]);
  const verdict = p.getByTestId('verdict').first();
  await expect(verdict).toBeVisible();
  await s.step('「模型好不好？」用白話說明結論', verdict, undefined);
  const facts = p.locator('summary', { hasText: '這次訓練的資料與設定' });
  await s.step('展開「這次訓練的資料與設定」', facts, 'click');
  await s.note('列出資料版本、測試筆數、亂數種子');

  // 同一份設定改回合數再跑
  await s.step('點「已存設定」分頁', p.getByRole('navigation', { name: '建立模型分頁' }).getByRole('link', { name: '已存設定' }), 'click');
  const apply = p.getByRole('link', { name: `套用「${RUN1}」`, exact: true }).first();
  await s.step(`在「${RUN1}」按「套用」`, apply, 'click');
  const form = p.getByRole('form', { name: '確認並送出' });
  await expect(form).toBeVisible();
  await expect(p.getByText(`已套用已存設定「${RUN1}」`)).toBeVisible();
  await s.step('上方顯示「已套用已存設定」', p.getByText(`已套用已存設定「${RUN1}」`), undefined);
  const adv = form.locator('summary', { hasText: /^進階設定：訓練回合/ });
  await s.step('展開「進階設定：訓練回合、學習率…」', adv, 'click');
  const epochs = form.getByLabel('訓練回合數', { exact: true });
  console.log(`[B7] 原本訓練回合數：${await epochs.inputValue()}`);
  await s.step('把「訓練回合數」改成 5', epochs, { fill: '5' });
  await s.step('按「開始訓練」', form.getByRole('button', { name: '確認並送出訓練', exact: true }), 'click');
  await expect(p).toHaveURL(/\/training\/runs\/\d+$/, { timeout: 60_000 });
  const secondId = Number(/\/training\/runs\/(\d+)/.exec(p.url())![1]);
  const st = p.getByTestId('run-status');
  await s.wait('等待第 2 次訓練完成', () => expect(st).toHaveText(/目前狀態：(已完成|失敗|已取消)/, { timeout: 40 * 60_000 }));
  console.log(`[B7] 訓練 #${firstId} → #${secondId}：${flat(await st.innerText())}`);
  expect(flat(await st.innerText())).toContain('已完成');

  // 比較
  await s.step('按「前往使用模型」', p.getByRole('link', { name: '前往使用模型' }), 'click');
  await expect(p).toHaveURL(new RegExp(`/models/${secondId}/result`));
  const cmp = p.getByRole('table', { name: '訓練比較' });
  await expect(cmp.locator('tbody tr')).toHaveCount(2, { timeout: 30_000 });
  console.log(`[B7] 比較：${flat(await cmp.innerText())}`);
  await s.step('「歷次訓練結果比較」列出兩次訓練', cmp, undefined, { zoom: false });
  await s.step('看「主要指標」的分數與白話說明', p.getByTestId('key-metrics'), undefined);
  await s.step('按麵包屑「使用模型」回模型清單', p.getByRole('link', { name: '使用模型', exact: true }).last(), 'click');
  const models = p.getByRole('table', { name: '模型清單' });
  await expect(models).toBeVisible();
  await s.step('模型清單每次訓練各是一個模型', models, undefined, {
    zoom: false,
    detail: '比較後要用哪一個，就點那個模型的名稱，再到「預測新資料」或「分享與服務」。',
  });

  s.section('完成後的樣子', '模型的「模型結果」頁有「歷次訓練結果比較」表格，同一份設定的每次訓練並排列出完成日期、資料版本、測試筆數與主要指標；目前這個模型標成「（這個模型）」。');
  s.section('常見問題', [
    '- 比較表出現「測試資料不同，不宜直接排名」：兩次訓練的資料版本、切分或亂數種子不同，評分用的測試資料不一樣。',
    '- 出現「測試筆數少，結果僅供參考。」：測試資料太少，增加影像或調整資料分割比例後再訓練。',
    '- 想用一模一樣的設定與資料再跑：在訓練頁按「依原版本重跑」；要改設定則到「已存設定」按「套用」，送出時會一併儲存修改。',
  ].join('\n'));
  await s.finish();
});
