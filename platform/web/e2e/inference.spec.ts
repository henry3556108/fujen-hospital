// 推論服務管理（模擬 API）：TC-B06-04 結果呈現。結構式 20 筆新增預測欄、影像 9 筆顯示結果，缺漏 0。
import { expect, loginAs, snap, test } from './fixtures';

const DICOM = (i: number) => ({ name: `IM${String(i + 1).padStart(4, '0')}.dcm`, mimeType: 'application/dicom', buffer: Buffer.from(`synthetic-${i}`) });

test.describe('推論服務管理', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'pi01');
    await page.goto('/inference');
    await expect(page.getByRole('heading', { level: 1, name: '推論服務管理' })).toBeVisible();
  });

  test('TC-B06-04 結構式：批次推論 20 筆，每一列都有預測欄', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: '批次推論' }).click();
    const table = page.getByRole('table', { name: '結構式推論結果' });
    await expect(table.getByRole('row')).toHaveCount(21);
    await expect(table.getByRole('columnheader').last()).toHaveText('prediction_note');
    const rows = await table.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? '')));
    const missing = rows.filter((r) => r.at(-2) === '' && r.at(-1) !== '特徵含缺值，無法預測');
    expect(missing).toEqual([]);
    await snap(page, testInfo.project.name, 'inference/tabular');
  });

  test('TC-B06-04 影像：上傳 9 張，每張都顯示影像與分類結果', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: '選擇 modality-cnn-run2' }).click();
    await page.getByLabel('影像檔').setInputFiles(Array.from({ length: 9 }, (_, i) => DICOM(i)));
    await page.getByRole('button', { name: '上傳並推論' }).click();
    const cards = page.getByTestId('image-result');
    await expect(cards).toHaveCount(9);
    for (let i = 0; i < 9; i += 1) {
      const card = cards.nth(i);
      await expect(card.getByRole('img')).toHaveJSProperty('complete', true);
      expect(await card.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await expect(card.getByTestId('result-label')).toHaveText(/^分類：(CT|MR)（\d+%）$/);
      await expect(card).toContainText(DICOM(i).name);
    }
    await snap(page, testInfo.project.name, 'inference/images');
  });

  test('物件偵測：方框疊在影像上，歷史可下載', async ({ page }) => {
    await page.getByRole('button', { name: '選擇 nodule-det-run3' }).click();
    await page.getByLabel('影像檔').setInputFiles([DICOM(0), DICOM(1)]);
    await page.getByRole('button', { name: '上傳並推論' }).click();
    await expect(page.getByTestId('result-box')).toHaveCount(2);
    const box = await page.getByTestId('result-box').first().boundingBox();
    const preview = await page.getByTestId('image-result').first().locator('.inference-preview').boundingBox();
    expect(box && preview && box.x >= preview.x && box.y >= preview.y
      && box.x + box.width <= preview.x + preview.width + 1).toBe(true);
    const history = page.getByRole('table', { name: '推論歷史' });
    const [download] = await Promise.all([page.waitForEvent('download'), history.getByRole('button', { name: '下載 #1' }).click()]);
    expect(download.suggestedFilename()).toBe('inference-1.json');
  });
});
