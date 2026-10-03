// 第三輪使用性改善（docs/usability/2026-10-03-round2.md）：一個結論、依演算法的建議、顯示名稱、
// 數目與操作一致、在結果旁預測病人、次要問題。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import type { TrainingConfig, TrainingKind, TrainingRun } from '../../src/pages/training/api';
import { verdict, warnings } from '../../src/pages/training/metrics';
import { renderApp } from '../render';

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
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, 'kf');
    const r = trainingMock().runs[0] as unknown as TrainingRun;
    const sentence = verdict(r)!.text;
    expect(sentence).toMatch(/^(優秀|良好|尚可|偏弱|接近亂猜)（AUC 0\.\d\d，5 折平均）$/);
    expect(screen.getByTestId('verdict')).toHaveTextContent(`整體表現：${sentence}`);
    expect(within(screen.getByRole('table', { name: '訓練清單' })).getByText(sentence)).toBeInTheDocument();
    // 重點指標卡用同一個來源（K 折平均）
    const cards = screen.getByRole('list', { name: '訓練 #1 的重點指標' });
    expect(cards).toHaveTextContent(`AUC（ROC 曲線下面積）${(r.metrics.cv as { auc: { mean: number } }).auc.mean.toFixed(3).replace(/0+$/, '')}`);
    expect(screen.getByText('以下數字是 5 折平均（80 人輪流當檢查資料）。')).toBeInTheDocument();
    expect(screen.getByTestId('baseline')).toHaveTextContent(/^比較基準：每個人都猜「0」（訓練資料最常見的）可猜對 \d+%；模型要明顯高於它才有用。$/);
    // 測試集數字與提醒都在收合的「詳細」裡
    const details = screen.getByTestId('result-details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(/測試集只有 20 人/)).toBeInTheDocument();
    expect(within(details).getByRole('table', { name: '訓練 #1 的 K 折結果' })).toBeInTheDocument();
  });

  it('warnings are short and the training gap is compared with the K-fold mean, not the small test set', () => {
    const notes = warnings(run(round2));
    expect(notes.every((n) => n.length <= 90)).toBe(true);
    // 訓練 81.3% 對 K 折 80%：沒有過度配適，不該出現「只記住訓練資料」
    expect(notes.join('\n')).not.toMatch(/只記住/);
    expect(notes.join('\n')).toContain('以 K 折平均為準');
  });
});
