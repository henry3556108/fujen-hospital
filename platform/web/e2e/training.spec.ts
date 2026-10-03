import { expect as baseExpect, loginAs, snap, switchUser, test, expectNoHorizontalOverflow } from './fixtures';

// 建模管理（B-05）與 AI 模型部署（B-06 部署）：測試模式的模擬 API（src/mocks/training.ts）。
// 模擬的訓練在第 2 次查詢變執行中、第 3 次完成；頁面每 1.5 秒自動更新。
const expect = baseExpect.configure({ timeout: 15_000 });

test.describe('建模管理', () => {
  test('TC-B05-02 / 03 訓練設定存檔後重新載入頁面，逐欄相同', async ({ page }, testInfo) => {
    await loginAs(page, 'ra01');
    await page.goto('/training');
    await page.getByRole('button', { name: '新增訓練設定' }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await form.getByLabel('設定名稱').fill('胸部 CT 偵測');
    await form.getByLabel('訓練種類').selectOption('image_detection');
    await form.getByRole('radio', { name: '指定研究' }).check();
    await form.getByRole('checkbox', { name: /^ACC0011/ }).check();
    await form.getByRole('checkbox', { name: /^ACC0013/ }).check();
    await form.getByLabel('Label（以逗號分隔）').fill('nodule, mass');
    await form.getByLabel('Resize 高（像素）').fill('64');
    await form.getByLabel('Resize 寬（像素）').fill('96');
    await form.getByLabel('訓練集（%）').fill('70');
    await form.getByLabel('驗證集（%）').fill('15');
    await form.getByLabel('測試集（%）').fill('15');
    await form.getByLabel('亂數種子').fill('2024');
    const aug: [string, string][] = [
      ['旋轉角度範圍（度）', '20'], ['寬度位移比例', '0.1'], ['長度位移比例', '0.15'], ['Shear 角度範圍（度）', '8'], ['Zoom 比例範圍', '0.25'],
    ];
    for (const [label, value] of aug) await form.getByLabel(label).fill(value);
    await form.getByRole('checkbox', { name: '水平翻轉' }).check();
    await form.getByRole('checkbox', { name: '垂直翻轉' }).check();
    await form.getByLabel('每張影像最多方框數').fill('3');
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'training/setting-form');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText('已新增訓練設定「胸部 CT 偵測」。')).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: '編輯「胸部 CT 偵測」' }).click();
    const edit = page.getByRole('form', { name: '修改訓練設定「胸部 CT 偵測」' });
    await expect(edit.getByLabel('訓練種類')).toHaveValue('image_detection');
    await expect(edit.getByRole('radio', { name: '指定研究' })).toBeChecked();
    await expect(edit.getByRole('checkbox', { name: /^ACC0011/ })).toBeChecked();
    await expect(edit.getByRole('checkbox', { name: /^ACC0013/ })).toBeChecked();
    await expect(edit.getByRole('checkbox', { name: /^ACC0012/ })).not.toBeChecked();
    await expect(edit.getByLabel('Label（以逗號分隔）')).toHaveValue('nodule, mass');
    await expect(edit.getByLabel('Resize 高（像素）')).toHaveValue('64');
    await expect(edit.getByLabel('Resize 寬（像素）')).toHaveValue('96');
    await expect(edit.getByLabel('訓練集（%）')).toHaveValue('70');
    await expect(edit.getByLabel('驗證集（%）')).toHaveValue('15');
    await expect(edit.getByLabel('測試集（%）')).toHaveValue('15');
    await expect(edit.getByLabel('亂數種子')).toHaveValue('2024');
    for (const [label, value] of aug) await expect(edit.getByLabel(label)).toHaveValue(value);
    await expect(edit.getByRole('checkbox', { name: '水平翻轉' })).toBeChecked();
    await expect(edit.getByRole('checkbox', { name: '垂直翻轉' })).toBeChecked();
    await expect(edit.getByLabel('每張影像最多方框數')).toHaveValue('3');
  });

  test('TC-B05-01 送出訓練：排隊中 → 執行中 → 完成，匯出模型與原始碼（TC-B05-05、06）', async ({ page }, testInfo) => {
    await loginAs(page, 'pi01');
    await page.goto('/training');
    await page.getByRole('button', { name: '新增訓練設定' }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await form.getByLabel('設定名稱').fill('diagnosis-cls');
    await form.getByLabel('訓練種類').selectOption('tabular_classification');
    await form.getByLabel('資料集').selectOption({ label: 'lung-clinical（100 列）' });
    await form.getByLabel('要預測的結果（Target）').selectOption('diagnosis');
    const features = form.getByRole('group', { name: '用來預測的資料（Feature）' });
    for (const f of ['age', 'bmi', 'glucose']) await features.getByRole('checkbox', { name: f, exact: true }).check();
    await form.getByLabel('演算法').selectOption('random_forest');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText('已新增訓練設定「diagnosis-cls」。')).toBeVisible();

    await page.getByRole('button', { name: '送出訓練「diagnosis-cls」' }).click();
    const status = page.getByTestId('run-status');
    await expect(status).toContainText('排隊中');
    await expect(status).toContainText('訓練中');
    await expect(status).toContainText('已完成');
    await expect(page.getByRole('table', { name: '訓練清單' }).getByRole('row', { name: /^#1 diagnosis-cls/ })).toContainText('AUC');
    await page.getByText('所有指標（訓練、驗證、測試）').click();
    await expect(page.getByRole('table', { name: '訓練 #1 的指標' })).toContainText('F1 分數');

    const model = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載模型（PKL）' }).click();
    expect((await model).suggestedFilename()).toBe('diagnosis-cls-run1.pkl');
    await expect(page.getByText(/^已下載 diagnosis-cls-run1\.pkl（SHA-256：[0-9a-f]{64}）$/)).toBeVisible();
    const source = page.waitForEvent('download');
    await page.getByRole('button', { name: '匯出原始碼' }).click();
    expect((await source).suggestedFilename()).toBe('training-run-1-source.zip');
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'training/run-finished');
  });
});

test.describe('建模端使用性（從資料集到部署）', () => {
  test('從資料集建立 K 折訓練 → 步驟條 → 結果與圖表 → 報表 → 部署此模型 → 試用預測', async ({ page }, testInfo) => {
    await loginAs(page, 'pi01');
    await page.goto('/data/tabular');
    await page.getByRole('table', { name: '資料集列表' }).getByRole('link', { name: 'lung-clinical' }).click();
    await page.getByRole('link', { name: '用這份資料建立訓練' }).click();

    const form = page.getByRole('form', { name: '新增訓練設定' });
    await expect(form.getByLabel('訓練種類')).toHaveValue('tabular_classification');
    await expect(form.getByLabel('設定名稱')).toHaveValue('lung-clinical 訓練');
    await form.getByLabel('要預測的結果（Target）').selectOption('diagnosis');
    const features = form.getByRole('group', { name: '用來預測的資料（Feature）' });
    for (const f of ['age', 'sex', 'smoker', 'sbp']) await features.getByRole('checkbox', { name: f, exact: true }).check();
    await expect(form.getByTestId('text-features')).toContainText('「sex、smoker」是文字或類別欄位');
    await expect(form.getByText('進階設定（一般不需要調整）')).toBeVisible();
    await expect(form.getByLabel('正則化強度的倒數')).toBeHidden();
    await form.getByRole('radio', { name: 'K 折交叉驗證' }).check();
    await expect(form.getByLabel('交叉驗證折數（K）')).toHaveValue('5');
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'training/from-dataset-form');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText('已新增訓練設定「lung-clinical 訓練」。')).toBeVisible();

    await page.getByRole('button', { name: '送出訓練「lung-clinical 訓練」' }).click();
    const steps = page.getByRole('list', { name: '訓練 #1 的進度' });
    await expect(steps.locator('[aria-current="step"]')).toContainText('排隊中');
    await expect(steps.locator('[aria-current="step"]')).toContainText('訓練中');
    await expect(page.getByTestId('run-status')).toContainText('已完成');

    const cards = page.getByRole('list', { name: '訓練 #1 的重點指標' });
    await expect(cards).toContainText(/測試集的 20 人中猜對 \d+ 人/);
    await expect(cards).toContainText('0.5 等於亂猜');
    await expect(page.getByRole('table', { name: '訓練 #1 的 K 折結果' })).toContainText('±');
    await expect(page.getByRole('table', { name: '訓練 #1 的混淆矩陣' })).toContainText('正確');
    await expect(page.getByText(/^ROC 曲線（陽性＝「1」/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'training/kfold-result');

    const report = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載報表（可列印）' }).click();
    expect((await report).suggestedFilename()).toBe('training-run-1-report.html');

    await page.getByRole('link', { name: '分享給同事使用' }).click();
    const deploy = page.getByRole('form', { name: '分享給同事使用' });
    await expect(deploy.getByLabel('模型')).toHaveValue(/\d+/);
    await expect(deploy.getByLabel('顯示名稱（同事看到的名稱，可用中文）')).toHaveValue('lung-clinical 訓練');
    await deploy.getByLabel('分享給（同事的帳號，以逗號分隔）').fill('md01');
    await deploy.getByRole('button', { name: '分享給同事使用' }).click();
    await expect(page.getByText(/^已把「lung-clinical 訓練」分享給 md01。/)).toBeVisible();

    const trial = page.getByRole('form', { name: '試用預測' });
    await trial.getByLabel('age').fill('61');
    await trial.getByLabel('sex').selectOption('M');
    await trial.getByLabel('smoker').selectOption('current');
    await trial.getByLabel('sbp').fill('140');
    await trial.getByRole('button', { name: '預測' }).click();
    await expect(trial.getByTestId('try-result')).toHaveText(/^diagnosis 預測為「[01]」的機率 \d+%（為「[01]」的機率 \d+%）。$/);
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'deployment/try-predict');
  });
});

test.describe('AI 模型部署', () => {
  test('TC-B06-05 / 06 下載模型、分享給同事、修改分享對象、停止分享；md01 在推論服務管理看到並預測', async ({ page }, testInfo) => {
    await loginAs(page, 'pi01');
    await page.goto('/deployment');
    const models = page.getByRole('table', { name: '可部署的模型' });
    for (let i = 0; i < 3; i += 1) {
      const download = page.waitForEvent('download');
      await models.getByRole('button', { name: '下載模型「modality-cnn-run2」' }).click();
      expect((await download).suggestedFilename()).toBe('modality-cnn-run2.h5');
    }

    const form = page.getByRole('form', { name: '分享給同事使用' });
    await form.getByLabel('模型').selectOption({ label: 'diagnosis-rf-run1（結構式分類）' });
    await form.getByLabel('顯示名稱（同事看到的名稱，可用中文）').fill('心臟科確診預測');
    await form.getByLabel('分享給（同事的帳號，以逗號分隔）').fill('md01, pi01');
    await form.getByRole('button', { name: '分享給同事使用' }).click();
    await expect(page.getByText(/^已把「心臟科確診預測」分享給 md01、pi01。/)).toBeVisible();
    const row = page.getByRole('table', { name: '已分享的模型' }).getByRole('row', { name: /心臟科確診預測/ });
    await expect(row).toContainText('md01、pi01');
    await expect(page.getByRole('table', { name: '程式呼叫端點' })).toBeHidden();
    await page.getByText('給資訊人員：程式呼叫方式').click();
    await expect(page.getByRole('table', { name: '程式呼叫端點' })).toContainText('POST /api/inference/model-101/predict');

    await row.getByRole('button', { name: '修改分享對象「心臟科確診預測」' }).click();
    const access = page.getByRole('form', { name: '修改分享對象' });
    await access.getByLabel(/分享給/).fill('md01, ra01');
    await access.getByRole('button', { name: '儲存分享對象' }).click();
    await expect(row).toContainText('md01、ra01');
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'deployment/deployed');

    // 第二位使用者 md01（醫師，有 Prediction）：推論服務管理看到「pi01 分享給你」並可預測
    await switchUser(page, 'md01');
    await page.goto('/inference');
    const shared = page.getByRole('table', { name: '模型清單' }).getByRole('row', { name: /diagnosis-rf-run1/ });
    await expect(shared).toContainText('pi01 分享給你');
    await expect(shared.getByRole('button', { name: '已選擇' })).toBeDisabled();
    await page.getByRole('form', { name: '多位病人一起預測' }).getByRole('button', { name: '多位病人一起預測' }).click();
    await expect(page.getByTestId('table-summary')).toContainText(/^共 20 位/);
    await snap(page, testInfo.project.name, 'deployment/md01-inference');

    await switchUser(page, 'pi01');
    await page.goto('/deployment');
    await page.getByRole('table', { name: '已分享的模型' }).getByRole('button', { name: '停止分享「心臟科確診預測」' }).click();
    await page.getByRole('dialog', { name: '停止分享' }).getByRole('button', { name: '停止分享' }).click();
    await expect(page.getByText(/^已停止分享「心臟科確診預測」/)).toBeVisible();
    await expect(page.getByText('還沒有分享任何模型。')).toBeVisible();
  });

  test('只有 Prediction 的帳號只看得到模型清單與說明', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/deployment');
    await expect(page.getByRole('table', { name: '可部署的模型' })).toBeVisible();
    await expect(page.getByText(/分享模型、下載模型需要 Training 權限/)).toBeVisible();
    await expect(page.getByRole('form', { name: '分享給同事使用' })).toHaveCount(0);
  });
});
