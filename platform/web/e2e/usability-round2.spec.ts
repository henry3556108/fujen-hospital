// 使用性測試第二輪（docs/usability/2026-10-03-after.md）的修正，以瀏覽器走一遍。
import { expect, expectNoHorizontalOverflow, loginAs, snap, test } from './fixtures';
import { fixture } from './files';

test.describe('使用性第二輪', () => {
  test('One-Hot 過的 sex 在訓練表單是一項、已勾選、寫出產生的欄位，存檔後可直接送出', async ({ page }, testInfo) => {
    await loginAs(page, 'pi01');
    await page.goto('/data/tabular/2/target');
    const overview = page.getByRole('form', { name: '設定 Target 與 Feature' });
    await overview.getByRole('radio', { name: '以 diagnosis 為 Target' }).check();
    for (const f of ['age', 'sex', 'bmi']) await overview.getByRole('checkbox', { name: f, exact: true }).check();
    await overview.getByRole('switch', { name: 'sex 當作類別' }).check();
    await overview.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText(/^已儲存：要預測的結果 diagnosis/)).toBeVisible();

    await page.getByRole('link', { name: '用這份資料建立訓練' }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    const features = form.getByRole('group', { name: '用來預測的資料（Feature）' });
    await expect(features.getByRole('checkbox', { name: 'sex（已轉成 sex_F、sex_M）' })).toBeChecked();
    await expect(features.getByRole('checkbox', { name: 'sex', exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'round2/onehot-feature');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText('已新增訓練設定「lung-clinical 訓練」。')).toBeVisible();
    await page.getByRole('button', { name: '送出訓練「lung-clinical 訓練」' }).click();
    await expect(page.getByTestId('run-status')).toContainText('已完成');
  });

  test('有缺值的 glucose：總覽與訓練表單都提醒並可一鍵補值；結果寫出用了幾位；批次預測補值後全部有結果', async ({ page }, testInfo) => {
    await loginAs(page, 'pi01');
    await page.goto('/data/tabular/2/target');
    const overview = page.getByRole('form', { name: '設定 Target 與 Feature' });
    await overview.getByRole('radio', { name: '以 diagnosis 為 Target' }).check();
    for (const f of ['age', 'glucose']) await overview.getByRole('checkbox', { name: f, exact: true }).check();
    await expect(overview.getByTestId('tf-missing')).toContainText(/glucose 有 \d+ 位病人沒有資料/);
    await expect(overview.getByRole('radio', { name: /^補上缺值/ })).toBeChecked();
    await overview.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('saved-missing')).toHaveText('補上缺值後使用');

    await page.getByRole('link', { name: '用這份資料建立訓練' }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await expect(form.getByTestId('ts-missing')).toContainText('glucose');
    await expect(form.getByRole('radio', { name: /^補上缺值/ })).toBeChecked();
    await snap(page, testInfo.project.name, 'round2/missing-choice');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await page.getByRole('button', { name: '送出訓練「lung-clinical 訓練」' }).click();
    await expect(page.getByTestId('run-status')).toContainText('已完成');
    await expect(page.getByTestId('data-usage')).toContainText('有 5 位的缺值（glucose 5 位）已用訓練資料的中位數或最常見的值補上');

    await page.goto('/inference');
    await page.getByRole('button', { name: '選擇 lung-clinical 訓練-run1' }).click();
    await page.getByRole('form', { name: '多位病人一起預測' }).getByRole('button', { name: '多位病人一起預測' }).click();
    await expect(page.getByTestId('table-summary')).toContainText('共 20 位，20 位有預測結果。其中 1 位有缺值');
    await expectNoHorizontalOverflow(page);
  });

  for (const width of [1280, 1440]) {
    test(`上傳欄位確認表在 ${width}px 寬不需橫向捲動；中文檔案按鈕；預覽列號從 1 起；頁首中文角色`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await loginAs(page, 'pi01');
      await page.goto('/data/tabular');
      await expect(page.getByTestId('header-role')).toHaveText('（計畫主持人）');
      const form = page.getByRole('form', { name: '上傳 CSV' });
      await expect(form.getByRole('button', { name: '選擇檔案' }).first()).toBeVisible();
      await expect(form.getByText('尚未選擇檔案').first()).toBeVisible();
      await form.getByLabel(/^CSV 檔案/).setInputFiles(fixture('tabular/cohort_01.csv'));
      await expect(form.getByText('cohort_01.csv')).toBeVisible();
      const table = form.getByRole('table', { name: '欄位確認' });
      await expect(table.getByRole('columnheader', { name: '檔案內容與提示' })).toBeVisible();
      const wrap = table.locator('xpath=..');
      const { scroll, client } = await wrap.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(scroll, `欄位確認表橫向溢出 ${scroll - client}px`).toBeLessThanOrEqual(client);
      await snap(page, testInfo.project.name, `round2/upload-table-${width}`);

      await page.goto('/data/tabular/2/preview');
      const preview = page.getByRole('table', { name: '資料預覽' });
      await expect(preview.getByRole('row').nth(1).getByRole('rowheader')).toHaveText('1');
    });
  }
});
