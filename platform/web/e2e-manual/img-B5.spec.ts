import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B5（md01）：對 ACC0001 第 3 張送出自動標註（本機是假的自動標註服務，結果只示範流程），在工作台開啟草稿、用筆刷修正後儲存。
const ACC = 'ACC0001';
const maskCount = async (t: string) => Number(/已塗 (\d+) 個像素/.exec(t)?.[1] ?? 0);

test('B5 讓 AI 先標、醫師再修', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B5', title: '自動標註後再修正', role: 'md01', manual: '03-醫師', project: IMG_PROJECT });
  const p = s.page;
  // 鏡頭外：重跑時先刪掉上次自動標註產生的分割標註
  psql(`DELETE FROM label_annotations WHERE kind='segmentation' AND source='autolabel' AND project_id=(SELECT id FROM projects WHERE name='${IMG_PROJECT}')`);
  s.section('目的', '分割、偵測手動畫很慢。先讓自動標註模型產生草稿，醫師在工作台修改後存成正式標註。');
  s.section('開始前準備', '專案裡已有影像，且系統管理者已接好自動標註服務（「模型」下拉選單有選項）。');

  await s.step('按左側選單的「影像標註」', sideNav(p).getByRole('link', { name: SIDE.labeling, exact: true }), 'click');
  await s.step('點「自動標註」分頁', p.getByRole('navigation', { name: '影像標註分頁' }).getByRole('link', { name: '自動標註' }), 'click');
  const form = p.getByRole('form', { name: '送出自動標註' });
  const model = form.getByLabel('模型', { exact: true });
  await expect(model).toBeEnabled({ timeout: 30_000 });
  const models = await model.locator('option').allInnerTexts();
  console.log(`[B5] 可用模型：${models.join(' / ')}`);
  const pick = models.find((m) => m.includes('分割')) ?? models[0];
  await s.step('在「模型」選自動標註模型', model, { select: { label: pick } }, {
    detail: '括號內是模型種類（分割或偵測）與會標出的類別。',
  });
  const study = form.getByLabel('研究', { exact: true });
  const opt = (await study.locator('option').allInnerTexts()).find((t) => t.startsWith(ACC))!;
  await s.step(`在「研究」選 ${ACC}`, study, { select: { label: opt } });
  const image = form.getByLabel('影像', { exact: true });
  await expect(image).toBeEnabled({ timeout: 60_000 });
  await s.step('在「影像」選第 3 張', image, { select: { label: '第 3 張' } });
  await s.step('按「送出自動標註」', form.getByRole('button', { name: '送出自動標註' }), 'click');
  const result = p.getByTestId('autolabel-result');
  await s.wait('等待自動標註完成', () => expect(result).toContainText(/自動標註完成：已存為.*標註 #\d+/, { timeout: 120_000 }), { manual: false });
  const text = flat(await result.innerText());
  console.log(`[B5] ${text}`);
  const annotationId = Number(/標註 #(\d+)/.exec(text)![1]);
  await s.step('顯示「自動標註完成」與標註編號', result, undefined);
  await s.step('按「在標註工作台開啟編輯」', result.getByRole('link', { name: '在標註工作台開啟編輯' }), 'click');

  await expect(p.getByText(`正在編輯標註 #${annotationId}`)).toBeVisible({ timeout: 60_000 });
  const vp = p.getByTestId('viewport').first();
  await s.wait('等待影像與草稿載入', () => expect(vp).toHaveAttribute('data-ready', '1', { timeout: 60_000 }), { manual: false });
  const status = p.getByTestId('workbench-status');
  console.log(`[B5] 開啟：${flat(await status.innerText())}`);
  await s.step('影像上疊著自動標註的草稿', vp, undefined, { zoom: false });
  await s.step('「標註狀態」顯示待確認', p.getByTestId('annotation-state'), undefined, {
    detail: '自動標註的結果先存成「待確認」的草稿；醫師儲存或按「直接確認」後才會用在訓練。',
  });

  const info = p.getByTestId('mask-info');
  const segmentation = (await info.count()) > 0;
  if (segmentation) {
    const before = await maskCount(await info.innerText());
    await s.step('確認「筆刷」已選取', p.getByRole('button', { name: '筆刷', exact: true }), undefined);
    await s.step('「筆刷大小」可左右拖曳調整', p.getByLabel('筆刷半徑（像素）', { exact: true }), undefined);
    const canvas = vp.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
    await s.step('在「標註類別」輸入 nodule', p.getByRole('combobox', { name: '標籤' }), { fill: 'nodule' }, {
      detail: '筆刷會用目前的類別塗；草稿裡已有的類別會保留。',
    });
    await s.wait('在影像上拖曳，補塗漏掉的範圍', async () => {
      await p.mouse.move(...at(0.72, 0.7), { steps: 10 });
      await p.mouse.down();
      await p.mouse.move(...at(0.78, 0.76), { steps: 12 });
      await p.mouse.move(...at(0.84, 0.8), { steps: 12 });
      await p.mouse.up();
    });
    const after = await maskCount(await info.innerText());
    console.log(`[B5] 已塗像素 ${before} → ${after}`);
    await s.step('下方顯示塗了多少像素', info, undefined);
  } else {
    await s.note('影像上顯示自動畫出的框');
  }
  await s.step('按「只儲存」存成正式標註', p.getByRole('button', { name: '只儲存', exact: true }), 'click');
  await expect(status).toContainText(`已儲存`, { timeout: 30_000 });
  console.log(`[B5] 儲存：${flat(await status.innerText())}`);
  await s.step('上方顯示已儲存與版本', status, undefined);
  const list = p.getByRole('table', { name: '標註清單' });
  await expect(list).toBeVisible();
  console.log(`[B5] 標註清單：${flat(await list.innerText()).slice(0, 300)}`);
  await s.step('來源「自動標註」、版本變成 2', list, undefined, { zoom: false });

  s.section('完成後的樣子', '「這個研究的標註」清單裡，這筆分割標註的狀態變成「已確認」，「來源」欄是「自動標註」，「版本」是 2（醫師改過一次）；「自動標註」分頁的「執行紀錄」可以再開回這筆結果。');
  s.section('常見問題', [
    '- 「模型」下拉選單是空的、按鈕不能按：還沒有接好自動標註服務，請聯絡系統管理者。',
    '- 想換張修改卻被擋下：畫面顯示「目前影像有尚未儲存的標註，請先儲存或捨棄草稿再換張。」',
    '- 一次要送很多張：目前一次只能選一個研究的一張影像送出，要逐張送。',
  ].join('\n'));
  await s.finish();
});
