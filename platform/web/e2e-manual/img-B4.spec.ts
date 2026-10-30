import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { DIAG_CSV, IMG_PROJECT, flat } from './img-common';
import { startScenario } from './kit';

// B4（ra01）：上傳診斷結果 CSV（ACC0001–ACC0015 的 normal／abnormal），以影像編號對照，建立標註資料集「胸部影像診斷」。
// 其餘 5 個研究（ACC0016–ACC0020）留給 B3 醫師手動標註。
export const DATASET = '胸部影像診斷';

test('B4 用既有診斷結果批次建立標註', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B4', title: '用診斷結果批次建立標註', role: 'ra01', manual: '04-研究助理', project: IMG_PROJECT });
  const p = s.page;
  s.section('目的', '醫院已經有的診斷結果（CSV），一次轉成分類標註，不用醫師再一張一張標。');
  s.section('開始前準備', [
    '準備一份 CSV：第一列是欄名，一欄是影像編號（Accession Number）或病歷號，一欄是診斷。本手冊用的檔案「胸部影像診斷.csv」內容如下（共 15 列）：',
    '',
    '```',
    'accession_number,diagnosis',
    'ACC0001,abnormal',
    'ACC0002,normal',
    '…',
    '```',
    '',
    '影像要先匯入到同一個專案。',
  ].join('\n'));

  await s.step('按左側選單的「影像標註」', sideNav(p).getByRole('link', { name: SIDE.labeling, exact: true }), 'click');
  await s.step('點「標註資料集」分頁', p.getByRole('navigation', { name: '影像標註分頁' }).getByRole('link', { name: '標註資料集' }), 'click');
  const form = p.getByRole('form', { name: '匯入診斷結果' });
  await expect(form).toBeVisible();
  await s.step('在「匯入診斷結果」按「選擇檔案」', form.getByRole('button', { name: '選擇檔案' }), { upload: DIAG_CSV });
  await s.step('「用哪一種編號」選影像編號', form.getByLabel('用哪一種編號對照影像'), { select: 'accession_number' });
  const preview = form.getByTestId('csv-preview');
  await expect(preview).toContainText('可配對 15 列');
  console.log(`[B4] 預覽：${flat(await preview.innerText())}`);
  await s.step('預覽顯示可配對 15 列', preview, undefined, {
    detail: '預覽會列出可配對、找不到研究、診斷衝突、資料不完整各幾列，確認後再匯入。',
  });
  await s.step('確認「建立新資料集」已選取', form.getByRole('radio', { name: '建立新資料集' }), undefined);
  await s.step(`在「新資料集名稱」輸入 ${DATASET}`, form.getByLabel('新資料集名稱'), { fill: DATASET });
  await s.step('按「匯入」', form.getByRole('button', { name: '匯入', exact: true }), 'click');
  const result = p.getByTestId('csv-result');
  await s.wait('等待匯入完成', () => expect(result).toContainText('已標註 15 列', { timeout: 60_000 }), { manual: false });
  console.log(`[B4] 結果：${flat(await result.innerText()).slice(0, 200)}`);
  await s.step('結果顯示已標註 15 列', result.getByRole('alert').or(result.locator('.alert')).first(), undefined);
  await s.step('按「查看這份標註資料集」', result.getByRole('link', { name: '查看這份標註資料集' }), 'click');
  await expect(p.getByTestId('dataset-summary')).toBeVisible();
  await s.note('資料集顯示筆數與類別統計');

  s.section('完成後的樣子', `「標註資料集」清單多一份「${DATASET}」，打開可以看到已確認 15 筆、類別 normal 與 abnormal 的筆數。這份資料集可以直接拿去建立模型。`);
  s.section('常見問題', [
    '- 預覽出現「有 N 列在目前專案找不到影像」：診斷表可能是別的專案的，或影像還沒匯入。畫面會顯示目前專案名稱與這個專案的影像筆數。',
    '- 同一份 CSV 再匯入一次：說明寫「匯入的標註直接算已確認；重新匯入會更新，不會重複。」結果會顯示「更新」「未變動」各幾筆。',
    '- 欄名不是 accession_number、diagnosis：在「編號在哪一欄」「診斷在哪一欄」自己指定，預設是「自動辨識」。',
  ].join('\n'));
  await s.finish();
});
