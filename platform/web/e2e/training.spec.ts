import { expect as baseExpect, loginAs, snap, test, expectNoHorizontalOverflow } from './fixtures';

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
    await form.getByLabel('目標欄位（Target）').selectOption('diagnosis');
    const features = form.getByRole('group', { name: '特徵欄位（Feature）' });
    for (const f of ['age', 'bmi', 'glucose']) await features.getByRole('checkbox', { name: f, exact: true }).check();
    await form.getByLabel('演算法').selectOption('random_forest');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText('已新增訓練設定「diagnosis-cls」。')).toBeVisible();

    await page.getByRole('button', { name: '送出訓練「diagnosis-cls」' }).click();
    const status = page.getByTestId('run-status');
    await expect(status).toContainText('排隊中');
    await expect(status).toContainText('執行中');
    await expect(status).toContainText('已完成');
    await expect(page.getByRole('table', { name: '訓練清單' }).getByRole('row', { name: /diagnosis-cls/ })).toContainText('test.accuracy');
    await expect(page.getByRole('table', { name: '訓練 #1 的指標' })).toContainText('test.f1_macro');

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

test.describe('AI 模型部署', () => {
  test('TC-B06-05 / 06 下載模型、部署、修改授權帳號、取消部署', async ({ page }, testInfo) => {
    await loginAs(page, 'pi01');
    await page.goto('/deployment');
    const models = page.getByRole('table', { name: '可部署的模型' });
    for (let i = 0; i < 3; i += 1) {
      const download = page.waitForEvent('download');
      await models.getByRole('button', { name: '下載模型「modality-cnn-run2」' }).click();
      expect((await download).suggestedFilename()).toBe('modality-cnn-run2.h5');
    }

    const form = page.getByRole('form', { name: '部署模型' });
    await form.getByLabel('模型').selectOption({ label: 'modality-cnn-run2（影像分類，H5）' });
    await form.getByLabel('部署名稱（小寫英數字與 -）').fill('modality-api');
    await form.getByLabel('授權帳號（以逗號分隔）').fill('md01, pi01');
    await form.getByRole('button', { name: '部署' }).click();
    await expect(page.getByText('已部署「modality-api」：POST /api/inference/modality-api/predict')).toBeVisible();
    const row = page.getByRole('table', { name: '線上部署清單' }).getByRole('row', { name: /modality-api/ });
    await expect(row).toContainText('POST /api/inference/modality-api/predict');
    await expect(row).toContainText('md01、pi01');

    await row.getByRole('button', { name: '管理授權「modality-api」' }).click();
    const access = page.getByRole('form', { name: '修改授權帳號' });
    await access.getByLabel(/授權帳號/).fill('ra01');
    await access.getByRole('button', { name: '儲存授權帳號' }).click();
    await expect(row).toContainText('ra01');
    await expectNoHorizontalOverflow(page);
    await snap(page, testInfo.project.name, 'deployment/deployed');

    await row.getByRole('button', { name: '取消部署「modality-api」' }).click();
    await page.getByRole('dialog', { name: '取消部署' }).getByRole('button', { name: '取消部署' }).click();
    await expect(page.getByText('已取消部署「modality-api」，端點不再接受呼叫。')).toBeVisible();
    await expect(page.getByText('還沒有線上部署。')).toBeVisible();
  });

  test('只有 Prediction 的帳號只看得到模型清單與說明', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/deployment');
    await expect(page.getByRole('table', { name: '可部署的模型' })).toBeVisible();
    await expect(page.getByText(/部署模型、下載模型與管理授權帳號需要 Training 權限/)).toBeVisible();
    await expect(page.getByRole('form', { name: '部署模型' })).toHaveCount(0);
  });
});
