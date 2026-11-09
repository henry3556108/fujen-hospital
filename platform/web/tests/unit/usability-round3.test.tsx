// 第三輪使用性改善（docs/usability/2026-10-03-round2.md）：一個結論、依演算法的建議、顯示名稱、
// 數目與操作一致、在結果旁預測病人、次要問題。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import type { TrainingConfig, TrainingKind, TrainingRun } from '../../src/pages/training/api';
import { headlineNumber, verdict, warnings } from '../../src/pages/training/metrics';
import { renderApp } from '../render';
import { resetInferenceMock } from '../../src/mocks/inference';
import { inferencePolling, type Model } from '../../src/pages/inference/api';
import { correctness, modeName } from '../../src/pages/inference/InferencePage';
import { formatStat } from '../../src/components/format';
import { createApiClient } from '../../src/api/client';
import { featureCountText } from '../../src/pages/tabular/columnOverview';
import { savedSummary } from '../../src/pages/tabular/PrepareTab';
import type { CatalogueItem, TargetFeature } from '../../src/pages/tabular/types';

trainingMockOptions.stepMs = 0;
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function tabularConfig(kind: TrainingKind, extra: Partial<TrainingConfig> = {}, algorithm = 'random_forest'): TrainingConfig {
  return {
    version: 1, kind, source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 1,
    tabular: { target: kind === 'tabular_regression' ? 'sbp' : 'diagnosis', features: ['age', 'bmi'], steps: [], algorithm },
    hyperparameters: {}, ...extra,
  };
}

function seed(name: string, config: TrainingConfig, owner = 'pi01') {
  const s = trainingMock();
  s.settings.push({ id: s.nextSetting++, project_id: 1, name, kind: config.kind, config, created_by: owner, updated_by: owner,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
}

async function finish(user: UserEvent, name: string) {
  await user.click(await screen.findByRole('button', { name: `送出訓練「${name}」` }));
  await user.click(await screen.findByRole('button', { name: '重新整理' }));
  await user.click(screen.getByRole('button', { name: '重新整理' }));
  await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'));
}

const run = (metrics: Record<string, unknown>, kind: TrainingKind = 'tabular_classification', algorithm = 'logistic_regression') =>
  ({ id: 1, kind, executor: 'template', metrics, config: tabularConfig(kind, {}, algorithm) }) as unknown as TrainingRun;

// 第二輪測試的情形：5 折平均 AUC 0.837，測試集 20 人 AUC 0.725、準確率 60%，訓練集 81.3%
const round2 = {
  rows: { train: 80, validation: 0, test: 20 },
  labels: { majority: '0', positive: '1', majority_train: { count: 52, rows: 80 } },
  train: { accuracy: 0.813, auc: 0.9 },
  test: { accuracy: 0.6, auc: 0.725, sensitivity: 0.538, specificity: 0.714, baseline_accuracy: 0.35 },
  cv: { method: 'kfold', folds: 5, rows: 80, stratified: true,
    auc: { mean: 0.837, std: 0.0485, values: [0.818, 0.818, 0.817, 0.933, 0.8] },
    accuracy: { mean: 0.8, std: 0.061, values: [0.813, 0.688, 0.875, 0.813, 0.813] },
    baseline_accuracy: { mean: 0.65, std: 0.01, values: [0.65, 0.65, 0.65, 0.65, 0.65] } },
};

describe('1 一個結論', () => {
  it('uses the K-fold mean when there is one, otherwise the test set, then validation', () => {
    expect(verdict(run(round2))?.text).toBe('良好（AUC 0.84，5 折平均）');
    const { cv: _cv, ...noCv } = round2;
    expect(verdict(run(noCv))?.text).toBe('尚可（AUC 0.73，測試集）');
    expect(verdict(run({ rows: { validation: 20 }, validation: { auc: 0.95 } }))?.text).toBe('優秀（AUC 0.95，驗證集）');
  });

  it('grades AUC, R², and accuracy against the baseline with fixed thresholds', () => {
    const auc = (v: number) => verdict(run({ test: { auc: v } }))?.grade;
    expect([0.95, 0.85, 0.75, 0.6, 0.5].map(auc)).toEqual(['優秀', '良好', '尚可', '偏弱', '接近亂猜']);
    const r2 = (v: number) => verdict(run({ test: { r2: v } }, 'tabular_regression'))?.grade;
    expect([0.92, 0.75, 0.55, 0.3, 0.1].map(r2)).toEqual(['優秀', '良好', '尚可', '偏弱', '幾乎沒有預測能力']);
    // 多類別沒有 AUC：看準確率比「全部猜最常見的類別」高多少
    const acc = (v: number) => verdict(run({ test: { accuracy: v, baseline_accuracy: 0.4 } }))?.text;
    expect(acc(0.65)).toBe('良好（準確率 65%，測試集）');
    expect(acc(0.52)).toBe('尚可（準確率 52%，測試集）');
    expect(acc(0.42)).toBe('沒有比全部猜最常見的類別好（準確率 42%，測試集）');
  });

  it('the run list and the result show the same sentence; test numbers and short warnings are folded into 詳細', async () => {
    seed('kf', tabularConfig('tabular_classification', { split: { train: 0.8, validation: 0, test: 0.2 }, validation: { method: 'kfold', folds: 5 } }));
    const { user } = await renderApp('/training/settings', 'pi01');
    await finish(user, 'kf');
    const r = trainingMock().runs[0] as unknown as TrainingRun;
    const sentence = verdict(r)!.text;
    expect(sentence).toMatch(/^(優秀|良好|尚可|偏弱|接近亂猜)（AUC 0\.\d\d，5 折平均）$/);
    expect(screen.getByTestId('verdict')).toHaveTextContent(`整體表現：${sentence}`);
    // 重點指標卡用同一個來源（K 折平均）
    const cards = screen.getByRole('list', { name: '訓練 #1 的重點指標' });
    expect(cards).toHaveTextContent(`AUC（ROC 曲線下面積）${headlineNumber('auc', (r.metrics.cv as { auc: { mean: number } }).auc.mean)}`);
    // 「用這個模型預測病人」緊接在結論與重點指標下方，不必捲到圖表後面
    const predict = screen.getByRole('link', { name: '執行推論' });
    expect(predict.compareDocumentPosition(screen.getByTestId('result-details')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('以下數字是 5 折平均（80 人輪流當檢查資料）。')).toBeInTheDocument();
    expect(screen.getByTestId('baseline')).toHaveTextContent(/^比較基準：每個人都猜「0」（訓練集最常見的）可猜對 \d+%；模型要明顯高於它才有用。$/);
    // 測試集數字與提醒都在收合的「詳細」裡
    const details = screen.getByTestId('result-details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(/測試集只有 20 人/)).toBeInTheDocument();
    expect(within(details).getByRole('table', { name: '訓練 #1 的 K 折結果' })).toBeInTheDocument();
    // 訓練紀錄清單用同一句
    await user.click(screen.getByRole('link', { name: '訓練紀錄' }));
    expect(within(await screen.findByRole('table', { name: '訓練清單' })).getByText(sentence)).toBeInTheDocument();
  });

  it('warnings are short and the training gap is compared with the K-fold mean, not the small test set', () => {
    const notes = warnings(run(round2));
    expect(notes.every((n) => n.length <= 90)).toBe(true);
    // 訓練 81.3% 對 K 折 80%：沒有過度配適，不該出現「只記住訓練集」
    expect(notes.join('\n')).not.toMatch(/只記住/);
    expect(notes.join('\n')).toContain('以 K 折平均為準');
  });
});

describe('2 建議依演算法', () => {
  // 訓練集 95%、測試集 70%：只記住訓練集
  const overfit = { rows: { train: 300, validation: 0, test: 100 }, train: { accuracy: 0.95, r2: 0.95 }, test: { accuracy: 0.7, r2: 0.6 } };
  const advice = (algorithm: string, kind: TrainingKind = 'tabular_classification') =>
    warnings(run(overfit, kind, algorithm)).find((n) => n.includes('只記住'))!;

  it('logistic regression: stronger regularisation or fewer features, never tree depth', () => {
    expect(advice('logistic_regression')).toContain('把「正則化強度的倒數（C）」調小');
    expect(advice('logistic_regression')).toContain('減少 Feature 欄位');
    expect(advice('logistic_regression')).not.toMatch(/樹|深度/);
  });

  it('random forest: depth and leaf size', () => {
    expect(advice('random_forest')).toContain('「最大深度」設小一點');
    expect(advice('random_forest')).toContain('「葉節點最少樣本數」調大');
    expect(advice('random_forest', 'tabular_regression')).toContain('「最大深度」設小一點');
  });

  it('gradient boosting: learning rate and number of trees', () => {
    expect(advice('gradient_boosting')).toContain('「學習率」調低');
    expect(advice('gradient_boosting')).toContain('減少「樹的數量」');
  });

  it('linear regression: fewer features, no hyperparameter that does not exist', () => {
    expect(advice('linear_regression', 'tabular_regression')).toContain('減少 Feature 欄位');
    expect(advice('linear_regression', 'tabular_regression')).not.toMatch(/樹|深度|正則化|學習率/);
  });
});

describe('3 顯示名稱用在所有地方', () => {
  it('after sharing with a Chinese name, the message, both model lists, the prediction heading and result use it', async () => {
    const first = await renderApp('/models/101/share', 'pi01');
    const form = await screen.findByRole('form', { name: '部署並設定權限' });
    const title = within(form).getByLabelText('顯示名稱（同事看到的名稱，可用中文）');
    await waitFor(() => expect(title).toHaveValue('diagnosis-rf'));   // 等建議名稱帶入後再改
    await first.user.clear(title);
    await first.user.type(title, '心臟科確診預測（測試）');
    await first.user.type(within(form).getByLabelText('授權帳號（以逗號分隔）'), 'md01');
    await first.user.click(within(form).getByRole('button', { name: '部署並設定權限' }));
    const done = await screen.findByText(/^已把「心臟科確診預測（測試）」授權給 md01/);
    expect(done).toHaveTextContent('打開模型「心臟科確診預測（測試）」就能預測');
    expect(done).not.toHaveTextContent('run1');
    const shared = screen.getByRole('table', { name: '已部署的模型' });
    expect(await within(shared).findByRole('row', { name: /心臟科確診預測（測試）/ })).toBeInTheDocument();
    first.unmount();

    const second = await renderApp('/models', 'md01');
    const list = await screen.findByRole('table', { name: '模型清單' });
    const row = within(list).getByRole('row', { name: /心臟科確診預測（測試）（模型名稱：diagnosis-rf-run1）/ });
    expect(row).toHaveTextContent('pi01 已授權給你');
    await second.user.click(within(row).getByRole('link'));
    await second.user.click(await screen.findByRole('link', { name: '推論' }));
    expect((await screen.findAllByRole('heading', { name: /心臟科確診預測（測試）/ })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /^diagnosis-rf-run1/ })).toBeNull();
  });
});

describe('4 數目與使用者的操作一致', () => {
  it('counts the columns the user ticked, explains the One Hot Encoding split and lists the missing-value choice', async () => {
    const original = ['patient_id', 'age', 'sex', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker', 'diagnosis'];
    const steps = [{ id: 'onehot', columns: ['sex', 'smoker'], params: {} }];
    const saved = ['age', 'sex_F', 'sex_M', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker_current', 'smoker_former', 'smoker_never'];
    expect(featureCountText(saved, original, steps)).toBe('7 個欄位（sex、smoker 自動拆成 5 欄）');
    expect(featureCountText(['age', 'bmi'], original, [])).toBe('2 個欄位');
    expect(savedSummary({ config: { target: 'diagnosis', features: saved, steps, missing: 'impute' } } as unknown as TargetFeature, original,
      [{ id: 'onehot', name_zh: 'One Hot Encoding', params: { properties: {} } } as unknown as CatalogueItem]))
      .toBe('已儲存：Target 欄位 diagnosis；Feature 欄位 7 個欄位（sex、smoker 自動拆成 5 欄）；有缺值的病人：補值後使用；前處理 1 個步驟（One Hot Encoding：sex、smoker）');
  });

  it('the training form opened from the dataset says the same and names the steps in Chinese', async () => {
    const api = createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:pi01', onUnauthorized: () => {} });
    await api.put('/api/projects/1/tabular/datasets/2/target-feature', {
      target: 'diagnosis', features: ['age', 'sex_F', 'sex_M', 'glucose'], missing: 'impute',
      steps: [{ id: 'onehot', columns: ['sex'], params: { drop_first: false } }],
    });
    const { user } = await renderApp('/training?dataset=2', 'pi01');
    expect(await screen.findByText(/已帶入資料集「lung-clinical」的設定：Target 欄位 diagnosis；Feature 欄位 3 個欄位（sex 自動拆成 2 欄）；有缺值的病人：補值後使用；前處理 1 個步驟（One Hot Encoding：sex）。/))
      .toBeInTheDocument();
    // 舊網址轉到建立訓練任務精靈的「確認資料」；下一步才是完整表單
    await user.click(screen.getByRole('button', { name: '下一步：確認並送出' }));
    expect(await screen.findByText(/前處理步驟 1 個（在「數據管理」的資料集設定）：One Hot Encoding：sex/)).toBeInTheDocument();
    expect(screen.queryByText(/：onehot/)).toBeNull();
  });
});

describe('5 在結果旁預測病人', () => {
  beforeEach(() => Object.assign(inferencePolling, { firstMs: 1, maxMs: 5 }));
  afterEach(() => {
    resetInferenceMock();
    Object.assign(inferencePolling, { firstMs: 1000, maxMs: 5000 });
  });

  it('a finished run links to prediction with the model already chosen', async () => {
    seed('cls', tabularConfig('tabular_classification'));
    const { user } = await renderApp('/training/settings', 'pi01');
    await finish(user, 'cls');
    const link = screen.getByRole('link', { name: '執行推論' });
    const id = trainingMock().runs[0].id;
    expect(link).toHaveAttribute('href', `/models/${id}/predict`);
  });

  it('the prediction page opens on that model with one patient and many patients; the batch result shows right or wrong', async () => {
    // 舊連結 /inference?model=ID 直接打開那個模型的「推論」
    const first = await renderApp('/inference?model=102', 'pi01');
    expect(await screen.findByRole('heading', { name: '預測：modality-cnn-run2' })).toBeInTheDocument();
    first.unmount();
    const { user } = await renderApp('/models/101/predict', 'pi01');

    // 一位病人：模型已選好，不必再選
    const one = await screen.findByRole('form', { name: '一位病人' });
    expect(within(one).queryByLabelText('模型')).toBeNull();
    for (const [f, v] of [['age', '60'], ['bmi', '25'], ['glucose', '100'], ['sbp', '130']]) await user.type(within(one).getByLabelText(f), v);
    await user.click(within(one).getByRole('button', { name: '預測' }));
    expect(await within(one).findByTestId('try-result')).toHaveTextContent(/^diagnosis＝1 的機率 \d+%（模型預測為「[01]」）/);
    await user.click(screen.getByRole('link', { name: '推論服務歷史紀錄' }));
    expect(await within(await screen.findByRole('table', { name: '推論服務歷史紀錄' })).findByRole('row', { name: /#1/ })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '推論' }));

    // 多位病人：測試集含實際的 diagnosis → 預測對／錯與一行統計
    await user.click(screen.getByRole('button', { name: '多位病人一起預測' }));
    const table = await screen.findByRole('table', { name: '預測結果' });
    expect(await screen.findByTestId('table-correct')).toHaveTextContent(/^有實際的 diagnosis 可以對照：\d+ 位中預測對 \d+ 位（\d+%）。$/);
    const marks = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[4].textContent);
    expect(marks.every((m) => m === '對' || m === '錯' || m === '—')).toBe(true);
    expect(within(table).queryByRole('columnheader', { name: 'prediction' })).toBeNull();
  });

  it('correctness compares numbers and text, and skips rows without a prediction', () => {
    const model = { kind: 'tabular_classification', card: { target: 'diagnosis' } } as Model;
    const result = { columns: ['id', 'diagnosis', 'prediction', 'prediction_note'], prediction_column: 'prediction',
      rows: [['a', '1', '1.0', ''], ['b', '0', '1', ''], ['c', '1', '', '特徵含缺值，無法推論'], ['d', 'yes', 'yes', '']] };
    expect(correctness(result, model)).toEqual({ column: 'diagnosis', marks: ['對', '錯', '', '對'], right: 2, total: 3 });
    expect(correctness({ ...result, columns: ['id', 'x', 'prediction', 'prediction_note'] }, model)).toBeNull();
    expect(correctness(result, { ...model, kind: 'tabular_regression' } as Model)).toBeNull();
  });
});

describe('6 次要問題', () => {
  afterEach(() => resetInferenceMock());

  it('a single try-out is recorded as 即時推論, not 上傳檔案', async () => {
    const { user } = await renderApp('/inference?model=101', 'pi01');
    const one = await screen.findByRole('form', { name: '一位病人' });
    for (const [f, v] of [['age', '60'], ['bmi', '25'], ['glucose', '100'], ['sbp', '130']]) await user.type(within(one).getByLabelText(f), v);
    await user.click(within(one).getByRole('button', { name: '預測' }));
    await within(one).findByTestId('try-result');
    await user.click(screen.getByRole('link', { name: '推論服務歷史紀錄' }));
    const history = await screen.findByRole('table', { name: '推論服務歷史紀錄' });
    expect(await within(history).findByRole('row', { name: /#1\s*即時推論/ })).toBeInTheDocument();
    expect(modeName({ mode: 'upload', input: {} })).toBe('上傳檔案');
    expect(modeName({ mode: 'upload', input: { source: 'try' } })).toBe('即時推論');
  });

  it('statistics are rounded for display only; the full value is on hover', async () => {
    expect([19.7987, 0.048532, 169.4567, 59.15, 41.75, 3].map(formatStat)).toEqual(['19.8', '0.0485', '169.5', '59.15', '41.75', '3']);
    await renderApp('/data/tabular/2/view?show=describe', 'vw01');
    const table = await screen.findByRole('table', { name: '描述性統計' });
    const std = within(within(table).getByRole('row', { name: /^age / })).getByText('19.8');
    expect(std).toHaveAttribute('title', expect.stringMatching(/^19\.79/));
  });

  it('a dataset opens on 資料視覺化; each tab says in one line what it is for', async () => {
    const { user } = await renderApp('/data/tabular/2', 'vw01');
    expect(await screen.findByRole('table', { name: '資料預覽' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: '資料集分頁' });
    expect(within(tabs).getAllByRole('link').map((l) => l.textContent)).toEqual(['資料視覺化', '資料清洗', '醫學統計分析']);
    expect(screen.getByTestId('tab-hint')).toHaveTextContent('資料視覺化：逐列預覽、每一欄的平均與分布');
    await user.click(screen.getByRole('button', { name: '欄位描述性統計' }));
    expect(await screen.findByRole('table', { name: '描述性統計' })).toBeInTheDocument();
    await user.click(within(tabs).getByRole('link', { name: '醫學統計分析' }));
    expect(await screen.findByTestId('tab-hint')).toHaveTextContent('醫學統計分析：找出哪些因素和結果有關');
  });

  it('資料清洗 says most users do not need to add steps themselves', async () => {
    await renderApp('/data/tabular/2/prepare', 'pi01');
    expect(await screen.findByTestId('steps-not-needed', {}, { timeout: 10_000 })).toHaveTextContent('大多數人不需要自己加步驟');
    expect(screen.getByLabelText('Target 欄位')).toBeInTheDocument();
    expect(screen.getByText('Feature 欄位')).toBeInTheDocument();
  });
});
