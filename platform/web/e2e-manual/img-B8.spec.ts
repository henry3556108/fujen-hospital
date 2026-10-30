import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { DICOM_DIR, IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B8（md01）：用最新的胸部 CT 分類模型，(1) 對專案全部資料批次預測，(2) 上傳 2 張 DICOM 預測，(3) 在預測紀錄下載結果。
const FILES = ['IM0001.dcm', 'IM0003.dcm'].map((f) => path.join(DICOM_DIR, 'study_0002/series_001', f));

test('B8 用模型判讀新資料', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const s = await startScenario(browser, { id: 'B8', title: '用模型判讀新影像', role: 'md01', manual: '03-醫師', project: IMG_PROJECT });
  const p = s.page;
  s.section('目的', '把訓練好的模型用在影像上，看每張影像的預測類別，並下載結果檔。');
  s.section('開始前準備', '專案裡已有訓練完成的模型（計畫主持人選定的那一個）。要上傳的新影像可以是 DICOM、NIfTI、ITK（.mha）或 PNG。');

  await s.step('按左側選單的「使用模型」', sideNav(p).getByRole('link', { name: SIDE.models, exact: true }), 'click');
  const models = p.getByRole('table', { name: '模型清單' });
  await expect(models).toBeVisible();
  const first = models.locator('tbody tr').first();
  console.log(`[B8] 模型：${flat(await first.innerText())}`);
  await s.step('點清單最上面的模型名稱', first.getByRole('link').first(), 'click');
  await s.step('點「預測新資料」分頁', p.getByRole('navigation', { name: '模型分頁' }).getByRole('link', { name: '預測新資料' }), 'click');

  // 批次：全部資料
  const batch = p.getByRole('form', { name: '多張影像一起預測' });
  await s.step('「資料範圍」選「全部資料」', batch.getByLabel('資料範圍'), { select: 'all' }, {
    detail: '也可以選「測試資料」，只預測模型訓練時沒看過的影像。',
  });
  await s.step('按「多張影像一起預測」', batch.getByRole('button', { name: '多張影像一起預測' }), 'click');
  const grid = p.getByRole('list', { name: '影像推論結果' });
  await s.wait('等待批次預測完成', () => expect(grid.getByTestId('image-result').first()).toBeVisible({ timeout: 20 * 60_000 }));
  const title = p.getByRole('heading', { name: /^預測結果 #\d+/ });
  console.log(`[B8] 批次：${flat(await title.innerText())}，${await grid.getByTestId('image-result').count()} 張`);
  await s.step('每張影像下方顯示預測類別', grid.getByTestId('image-result').first(), undefined);

  // 上傳新影像
  const up = p.getByRole('form', { name: '上傳影像預測' });
  await s.step('在「影像檔」按「選擇檔案」選 2 張影像', up.getByRole('button', { name: '選擇檔案' }), { upload: FILES });
  await s.step('按「上傳並預測」', up.getByRole('button', { name: '上傳並預測' }), 'click');
  await s.wait('等待預測完成', () => expect(title).toContainText('（2 筆）', { timeout: 5 * 60_000 }), { manual: false });
  console.log(`[B8] 上傳：${flat(await title.innerText())}；${flat(await grid.innerText()).slice(0, 160)}`);
  await s.step('結果顯示這 2 張影像的預測', p.locator('section').filter({ has: title }).first(), undefined, { zoom: false });

  // 紀錄與下載
  await s.step('點「預測紀錄」分頁', p.getByRole('navigation', { name: '模型分頁' }).getByRole('link', { name: '預測紀錄' }), 'click');
  const hist = p.getByRole('table', { name: '預測紀錄' });
  await expect(hist.locator('tbody tr').first()).toBeVisible();
  console.log(`[B8] 紀錄：${flat(await hist.innerText()).slice(0, 240)}`);
  await s.step('紀錄列出每次預測的方式與筆數', hist, undefined, { zoom: false });
  const dl = p.waitForEvent('download');
  await s.step('按最上面一筆的「下載」', hist.locator('tbody tr').first().getByRole('button', { name: /^下載 #\d+$/ }), 'click');
  const file = await dl;
  console.log(`[B8] 下載檔名：${file.suggestedFilename()}`);
  await s.note('結果檔下載到電腦');

  s.section('完成後的樣子', '「預測新資料」下方出現「預測結果」，每張影像標出預測類別；「預測紀錄」留下每一次預測，可以按「檢視」再看一次或按「下載」取得結果檔。');
  s.section('常見問題', [
    '- 批次預測要等一下：畫面顯示「批次預測…在背景執行，完成後自動顯示結果；離開此頁也不影響，可稍後在預測紀錄查看。」',
    '- 看不到完整的訓練結果與圖表：醫師帳號沒有 Training 權限，「模型結果」只顯示主要指標，並註明「完整的結果、圖表與報表需要 Training 權限。」',
    '- 清單裡沒有模型：畫面顯示「這個專案還沒有訓練完成的模型」，請計畫主持人先完成訓練。',
  ].join('\n'));
  await s.finish();
});
