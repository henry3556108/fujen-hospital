// 使用性測試第三輪（docs/usability/2026-10-03-round2.md）的修正，以瀏覽器走一遍：
// 勾 7 欄存成「7 個欄位（sex、smoker 自動拆成 5 欄）」→ 邏輯斯迴歸 K 折訓練 → 一句結論與依演算法的建議 →
// 用中文名稱部署 → 「用這個模型預測病人」→ 一位病人與多位病人（預測對／錯）→ 即時推論記錄。
import { expect, expectNoHorizontalOverflow, loginAs, snap, test } from './fixtures';

test.describe('使用性第三輪', () => {
  test('從資料集到預測病人：數目、結論、顯示名稱、預測對錯', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await loginAs(page, 'pi01');
    // 開啟資料集先看描述性統計，分頁有一行說明
    await page.goto('/data/tabular/2');
    await expect(page.getByRole('table', { name: '描述性統計' })).toBeVisible();
    await expect(page.getByTestId('tab-hint')).toContainText('每一欄的平均、範圍與分布');
    await expect(page.getByRole('table', { name: '描述性統計' }).getByRole('row', { name: /^age / })).toContainText('19.8');

    await page.getByRole('navigation', { name: '資料集分頁' }).getByRole('link', { name: 'Target／Feature' }).click();
    const overview = page.getByRole('form', { name: '設定 Target 與 Feature' });
    await overview.getByRole('radio', { name: '以 diagnosis 為 Target' }).check();
    for (const f of ['age', 'sex', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker']) await overview.getByRole('checkbox', { name: f, exact: true }).check();
    await overview.getByRole('button', { name: '全部轉成 One Hot Encoding' }).click();
    await expect(page.getByTestId('steps-not-needed')).toContainText('大多數人不需要這一步');
    await overview.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText(/^已儲存：Target 欄位 diagnosis；Feature 欄位 7 個欄位（sex、smoker 自動拆成 5 欄）；有缺值的病人：補值後使用；前處理 1 個步驟/)).toBeVisible();

    await page.getByRole('link', { name: '用這份資料建立訓練任務' }).click();
    await expect(page.getByText(/Feature 欄位 7 個欄位（sex、smoker 自動拆成 5 欄）；有缺值的病人：補值後使用/)).toBeVisible();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await form.getByLabel('演算法').selectOption('logistic_regression');
    await form.getByRole('radio', { name: 'K 折交叉驗證' }).check();
    await form.getByRole('button', { name: '儲存設定' }).click();
    await page.getByRole('button', { name: '送出訓練「lung-clinical 訓練」' }).click();
    await expect(page.getByTestId('run-status')).toContainText('已完成');

    const verdict = page.getByTestId('verdict');
    await expect(verdict).toHaveText(/^整體表現：(優秀|良好|尚可|偏弱|接近亂猜)（AUC 0\.\d\d，5 折平均）/);
    const sentence = (await verdict.locator('strong').textContent())!.replace('整體表現：', '');
    await expect(page.getByRole('table', { name: '訓練清單' })).toContainText(sentence);
    await expect(page.getByTestId('result-details')).not.toHaveAttribute('open');
    await expect(page.getByText(/減少樹的深度/)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'round3/verdict');

    // 用中文名稱部署，再從結果「用這個模型預測病人」
    await page.getByRole('link', { name: '部署並設定權限' }).click();
    const share = page.getByRole('form', { name: '部署並設定權限' });
    await share.getByLabel('顯示名稱（同事看到的名稱，可用中文）').fill('心臟科確診預測（測試）');
    await share.getByLabel('授權帳號（以逗號分隔）').fill('md01');
    await share.getByRole('button', { name: '部署並設定權限' }).click();
    await expect(page.getByText('已把「心臟科確診預測（測試）」授權給 md01。他們登入後點左側「推論服務管理」，選模型「心臟科確診預測（測試）」就能預測。')).toBeVisible();

    await page.goBack();
    await page.getByRole('button', { name: /^展開訓練 #\d+$/ }).first().click();
    await page.getByRole('link', { name: '用這個模型預測病人' }).click();
    await expect(page.getByRole('heading', { name: '預測：心臟科確診預測（測試）' })).toBeVisible();
    const one = page.getByRole('form', { name: '一位病人' });
    await one.getByLabel('age').fill('61');
    await one.getByRole('button', { name: '預測' }).click();
    await expect(one.getByTestId('try-result')).toContainText(/^diagnosis＝1 的機率 \d+%（模型預測為「[01]」）/);
    await page.getByRole('button', { name: '多位病人一起預測' }).click();
    await expect(page.getByTestId('table-correct')).toContainText(/位中預測對 \d+ 位/);
    const table = page.getByRole('table', { name: '預測結果' });
    await expect(table.getByRole('columnheader', { name: '預測對／錯' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'prediction', exact: true })).toHaveCount(0);
    await expect(page.getByRole('table', { name: '推論服務歷史紀錄' }).getByRole('row', { name: /即時推論/ })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'round3/predict');
  });
});
