// 建模管理頁（元件層級，MSW 模擬）。TC-B05-01、02、03；權限。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import type { TrainingKind } from '../../src/pages/training/api';
import { renderApp } from '../render';

// 單元測試不等待：每次查詢就往前推一個狀態
trainingMockOptions.stepMs = 0;

async function openForm(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: '新增訓練設定' }));
  return screen.findByRole('form', { name: '新增訓練設定' });
}

async function fill(user: UserEvent, form: HTMLElement, label: string | RegExp, value: string) {
  const input = within(form).getByLabelText(label);
  await user.clear(input);
  await user.type(input, value);
}

const AUG = { rotation_range: 15, width_shift_range: 0.1, height_shift_range: 0.2, shear_range: 5, zoom_range: 0.3, horizontal_flip: true, vertical_flip: true };

/** 影像分類：指定 2 個研究、Label、Resize、切分、種子、6 項增強 */
async function fillImageSetting(user: UserEvent, form: HTMLElement) {
  await fill(user, form, '設定名稱', '胸部 CT 分類');
  await user.click(within(form).getByRole('radio', { name: '指定研究' }));
  const studies = await within(form).findByRole('group', { name: '研究清單' });
  await user.click(await within(studies).findByRole('checkbox', { name: /^ACC0012/ }));
  await user.click(within(studies).getByRole('checkbox', { name: /^ACC0011/ }));
  await fill(user, form, 'Label（以逗號分隔）', 'nodule, normal');
  await fill(user, form, 'Resize 高（像素）', '64');
  await fill(user, form, 'Resize 寬（像素）', '48');
  await fill(user, form, '訓練集（%）', '70');
  await fill(user, form, '驗證集（%）', '20');
  await fill(user, form, '測試集（%）', '10');
  await fill(user, form, '亂數種子', '7');
  await fill(user, form, '旋轉角度範圍（度）', '15');
  await fill(user, form, '寬度位移比例', '0.1');
  await fill(user, form, '長度位移比例', '0.2');
  await fill(user, form, 'Shear 角度範圍（度）', '5');
  await fill(user, form, 'Zoom 比例範圍', '0.3');
  await user.click(within(form).getByRole('checkbox', { name: '水平翻轉' }));
  await user.click(within(form).getByRole('checkbox', { name: '垂直翻轉' }));
  await fill(user, form, '訓練回合數', '2');
}

function formValues(form: HTMLElement) {
  const value = (label: string) => (within(form).getByLabelText(label) as HTMLInputElement).value;
  const checked = (name: string) => (within(form).getByRole('checkbox', { name }) as HTMLInputElement).checked;
  return {
    name: value('設定名稱'), kind: value('訓練種類'), labels: value('Label（以逗號分隔）'),
    resize: [value('Resize 高（像素）'), value('Resize 寬（像素）')],
    split: [value('訓練集（%）'), value('驗證集（%）'), value('測試集（%）')], seed: value('亂數種子'),
    aug: [value('旋轉角度範圍（度）'), value('寬度位移比例'), value('長度位移比例'), value('Shear 角度範圍（度）'), value('Zoom 比例範圍'),
      checked('水平翻轉'), checked('垂直翻轉')],
    epochs: value('訓練回合數'),
  };
}

describe('建模管理：訓練設定', () => {
  it('shows the five training kinds without file formats in the labels', async () => {
    const { user } = await renderApp('/training', 'ra01');
    const form = await openForm(user);
    const options = within(within(form).getByLabelText('訓練種類')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['影像分類', '影像分割', '物件偵測', '結構式分類', '結構式迴歸']);
  });

  it('TC-B05-02 / 03 image range, label, resize, split, seed and six augmentations are saved and read back identical', async () => {
    const first = await renderApp('/training', 'ra01');
    const form = await openForm(first.user);
    await fillImageSetting(first.user, form);
    await first.user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByText('已新增訓練設定「胸部 CT 分類」。')).toBeInTheDocument();

    const saved = trainingMock().settings[0].config;
    expect(saved.augmentation).toEqual(AUG);
    expect(saved).toMatchObject({
      kind: 'image_classification', seed: 7, split: { train: 0.7, validation: 0.2, test: 0.1 },
      image: { resize: [64, 48], labels: ['nodule', 'normal'] },
      source: { type: 'dicom', label_source: { provider: 'annotations' } },
    });
    expect((saved.source as { studies: string[] }).studies).toHaveLength(2);

    // 「重新載入」：卸載後重新渲染整個 App，打開編輯表單逐欄比對
    first.unmount();
    const { user } = await renderApp('/training', 'ra01');
    await user.click(await screen.findByRole('button', { name: '編輯「胸部 CT 分類」' }));
    const edit = await screen.findByRole('form', { name: '修改訓練設定「胸部 CT 分類」' });
    expect(formValues(edit)).toEqual({
      name: '胸部 CT 分類', kind: 'image_classification', labels: 'nodule, normal', resize: ['64', '48'], split: ['70', '20', '10'], seed: '7',
      aug: ['15', '0.1', '0.2', '5', '0.3', true, true], epochs: '2',
    });
    expect(within(edit).getByRole('radio', { name: '指定研究' })).toBeChecked();
    const studies = within(edit).getByRole('group', { name: '研究清單' });
    await waitFor(() => expect(within(studies).getAllByRole('checkbox', { checked: true })).toHaveLength(2));

    // 不改任何欄位直接儲存：伺服器的設定逐欄相同
    await user.click(within(edit).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByText('已儲存訓練設定「胸部 CT 分類」的修改。')).toBeInTheDocument();
    expect(trainingMock().settings[0].config).toEqual(saved);
  }, 30_000); // 逐欄輸入較多，整套平行執行時放寬時限

  it('server validation messages are shown (split must add up to 100%)', async () => {
    const { user } = await renderApp('/training', 'ra01');
    const form = await openForm(user);
    await fill(user, form, '設定名稱', 'bad');
    await fill(user, form, '訓練集（%）', '50');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('訓練、驗證、測試的比例總和必須等於 1');
    expect(trainingMock().settings).toHaveLength(0);
  });

  it('segmentation requires labels and offers NIfTI／ITK sources', async () => {
    const { user } = await renderApp('/training', 'ra01');
    const form = await openForm(user);
    await fill(user, form, '設定名稱', 'seg');
    await user.selectOptions(within(form).getByLabelText('訓練種類'), 'image_segmentation');
    await user.selectOptions(within(form).getByLabelText('資料來源'), 'files');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('影像分割必須指定前景類別名稱');
    await fill(user, form, 'Label（以逗號分隔）', 'lung');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已新增訓練設定「seg」。');
    expect(trainingMock().settings[0].config.source).toEqual({ type: 'files', format: 'nifti', cases: 'all' });
  });

  it('tabular regression: dataset, target, features and algorithm hyperparameters', async () => {
    const { user } = await renderApp('/training', 'ra01');
    const form = await openForm(user);
    await fill(user, form, '設定名稱', 'sbp 迴歸');
    await user.selectOptions(within(form).getByLabelText('訓練種類'), 'tabular_regression');
    expect(within(form).queryByLabelText('旋轉角度範圍（度）')).toBeNull();
    await user.selectOptions(await within(form).findByLabelText('資料集'), await within(form).findByRole('option', { name: /^lung-clinical/ }));
    await waitFor(() => expect(within(form).getByLabelText('目標欄位（Target）')).toBeEnabled());
    await user.selectOptions(within(form).getByLabelText('目標欄位（Target）'), 'sbp');
    const features = within(form).getByRole('group', { name: '用來預測的資料（Feature）' });
    await user.click(within(features).getByRole('checkbox', { name: 'age' }));
    await user.click(within(features).getByRole('checkbox', { name: 'bmi' }));
    await user.selectOptions(within(form).getByLabelText('演算法'), 'random_forest');
    await fill(user, form, '樹的數量', '80');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已新增訓練設定「sbp 迴歸」。');
    expect(trainingMock().settings[0].config).toMatchObject({
      kind: 'tabular_regression', source: { type: 'tabular', dataset_id: 2 },
      tabular: { target: 'sbp', features: ['age', 'bmi'], algorithm: 'random_forest' },
      hyperparameters: { n_estimators: 80, min_samples_leaf: 1 },
    });
    expect(trainingMock().settings[0].config).not.toHaveProperty('augmentation');
  });

  it('deletes a setting after confirmation', async () => {
    const { user } = await renderApp('/training', 'ra01');
    const form = await openForm(user);
    await fill(user, form, '設定名稱', 'tmp');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await user.click(await screen.findByRole('button', { name: '刪除「tmp」' }));
    await user.click(within(screen.getByRole('dialog', { name: '刪除訓練設定' })).getByRole('button', { name: '刪除' }));
    expect(await screen.findByText('已刪除訓練設定「tmp」。')).toBeInTheDocument();
    expect(trainingMock().settings).toHaveLength(0);
  });

  it('users without Training see the access-denied page', async () => {
    await renderApp('/training', 'md01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Training 權限/)).toBeInTheDocument();
  });
});

/** 建立一份設定（直接寫進模擬狀態，省去填表）並回傳名稱。 */
function seedSetting(kind: TrainingKind, name: string, owner = 'ra01') {
  const s = trainingMock();
  const image = kind.startsWith('image_');
  s.settings.push({
    id: s.nextSetting++, project_id: 1, name, kind, created_by: owner, updated_by: owner, created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z',
    config: image
      ? { version: 1, kind, source: kind === 'image_segmentation' ? { type: 'files', format: 'nifti', cases: 'all' } : { type: 'dicom', studies: 'all', label_source: { provider: 'annotations' } },
          split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 1, image: { resize: [32, 32], labels: ['a', 'b'] }, augmentation: {}, hyperparameters: {} }
      : { version: 1, kind, source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 1,
          tabular: { target: 'diagnosis', features: ['age'], steps: [], algorithm: 'random_forest' }, hyperparameters: {} },
  });
  return name;
}

describe('建模管理：送出訓練與狀態', () => {
  it('TC-B05-01 five kinds each go queued → running → succeeded with metrics', async () => {
    const kinds: TrainingKind[] = ['image_classification', 'image_segmentation', 'image_detection', 'tabular_classification', 'tabular_regression'];
    kinds.forEach((k) => seedSetting(k, `run-${k}`));
    const { user } = await renderApp('/training', 'ra01');
    for (const k of kinds) {
      await user.click(await screen.findByRole('button', { name: `送出訓練「run-${k}」` }));
      await screen.findByText(new RegExp(`已送出訓練 #\\d+（run-${k}），目前排隊中`));
    }
    const table = await screen.findByRole('table', { name: '訓練清單' });
    await waitFor(() => expect(within(table).getAllByRole('button', { name: /^(展開|收合)訓練 #/ })).toHaveLength(5));
    const refresh = screen.getByRole('button', { name: '重新整理' });
    await user.click(refresh);
    await user.click(refresh);
    await waitFor(() => expect(within(table).getAllByText('已完成')).toHaveLength(5));
    expect(within(table).getByRole('row', { name: /run-tabular_regression.*R²（解釋量）.*（測試集）/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /run-image_classification.*準確率 \d+(\.\d)?%（測試集）/ })).toBeInTheDocument();
    expect(trainingMock().runs.map((r) => r.status)).toEqual(Array(5).fill('succeeded'));
  });

  it('a run detail follows the status and shows metrics, the log and a failure reason', async () => {
    seedSetting('image_classification', 'ok');
    seedSetting('image_detection', '會失敗的設定');
    const { user } = await renderApp('/training', 'ra01');
    await user.click(await screen.findByRole('button', { name: '送出訓練「ok」' }));
    const status = await screen.findByTestId('run-status');
    expect(status).toHaveTextContent('排隊中');
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('訓練中'));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'));
    expect(screen.getByRole('table', { name: '訓練 #1 的指標' })).toHaveTextContent('測試集（2 筆）準確率');
    await user.click(screen.getByRole('button', { name: '檢視訓練輸出' }));
    expect(await screen.findByLabelText('訓練 #1 的輸出')).toHaveTextContent('完成，輸出 model.h5');

    await user.click(screen.getByRole('button', { name: '送出訓練「會失敗的設定」' }));
    await user.click(await screen.findByRole('button', { name: '重新整理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('失敗'));
    const alert = screen.getAllByRole('alert').find((a) => a.textContent?.includes('訓練失敗'))!;
    expect(alert).toHaveTextContent('訓練資料不足，驗證集沒有任何資料（模擬）');
    // 只顯示中文原因；Python 堆疊收在「技術細節」
    const details = within(alert).getByText('技術細節（給資訊人員）').closest('details')!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent('runtime.py');
  });

  it('cancels a queued run and reruns a finished one with the same seed', async () => {
    seedSetting('tabular_classification', 'cls');
    const { user } = await renderApp('/training', 'ra01');
    await user.click(await screen.findByRole('button', { name: '送出訓練「cls」' }));
    await user.click(await screen.findByRole('button', { name: '取消訓練' }));
    await user.click(within(screen.getByRole('dialog', { name: '取消訓練' })).getByRole('button', { name: '確定取消' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已取消'));
    await user.click(screen.getByRole('button', { name: '以同一資料版本與種子重跑' }));
    await screen.findByRole('heading', { name: '訓練 #2：cls' });
    expect(trainingMock().runs[1]).toMatchObject({ parent_run_id: 1, seed: 1, dataset_version_id: 1 });
  });
});

describe('模型匯出', () => {
  const saved: string[] = [];
  beforeEach(() => {
    saved.length = 0;
    // jsdom 沒有 Blob URL；下載只檢查存檔的檔名
    URL.createObjectURL = () => 'blob:mock';
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function finishedRun(username: string, kind: TrainingKind, name: string) {
    seedSetting(kind, name, username);
    const utils = await renderApp('/training', username);
    await utils.user.click(await screen.findByRole('button', { name: `送出訓練「${name}」` }));
    await utils.user.click(await screen.findByRole('button', { name: '重新整理' }));
    await utils.user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'));
    return utils;
  }

  it('TC-B05-06 downloads the Keras H5 of a finished image run and shows its sha256', async () => {
    const { user } = await finishedRun('pi01', 'image_detection', 'det');
    await user.click(screen.getByRole('button', { name: '下載模型（H5）' }));
    expect(await screen.findByText(/^已下載 det-run1\.h5（SHA-256：[0-9a-f]{64}）$/)).toBeInTheDocument();
    expect(saved).toEqual(['det-run1.h5']);
  });

  it('TC-B05-05 / 06 tabular run: pkl download and source export with Coding permission', async () => {
    const { user } = await finishedRun('pi01', 'tabular_classification', 'cls');
    await user.click(screen.getByRole('button', { name: '下載模型（PKL）' }));
    await screen.findByText(/^已下載 cls-run1\.pkl/);
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: '匯出原始碼' }));
      await screen.findByText('已下載 training-run-1-source.zip');
    }
    expect(saved).toEqual(['cls-run1.pkl', 'training-run-1-source.zip', 'training-run-1-source.zip', 'training-run-1-source.zip']);
  });

  it('without Coding the source export is hidden and explained', async () => {
    await finishedRun('ra01', 'tabular_regression', 'reg');
    expect(screen.getByRole('button', { name: '下載模型（PKL）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '匯出原始碼' })).toBeNull();
    expect(screen.getByText(/匯出原始碼需要 Coding 權限/)).toBeInTheDocument();
  });
});
