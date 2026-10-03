import { readFileSync } from 'node:fs';
import { expect as baseExpect, loginAs, test } from './fixtures';

// 這台開發機由多個工作共用，負載高時 dev server 首次編譯頁面較慢：等待上限放寬到 15 秒
const expect = baseExpect.configure({ timeout: 15_000 });
import { fixture } from './files';


test.describe('CSV 上傳驗證', () => {
  test('數據管理先選資料種類，CSV 一步就到上傳', async ({ page }) => {
    await loginAs(page, 'pi01');
    await page.goto('/data');
    await page.getByRole('list', { name: '資料種類' }).getByRole('link', { name: /結構式資料：上傳 CSV/ }).click();
    await expect(page.getByRole('form', { name: '上傳 CSV' })).toBeVisible();
    await page.getByRole('link', { name: '上傳 CSV', exact: true }).click();
    await expect(page.getByRole('form', { name: '上傳 CSV' }).getByRole('button', { name: '選擇檔案' }).first()).toBeInViewport();
  });

  test('TC-B01-10 不寫 JSON：正常 CSV 全部通過；bad.csv 勾選 sbp 必填後 10 列錯誤全部攔下', async ({ page }) => {
    await loginAs(page, 'pi01');
    await page.goto('/data/tabular');
    const form = page.getByRole('form', { name: '上傳 CSV' });

    await form.getByLabel(/^CSV 檔案/).setInputFiles(fixture('tabular/cohort_01.csv'));
    const table = form.getByRole('table', { name: '欄位確認' });
    await expect(table.getByLabel('age 的型態')).toHaveValue('int');
    await expect(page.getByRole('region', { name: '預檢結果（尚未上傳）' })).toContainText('共 100 列，通過 100 列，拒絕 0 列');
    await form.getByLabel('資料集名稱').fill('cohort-a');
    await form.getByRole('button', { name: '上傳並驗證' }).click();
    await expect(page.getByRole('region', { name: '「cohort-a」的上傳結果' })).toContainText('共 100 列，通過 100 列，拒絕 0 列');

    await form.getByLabel(/^CSV 檔案/).setInputFiles(fixture('tabular/bad.csv'));
    await expect(page.getByRole('region', { name: '預檢結果（尚未上傳）' })).toContainText('拒絕 8 列');
    await expect(table.getByRole('row', { name: /^sbp/ })).toContainText('有 2 格空白或缺值');
    await table.getByLabel('sbp 必填').check();
    await form.getByRole('button', { name: '重新預檢' }).click();
    await expect(page.getByRole('region', { name: '預檢結果（尚未上傳）' })).toContainText('共 30 列，通過 20 列，拒絕 10 列');
    await form.getByLabel('資料集名稱').fill('bad');
    await form.getByRole('button', { name: '上傳並驗證' }).click();
    const result = page.getByRole('region', { name: '「bad」的上傳結果' });
    await expect(result).toContainText('共 30 列，通過 20 列，拒絕 10 列');
    const expected = JSON.parse(readFileSync(fixture('tabular/bad_rows.json'), 'utf8')).rows as { row: number; column: string }[];
    const rows = result.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(expected.length + 1);
    for (const [i, e] of expected.entries()) {
      await expect(rows.nth(i + 1).locator('th,td').nth(0)).toHaveText(String(e.row + 1));   // 第幾列從 1 起算
      await expect(rows.nth(i + 1).locator('td').nth(1)).toHaveText(e.column);
    }

    await page.reload();
    const list = page.getByRole('table', { name: '資料集列表' });
    await expect(list.getByRole('row', { name: /^bad/ }).locator('td').nth(1)).toHaveText('30');
    await expect(list.getByRole('row', { name: /^bad/ }).locator('td').nth(3)).toHaveText('10');
    await expect(list.getByRole('row', { name: /^cohort-a/ }).locator('td').nth(2)).toHaveText('100');
  });

  test('TC-B01-10 進階：手寫結構定義照舊可用，bad.csv 的錯誤列全部攔下', async ({ page }) => {
    await loginAs(page, 'pi01');
    await page.goto('/data/tabular');
    const form = page.getByRole('form', { name: '上傳 CSV' });
    await form.getByLabel(/^CSV 檔案/).setInputFiles(fixture('tabular/bad.csv'));
    await expect(form.getByRole('table', { name: '欄位確認' })).toBeVisible();
    await form.getByLabel('資料集名稱').fill('bad-json');
    await form.getByText('進階：自行提供結構定義（JSON）').click();
    await form.getByLabel(/^載入結構定義檔/).setInputFiles(fixture('tabular/schema.json'));
    await expect(form.getByLabel('結構定義（JSON）')).toHaveValue(/"patient_id"/);
    await form.getByRole('button', { name: '上傳並驗證' }).click();
    const result = page.getByRole('region', { name: '「bad-json」的上傳結果' });
    await expect(result).toContainText('共 30 列，通過 20 列，拒絕 10 列');
    await expect(result.getByRole('table').getByRole('row')).toHaveCount(11);
  });

  test('結構定義漏掉的欄位要使用者確認，可一鍵補上；同名上傳建立新版本', async ({ page }) => {
    await loginAs(page, 'pi01');
    await page.goto('/data/tabular');
    const form = page.getByRole('form', { name: '上傳 CSV' });
    await form.getByLabel(/^CSV 檔案/).setInputFiles(fixture('tabular/cohort_01.csv'));
    await expect(form.getByRole('table', { name: '欄位確認' })).toBeVisible();
    await form.getByLabel('資料集名稱').fill('lung-clinical');
    await expect(form.getByRole('group', { name: '已經有名為「lung-clinical」的資料集' })).toBeVisible();
    await form.getByText('進階：自行提供結構定義（JSON）').click();
    await form.getByLabel('結構定義（JSON）').fill('{"columns":[{"name":"patient_id","type":"str"},{"name":"age","type":"int"}]}');
    await form.getByRole('button', { name: '上傳並驗證' }).click();
    await expect(form.getByText('結構定義沒有列出 10 個欄位')).toBeVisible();
    await form.getByRole('button', { name: '自動加入這些欄位' }).click();
    await form.getByRole('button', { name: '上傳並驗證' }).click();
    const result = page.getByRole('region', { name: '「lung-clinical（第 2 版）」的上傳結果' });
    await expect(result).toContainText('全部通過');
    await page.getByRole('link', { name: '開啟資料集「lung-clinical（第 2 版）」' }).click();
    await expect(page.getByText(/100 列、12 欄/)).toBeVisible();
  });
});

test.describe('預覽', () => {
  test('TC-B04-02 隱藏 3 欄後重新載入，狀態一致', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/tabular');
    await page.getByRole('link', { name: 'lung-clinical' }).click();
    const table = page.getByRole('table', { name: '資料預覽' });
    await expect(table.getByRole('columnheader')).toHaveCount(13);
    const hidden = ['patient_id', 'bmi', 'smoker'];
    for (const c of hidden) await page.getByRole('checkbox', { name: c, exact: true }).uncheck();
    const visible = ['列', 'age', 'sex', 'sbp', 'dbp', 'glucose', 'diagnosis', 'time_to_event', 'event', 'study_accession'];
    await expect(table.getByRole('columnheader')).toHaveText(visible);

    await page.reload();
    await expect(page.getByRole('table', { name: '資料預覽' }).getByRole('columnheader')).toHaveText(visible);
    for (const c of hidden) await expect(page.getByRole('checkbox', { name: c, exact: true })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'age', exact: true })).toBeChecked();
    await expect(page.getByText(/已隱藏 3 個：patient_id、bmi、smoker/)).toBeVisible();

    // 離開再回來（不同分頁）也一致
    await page.getByRole('link', { name: '描述統計' }).click();
    await expect(page.getByRole('table', { name: '描述統計' })).toBeVisible();
    await page.getByRole('link', { name: '預覽', exact: true }).click();
    await expect(page.getByRole('table', { name: '資料預覽' }).getByRole('columnheader')).toHaveText(visible);
  });
});

test.describe('Target 與 Feature', () => {
  test('TC-B04-03 設定 3 次，每次重新載入一致', async ({ page }) => {
    await loginAs(page, 'ra01');
    await page.goto('/data/tabular/2/target');
    const settings: [string, string[]][] = [
      ['diagnosis', ['age', 'bmi', 'sbp']],
      ['event', ['age', 'time_to_event']],
      ['sbp', ['dbp']],
    ];
    const form = page.getByRole('form', { name: '設定 Target 與 Feature' });
    for (const [target, features] of settings) {
      await form.getByRole('radio', { name: `以 ${target} 為 Target` }).check();
      for (const box of await form.getByRole('checkbox').all()) await box.uncheck();
      for (const f of features) await form.getByRole('checkbox', { name: f, exact: true }).check();
      await form.getByRole('button', { name: '儲存設定' }).click();
      await expect(page.getByText(`已儲存：要預測的結果 ${target}；用來預測的資料 ${features.length} 個欄位；有缺值的病人：補上缺值後使用；沒有前處理步驟`)).toBeVisible();

      await page.reload();
      await expect(page.getByTestId('saved-target')).toHaveText(target);
      await expect(page.getByTestId('saved-features')).toHaveText(features.join('、'));
      await expect(form.getByRole('radio', { name: `以 ${target} 為 Target` })).toBeChecked();
      for (const f of features) await expect(form.getByRole('checkbox', { name: f, exact: true })).toBeChecked();
      await expect(form.getByRole('checkbox', { checked: true })).toHaveCount(features.length);
    }
  });

  test('欄位總覽：提示識別碼與文字欄位；One-Hot 與「當作類別」自動換成產生的欄位', async ({ page }) => {
    await loginAs(page, 'ra01');
    await page.goto('/data/tabular/2/target');
    const form = page.getByRole('form', { name: '設定 Target 與 Feature' });
    const overview = form.getByRole('table', { name: '欄位總覽' });
    await expect(overview.getByRole('row', { name: /^diagnosis/ })).toContainText('是／否（0／1）');
    await form.getByRole('radio', { name: '以 diagnosis 為 Target' }).check();
    for (const f of ['patient_id', 'age', 'sex', 'smoker', 'event']) await form.getByRole('checkbox', { name: f, exact: true }).check();
    await expect(overview.getByRole('row', { name: /^patient_id/ })).toContainText('建議不要當 Feature');
    await form.getByRole('checkbox', { name: 'patient_id', exact: true }).uncheck();
    await expect(form.getByText('有 Feature 還不能用來訓練')).toBeVisible();
    await form.getByRole('button', { name: '全部轉成 One-Hot' }).click();
    await form.getByRole('switch', { name: 'event 當作類別', exact: true }).check();
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText(/^已儲存：要預測的結果 diagnosis；用來預測的資料 4 個欄位（sex、smoker、event 自動拆成 7 欄）；/)).toBeVisible();
    await expect(page.getByTestId('saved-features')).toHaveText('age、sex_F、sex_M、smoker_current、smoker_former、smoker_never、event_0、event_1');
    await page.reload();
    await expect(form.getByRole('checkbox', { name: 'sex', exact: true })).toBeChecked();
    await expect(form.getByRole('switch', { name: 'event 當作類別', exact: true })).toBeChecked();
  });
});

test.describe('統計與圖表', () => {
  test('TC-B04-01／TC-B04-05 描述統計、分布、相關矩陣、散佈圖各產出 1 次', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/tabular/2/describe');
    await expect(page.getByRole('table', { name: '描述統計' }).getByRole('row', { name: /^age / })).toContainText('59.15');
    await expect(page.getByRole('figure', { name: 'age 的分布' }).getByRole('img').first()).toBeVisible();

    await page.getByRole('link', { name: '相關與散佈圖' }).click();
    await page.getByRole('button', { name: '產生相關矩陣' }).click();
    const matrix = page.getByRole('table', { name: '相關矩陣（pearson）' });
    await expect(matrix.getByRole('row')).toHaveCount(9);
    await expect(matrix.getByRole('row', { name: /^sbp/ })).toContainText('0.87');
    await page.getByRole('button', { name: '產生散佈圖' }).click();
    await expect(page.getByRole('figure', { name: 'age 與 bmi' }).locator('circle')).toHaveCount(100);
  });

  test('TC-B04-07 Logistic、Linear、Kaplan-Meier、Cox 各執行 1 次，都產出圖表與統計量', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/tabular/2/stats');
    const form = page.getByRole('form', { name: '統計分析' });
    const result = page.getByRole('region', { name: '分析結果' });
    let ok = 0;

    await form.getByLabel('模型').selectOption('logistic');
    await form.getByLabel('結果欄位').selectOption('diagnosis');
    await form.getByRole('checkbox', { name: 'age', exact: true }).check();
    await form.getByRole('checkbox', { name: 'bmi', exact: true }).check();
    await form.getByRole('button', { name: '執行分析' }).click();
    await expect(result.getByRole('figure', { name: /^ROC 曲線/ })).toBeVisible();
    await expect(result.getByRole('table', { name: '係數' }).getByRole('row')).toHaveCount(4);
    ok++;

    await form.getByLabel('模型').selectOption('linear');
    await form.getByLabel('結果欄位').selectOption('sbp');
    await form.getByRole('button', { name: '執行分析' }).click();
    await expect(result.getByRole('figure', { name: '殘差圖' })).toBeVisible();
    await expect(result.getByRole('list', { name: '統計量' })).toContainText('R²');
    ok++;

    await form.getByLabel('模型').selectOption('kaplan-meier');
    await form.getByLabel('分組欄位').selectOption('sex');
    await form.getByRole('button', { name: '執行分析' }).click();
    await expect(result.getByRole('figure', { name: '存活曲線' }).getByRole('list', { name: '圖例' }).getByRole('listitem')).toHaveText(['F', 'M']);
    await expect(result.getByRole('list', { name: '統計量' })).toContainText('Log-rank p 值');
    ok++;

    await form.getByLabel('模型').selectOption('cox');
    await form.getByRole('button', { name: '執行分析' }).click();
    await expect(result.getByRole('figure', { name: 'Hazard Ratio 森林圖' })).toBeVisible();
    await expect(result.getByRole('list', { name: '統計量' })).toContainText('Concordance');
    ok++;
    expect(ok).toBe(4);

    // TC-B04-08：文字欄位回清楚的錯誤
    await form.getByRole('checkbox', { name: 'smoker', exact: true }).check();
    await form.getByRole('button', { name: '執行分析' }).click();
    await expect(page.getByRole('alert')).toContainText('欄位「smoker」不是數值欄位，無法進行數值分析');
  });

  test('TC-B04-04 前處理：補值與 One-Hot 後預覽', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/tabular/2/preprocess');
    await expect(page.getByText(/^共 66 種前處理方法/)).toBeVisible();
    const form = page.getByRole('form', { name: '加入前處理步驟' });
    await form.getByLabel('方法').selectOption('impute_mean');
    await form.getByRole('checkbox', { name: 'glucose', exact: true }).check();
    await form.getByRole('button', { name: '加入步驟' }).click();
    await form.getByLabel('類別').selectOption('encoding');
    await form.getByLabel('方法').selectOption('onehot');
    await form.getByRole('checkbox', { name: 'sex', exact: true }).check();
    await form.getByRole('button', { name: '加入步驟' }).click();
    await page.getByRole('button', { name: '預覽套用結果' }).click();
    const preview = page.getByRole('region', { name: '前處理預覽結果' });
    await expect(preview.getByRole('columnheader', { name: 'sex_F' })).toBeVisible();
    await expect(preview.getByRole('status')).toContainText('100 列、13 欄');
  });
});
