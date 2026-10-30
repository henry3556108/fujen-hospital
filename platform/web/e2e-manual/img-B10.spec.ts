import { expect, test, type Download } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B10（ca01）：下載胸部 CT 分類模型（Keras .h5）、使用說明，並匯出訓練原始碼，帶到平台外使用。
test('B10 把模型或程式帶走', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B10', title: '下載模型與匯出程式', role: 'ca01', manual: '05-程式助理', project: IMG_PROJECT });
  const p = s.page;
  const files: string[] = [];
  p.on('download', (d: Download) => files.push(d.suggestedFilename()));
  s.section('目的', '把訓練好的模型與訓練程式下載到自己的電腦，在平台外用 Python 載入使用，或交給其他團隊。');
  s.section('開始前準備', '帳號在這個專案要有 Training 權限（下載模型）與 Coding 權限（匯出訓練原始碼）。電腦上要有 Python 與範例列出的套件。');

  await s.step('按左側選單的「使用模型」', sideNav(p).getByRole('link', { name: SIDE.models, exact: true }), 'click');
  const models = p.getByRole('table', { name: '模型清單' });
  await expect(models).toBeVisible();
  await s.step('點要下載的模型名稱', models.locator('tbody tr').first().getByRole('link').first(), 'click');
  await s.step('點「分享與服務」分頁', p.getByRole('navigation', { name: '模型分頁' }).getByRole('link', { name: '分享與服務' }), 'click');
  await s.step('點「模型下載」', p.getByRole('navigation', { name: '分享與服務分頁' }).getByRole('link', { name: '模型下載' }), 'click');
  const dlBtn = p.getByRole('button', { name: /^下載模型「/ });
  await expect(dlBtn).toBeVisible();
  await s.step('影像模型是 Keras .h5，按「下載模型」', dlBtn, 'click');
  const okAlert = p.locator('.alert, [role="alert"], [role="status"]').filter({ hasText: /已下載|已儲存|下載/ }).first();
  await s.wait('等待下載完成', () => expect(okAlert).toBeVisible({ timeout: 120_000 }), { manual: false });
  console.log(`[B10] 下載模型：${flat(await okAlert.innerText())}`);
  await s.step('上方顯示下載結果', okAlert, undefined);
  await s.step('右側有 Python 載入範例', p.getByText('Python 載入範例').first(), undefined, {
    detail: '照範例用 keras.models.load_model 載入，影像先縮放成範例寫的大小再預測。下方「依賴套件版本」列出要安裝的套件。',
  });
  await s.step('按「下載範例與環境說明」', p.getByRole('button', { name: '下載範例與環境說明' }), 'click');
  await s.step('按「匯出訓練原始碼」', p.getByRole('button', { name: '匯出訓練原始碼' }), 'click');
  await expect.poll(() => files.length, { timeout: 120_000 }).toBeGreaterThanOrEqual(3);
  console.log(`[B10] 下載的檔案：${files.join('、')}`);
  await s.note('三個檔案都下載到電腦');

  s.section('完成後的樣子', `電腦的下載資料夾裡有模型檔（.h5）、使用說明（-使用說明.txt）與訓練原始碼壓縮檔。在別台電腦安裝依賴套件後，照「Python 載入範例」就能載入模型並預測。`);
  s.section('常見問題', [
    '- 看不到「下載模型」按鈕：畫面顯示「下載模型檔需要 Training 權限；如需使用，請聯絡專案負責人或系統管理者。」',
    '- 看不到「匯出訓練原始碼」：帳號沒有 Coding 權限，請專案負責人在成員權限加上 Coding。',
    '- 不確定下載的檔案是否完整：說明檔與畫面下方都列出模型檔的 SHA-256，可以比對。',
  ].join('\n'));
  await s.finish();
});
