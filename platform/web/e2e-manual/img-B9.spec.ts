import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { DICOM_DIR, IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B9（pi01）：把選定的胸部 CT 分類模型分享給 md01（並加入自己以便試呼叫），看程式呼叫端點，在網頁上試呼叫一次。
const TITLE = '胸部 CT 正常異常判讀';
const FILE = path.join(DICOM_DIR, 'study_0004/series_001/IM0002.dcm');

test('B9 把模型發布給其他人用', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B9', title: '分享模型與試呼叫', role: 'pi01', manual: '02-計畫主持人', project: IMG_PROJECT });
  const p = s.page;
  // 鏡頭外：重跑時先移除上次的同名分享
  psql(`DELETE FROM model_deployments WHERE title='${TITLE}'`);
  s.section('目的', '把模型分享給院內同事使用，並提供程式呼叫端點給其他系統；分享前先在網頁上試呼叫一次。');
  s.section('開始前準備', '已選定要分享的模型（見「看結果、比較並選定模型」），並知道要分享給哪些同事的帳號。帳號需要有這個專案的 Training 權限才能分享。');

  await s.step('按左側選單的「使用模型」', sideNav(p).getByRole('link', { name: SIDE.models, exact: true }), 'click');
  const models = p.getByRole('table', { name: '模型清單' });
  await expect(models).toBeVisible();
  await s.step('點選定的模型名稱', models.locator('tbody tr').first().getByRole('link').first(), 'click');
  await s.step('點「分享與服務」分頁', p.getByRole('navigation', { name: '模型分頁' }).getByRole('link', { name: '分享與服務' }), 'click');
  const form = p.getByRole('form', { name: '分享給同事使用' });
  await expect(form).toBeVisible();
  await s.step(`「顯示名稱」輸入 ${TITLE}`, form.getByLabel('顯示名稱（同事看到的名稱，可用中文）'), { fill: TITLE });
  await s.step('「分享給」輸入 md01, pi01', form.getByLabel('分享給（同事的帳號，以逗號分隔）'), { fill: 'md01, pi01' }, {
    detail: '把自己的帳號也加進去，才能在下方「試呼叫」；不在名單內的帳號呼叫會被拒絕（403）。',
  });
  await p.keyboard.press('Escape');
  await s.step('按「分享給同事使用」', form.getByRole('button', { name: '分享給同事使用' }), 'click');
  const ok = p.getByText(`已把「${TITLE}」分享給`);
  await expect(ok).toBeVisible();
  console.log(`[B9] ${flat(await ok.innerText())}`);
  await s.step('上方顯示已分享給哪些人', ok, undefined);
  const list = p.getByRole('table', { name: '已分享的模型' });
  await s.step('「已分享的模型」列出這個分享', list, undefined, { zoom: false });

  await s.step('展開「給資訊人員：程式呼叫方式」', p.locator('summary', { hasText: '給資訊人員：程式呼叫方式' }), 'click');
  const ep = p.getByRole('table', { name: '程式呼叫端點' });
  console.log(`[B9] 端點：${flat(await ep.innerText())}`);
  await s.step('列出呼叫端點與呼叫範例', ep, undefined);

  const call = p.getByRole('form', { name: '試呼叫' });
  await s.step('在「試呼叫」按「選擇檔案」選一張影像', call.getByRole('button', { name: '選擇檔案' }), { upload: FILE });
  await s.step('按「送出試呼叫」', call.getByRole('button', { name: /^送出試呼叫/ }), 'click');
  const reply = call.getByText(/^呼叫成功（推論紀錄 #\d+）。/);
  await s.wait('等待呼叫結果', () => expect(reply).toBeVisible({ timeout: 120_000 }), { manual: false });
  console.log(`[B9] ${flat(await reply.innerText())}；${flat(await call.getByLabel('試呼叫的回應').innerText()).slice(0, 200)}`);
  await s.step('顯示「呼叫成功」與回應內容', call.getByLabel('試呼叫的回應'), undefined);

  await s.step('點「呼叫說明」分頁', p.getByRole('navigation', { name: '分享與服務分頁' }).getByRole('link', { name: '呼叫說明' }), 'click');
  await s.note('呼叫說明提供 curl 與 Python 範例');

  s.section('完成後的樣子', `「已分享的模型」列出「${TITLE}」與分享對象；md01 登入後在「使用模型」看到這個模型並標示「分享給你」。資訊人員可依「呼叫說明」用程式呼叫，每次呼叫都記在「預測紀錄」。`);
  s.section('常見問題', [
    '- 按「分享給同事使用」出現「請填要分享的同事帳號，例如 md01」：「分享給」不能空白。',
    '- 試呼叫上方出現「你（帳號）不在「…」的分享對象中，呼叫會被拒絕（403）」：按「修改分享對象」把自己加入。',
    '- 不想再分享：按「停止分享」。專案成員仍可在「使用模型」使用這個模型，但程式呼叫的端點會立即停止接受呼叫。',
  ].join('\n'));
  await s.finish();
});
