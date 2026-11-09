// 第三輪後使用性測試的缺陷（docs/superpowers/plans/2026-10-03-qoca-ux.md「修正五個缺陷」）。
// 缺陷 5：批次結果表右側被切掉。重要欄位（預測結果、陽性的機率、預測對／錯、說明）在 1280 與 1440 px 寬時不必左右捲動就看得到。
import { expect, loginAs, snap, test } from './fixtures';
import { fixture } from './files';

const IMPORTANT = ['預測結果', 'diagnosis＝1 的機率', '預測對／錯', '說明'];

for (const width of [1280, 1440]) {
  test(`缺陷 5：${width} px 寬時批次結果的重要欄位不必左右捲動`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await loginAs(page, 'pi01');
    await page.goto('/inference');
    // 上傳一份 12 欄的 CSV（與使用性測試相同的欄位）
    await page.getByLabel('CSV 檔').setInputFiles(fixture('tabular/cohort_01.csv'));
    await page.getByRole('button', { name: '上傳並推論' }).click();
    const table = page.getByRole('table', { name: '預測結果' });
    await expect(table.getByRole('row')).toHaveCount(101);
    const box = page.locator('.inference-table');
    const headers = await table.getByRole('columnheader').allTextContents();
    expect(headers.slice(0, IMPORTANT.length + 2)).toEqual(['patient_id', 'diagnosis（實際）', ...IMPORTANT]);
    expect(await box.evaluate((el) => el.scrollLeft)).toBe(0);
    const frame = (await box.boundingBox())!;
    for (const name of IMPORTANT) {
      const cell = (await table.getByRole('columnheader', { name, exact: true }).boundingBox())!;
      expect(cell.x, `${name} 的左緣`).toBeGreaterThanOrEqual(frame.x - 1);
      expect(cell.x + cell.width, `${name} 的右緣在表格框內（${width} px）`).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
    // 其餘輸入欄位放在後面，可在表格內左右捲動；畫面上說出右側還有哪些欄位
    await expect(page.getByTestId('table-more-columns')).toHaveText(
      /^右側還有 \d+ 欄輸入的資料（age、sex、bmi.*），可在表格內左右捲動查看；「下載推論結果」有完整內容。$/);
    await snap(page, testInfo.project.name, `inference/batch-${width}`);
  });
}
