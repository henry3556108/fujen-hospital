import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { DICOM_DIR, IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B1（ra01）：把 20 個合成 DICOM 研究（整個資料夾）上傳到「手冊-胸部影像研究」，看匯入結果與匯入紀錄。
test('B1 把影像帶進專案', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B1', title: '把影像帶進專案', role: 'ra01', manual: '04-研究助理', project: IMG_PROJECT });
  const p = s.page;
  s.section('目的', '把研究要用的 DICOM 影像上傳到專案，之後才能標註與訓練。');
  s.section('開始前準備', `確認頂端「目前專案」是「${IMG_PROJECT}」。把要上傳的 DICOM 放在同一個資料夾（可以有子資料夾）。本手冊示範用的是 20 個合成研究、共 100 張影像。`);

  await s.step(`頂端「目前專案」是 ${IMG_PROJECT}`, p.locator('select#project-switcher'), undefined, {
    detail: '影像只會進到目前專案。要加到別的專案，請先在這裡切換。',
  });
  await s.step('按左側選單的「研究資料」', sideNav(p).getByRole('link', { name: SIDE.data, exact: true }), 'click');
  await s.step('按「加入資料」', p.getByRole('link', { name: '加入資料', exact: true }), 'click');
  const form = p.getByRole('form', { name: '從電腦上傳' });
  await expect(form).toBeVisible();
  await s.step('勾選「選擇整個資料夾」', form.getByRole('checkbox', { name: '選擇整個資料夾（保留資料夾路徑）' }), 'click');
  await s.step('按「選擇資料夾」，選影像資料夾', form.getByRole('button', { name: '選擇資料夾' }), { upload: DICOM_DIR }, {
    detail: '瀏覽器會詢問是否上傳整個資料夾，按「上傳」。',
  });
  await expect(form.getByText(/已選擇 \d+ 個檔案/)).toBeVisible();
  await s.step('確認「已選擇 100 個檔案」', form.getByText(/已選擇 \d+ 個檔案/), undefined);
  await s.step(`按「上傳到「${IMG_PROJECT}」」`, form.getByRole('button', { name: /^上傳到「/ }), 'click');
  const result = form.getByRole('region', { name: 'DICOM 匯入結果' });
  await s.wait('等待上傳與匯入完成', () => expect(result).toContainText(/新增 \d+、重複 \d+、失敗 \d+/, { timeout: 5 * 60_000 }));
  console.log(`[B1] 匯入結果：${flat(await result.innerText()).slice(0, 160)}`);
  await s.step('看「新增成功」「重複」「失敗」筆數', result.locator('dl.rd-import__stats'), undefined, { zoom: false });
  await s.step('按「查看匯入的影像」', form.getByRole('link', { name: '到影像清單查看' }), 'click');
  await expect(p.getByTestId('slideover-backdrop')).toHaveCount(0);
  const table = p.getByRole('table', { name: '影像清單' });
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await s.note('影像清單列出剛匯入的研究');

  await s.step('點「匯入紀錄」分頁', p.getByRole('navigation', { name: '影像分頁' }).getByRole('link', { name: '匯入紀錄' }), 'click');
  const jobs = p.getByRole('table', { name: '匯入紀錄' });
  await expect(jobs.locator('tbody tr').first()).toBeVisible();
  await s.step('最上面一筆是這次的匯入', jobs.locator('tbody tr').first(), undefined);
  await s.step('按「逐檔結果」', jobs.locator('tbody tr').first().getByRole('link', { name: /逐檔結果/ }), 'click');
  await expect(p.getByRole('heading', { name: '匯入結果' })).toBeVisible();
  await s.note('逐檔列出每個檔案的結果與原因');

  s.section('完成後的樣子', '影像清單出現 20 個研究；「匯入紀錄」最上面一筆顯示這次匯入的檔案數與結果，點「逐檔結果」可看每個檔案是新增、重複或失敗。');
  s.section('常見問題', [
    '- 同一批影像再上傳一次：結果會顯示「重複已有」，並說明「重複的影像已經在專案裡，略過、沒有再存一份。」不會覆蓋原本的影像。',
    '- 有檔案匯入失敗：「失敗的檔案不影響其他檔案，原因見下表。」可按「下載失敗清單」，修正後按「重新上傳」。',
    '- 影像傳到別的專案：上傳前先看「目標專案」與頂端「目前專案」，要加到別的專案請先切換。',
  ].join('\n'));
  await s.finish();
});
