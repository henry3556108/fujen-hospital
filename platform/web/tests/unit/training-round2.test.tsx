// 使用性測試第二輪（docs/usability/2026-10-03-after.md）：One-Hot 欄位在訓練表單的呈現、缺值、分享、設定差異、
// 術語與圖表、次要問題。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { BarChart, tickLayout } from '../../src/components/charts/BarChart';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import type { TrainingConfig, TrainingKind, TrainingRun } from '../../src/pages/training/api';
import { metricLabel, plainSentence, warnings } from '../../src/pages/training/metrics';
import { featureChoices, normaliseFeatures, settingDifference, unknownFeatures } from '../../src/pages/training/settingForm';
import { createApiClient } from '../../src/api/client';
import { renderApp } from '../render';

const ONEHOT = [{ id: 'onehot', columns: ['sex', 'smoker'], params: { drop_first: false } }];

async function saveTargetFeature(target: string, features: string[], steps: unknown[] = [], extra: Record<string, unknown> = {}) {
  const api = createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:pi01', onUnauthorized: () => {} });
  await api.put('/api/projects/1/tabular/datasets/2/target-feature', { target, features, steps, ...extra });
}

trainingMockOptions.stepMs = 0;
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => vi.restoreAllMocks());

function tabularConfig(kind: TrainingKind, tabular: Partial<NonNullable<TrainingConfig['tabular']>> = {}, extra: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    version: 1, kind, source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 1,
    tabular: { target: 'diagnosis', features: ['age', 'bmi'], steps: [], algorithm: 'random_forest', ...tabular },
    hyperparameters: {}, ...extra,
  };
}

function seed(name: string, config: TrainingConfig, owner = 'pi01') {
  const s = trainingMock();
  s.settings.push({ id: s.nextSetting++, project_id: 1, name, kind: config.kind, config, created_by: owner, updated_by: owner,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
}

describe('1 One-Hot 欄位在訓練表單', () => {
  const original = ['patient_id', 'age', 'sex', 'smoker', 'diagnosis'];
  const processed = ['patient_id', 'age', 'sex_F', 'sex_M', 'smoker_current', 'smoker_former', 'smoker_never', 'diagnosis'];

  it('groups generated columns under their original column and keeps other columns as they are', () => {
    const choices = featureChoices(original, processed, ONEHOT, 'diagnosis');
    expect(choices.map((c) => [c.name, c.columns.join('+'), c.encoded])).toEqual([
      ['patient_id', 'patient_id', false], ['age', 'age', false], ['sex', 'sex_F+sex_M', true],
      ['smoker', 'smoker_current+smoker_former+smoker_never', true],
    ]);
    expect(normaliseFeatures(['age', 'sex', 'sex_F'], choices)).toEqual(['age', 'sex_F', 'sex_M']);
    expect(unknownFeatures(['age', 'sex'], processed)).toEqual(['sex']);
    expect(featureChoices(original, null, ONEHOT, 'diagnosis').map((c) => c.name)).toEqual(['patient_id', 'age', 'sex', 'smoker']);
  });

  it('shows sex once, ticked, with its generated columns; unticking and ticking moves all of them; the original cannot be chosen', async () => {
    await saveTargetFeature('diagnosis', ['age', 'sex_F', 'sex_M', 'smoker_current', 'smoker_former', 'smoker_never'], ONEHOT);
    const { user } = await renderApp('/training?dataset=2', 'pi01');
    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    const group = await within(form).findByRole('group', { name: /用來預測的資料（Feature）/ });
    const sex = await within(group).findByRole('checkbox', { name: 'sex（已轉成 sex_F、sex_M）' });
    expect(sex).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'smoker（已轉成 smoker_current、smoker_former、smoker_never）' })).toBeChecked();
    expect(within(group).queryByRole('checkbox', { name: 'sex' })).toBeNull();
    expect(within(group).queryByRole('checkbox', { name: 'sex_F' })).toBeNull();
    await user.click(sex);
    expect(sex).not.toBeChecked();
    await user.click(sex);
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText(/已新增訓練設定/);
    expect(trainingMock().settings[0].config.tabular!.features.slice().sort()).toEqual(
      ['age', 'sex_F', 'sex_M', 'smoker_current', 'smoker_former', 'smoker_never']);
  });

  it('an old setting that lists the original column next to its One-Hot step opens with the generated columns', async () => {
    seed('舊設定', tabularConfig('tabular_classification', { features: ['age', 'sex'], steps: [{ id: 'onehot', columns: ['sex'], params: { drop_first: false } }] }));
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '編輯「舊設定」' }));
    const form = await screen.findByRole('form', { name: '修改訓練設定「舊設定」' });
    // 前處理後的欄位載入後才換成產生的欄位：等它換好（整套平行執行時較慢）
    const sex = await within(form).findByRole('checkbox', { name: 'sex（已轉成 sex_F、sex_M）' });
    await waitFor(() => expect(sex).toBeChecked());
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已儲存訓練設定「舊設定」的修改。');
    expect(trainingMock().settings[0].config.tabular!.features).toEqual(['age', 'sex_F', 'sex_M']);
  });

  it('a feature that no longer exists after preprocessing is reported on screen before saving', async () => {
    seed('壞掉的', tabularConfig('tabular_classification', { features: ['age', 'bmi_z'] }));
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '編輯「壞掉的」' }));
    const form = await screen.findByRole('form', { name: '修改訓練設定「壞掉的」' });
    expect(await within(form).findByTestId('feature-problems')).toHaveTextContent('「bmi_z」在資料集裡找不到');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('bmi_z');
    expect(trainingMock().settings[0].config.tabular!.features).toEqual(['age', 'bmi_z']);
    await user.click(within(form).getByRole('checkbox', { name: 'bmi_z（資料集裡找不到）' }));
    await waitFor(() => expect(within(form).queryByTestId('feature-problems')).toBeNull());
  });
});

async function finish(user: Awaited<ReturnType<typeof renderApp>>['user'], name: string) {
  await user.click(await screen.findByRole('button', { name: `送出訓練「${name}」` }));
  await user.click(await screen.findByRole('button', { name: '重新整理' }));
  await user.click(screen.getByRole('button', { name: '重新整理' }));
  await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'));
}

describe('2 缺值', () => {
  it('the Target/Feature overview names the feature with gaps and saves the one-click choice', async () => {
    const { user } = await renderApp('/data/tabular/2/target', 'pi01');
    const form = await screen.findByRole('form', { name: '設定 Target 與 Feature' }, { timeout: 10_000 });
    await user.click(within(form).getByRole('radio', { name: '以 diagnosis 為 Target' }));
    await user.click(within(form).getByRole('checkbox', { name: 'age' }));
    expect(within(form).queryByTestId('tf-missing')).toBeNull();
    await user.click(within(form).getByRole('checkbox', { name: 'glucose' }));
    const choice = within(form).getByTestId('tf-missing');
    expect(choice).toHaveTextContent(/glucose 有 \d+ 位病人沒有資料（缺值）/);
    expect(within(choice).getByRole('radio', { name: /^補上缺值，所有病人都使用（建議）/ })).toBeChecked();
    await user.click(within(choice).getByRole('radio', { name: /^不使用這些病人/ }));
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByTestId('saved-missing')).toHaveTextContent('不使用');
  });

  it('the training form carries the dataset choice, shows it next to the features and saves it in the setting', async () => {
    await saveTargetFeature('diagnosis', ['age', 'glucose'], [], { missing: 'impute' });
    const { user } = await renderApp('/training?dataset=2', 'pi01');
    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    const choice = await within(form).findByTestId('ts-missing');
    expect(choice).toHaveTextContent(/glucose 有 \d+ 位病人沒有資料/);
    expect(within(choice).getByRole('radio', { name: /^補上缺值/ })).toBeChecked();
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText(/已新增訓練設定/);
    expect(trainingMock().settings[0].config.tabular!.missing).toBe('impute');
  });

  it('results say how many patients were used and why some were left out', async () => {
    seed('排除', tabularConfig('tabular_classification', { features: ['age', 'glucose'], missing: 'drop' }));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, '排除');
    expect(screen.getByTestId('data-usage')).toHaveTextContent(
      '共 100 位病人，訓練 57 位、驗證 19 位、測試 19 位。特徵有缺值的 5 位沒有使用（缺值：glucose 5 位）。');
  });

  it('results of a filled run say how many patients had values filled', async () => {
    seed('補值', tabularConfig('tabular_classification', { features: ['age', 'glucose'], missing: 'impute' }));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, '補值');
    expect(screen.getByTestId('data-usage')).toHaveTextContent('訓練 60 位、驗證 20 位、測試 20 位。有 5 位的缺值（glucose 5 位）已用訓練資料的中位數或最常見的值補上。');
  });

  it('try-out prediction of a filled model accepts a blank value', async () => {
    seed('補值試用', tabularConfig('tabular_classification', { features: ['age', 'glucose'], missing: 'impute' }));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, '補值試用');
    await user.click(screen.getByRole('link', { name: '分享給同事使用' }));
    const tryForm = await screen.findByRole('form', { name: '試用預測' });
    expect(tryForm).toHaveTextContent('沒有的資料可以留白');
    await user.type(within(tryForm).getByLabelText('age'), '61');
    await user.click(within(tryForm).getByRole('button', { name: '預測' }));
    expect(await within(tryForm).findByTestId('try-result')).toHaveTextContent(/glucose 缺值，已用訓練資料的中位數補上/);
  });
});

describe('4 與資料集設定的差異', () => {
  const tf = { target: 'diagnosis', features: ['age', 'sex_F', 'sex_M'], steps: [{ id: 'onehot', columns: ['sex'], params: { drop_first: false } }] };

  it('ignores feature order, key order and empty params, and the missing choice when the dataset has none', () => {
    expect(settingDifference({ ...tf, features: ['sex_M', 'age', 'sex_F'] }, tf)).toBeNull();
    expect(settingDifference({ ...tf, steps: [{ params: { drop_first: false }, columns: ['sex'], id: 'onehot' }] }, tf)).toBeNull();
    expect(settingDifference({ target: 'y', features: ['a'], steps: [{ id: 'impute_mean', columns: ['a'], params: {} }] },
      { target: 'y', features: ['a'], steps: [{ id: 'impute_mean', columns: ['a'] } as never] })).toBeNull();
    expect(settingDifference({ ...tf, missing: 'impute' }, tf)).toBeNull();
  });

  it('says in one sentence what really differs', () => {
    expect(settingDifference({ ...tf, features: ['age', 'sex_F', 'sex_M', 'glucose'] }, tf)).toBe('與資料集目前的設定不同：Feature 多了 glucose。');
    expect(settingDifference({ ...tf, target: 'event', missing: 'drop' }, { ...tf, missing: 'impute' })).toBe(
      '與資料集目前的設定不同：要預測的結果是「event」，資料集是「diagnosis」；缺值處理是「不使用有缺值的病人」，資料集是「補上缺值」。');
    expect(settingDifference({ ...tf, steps: [] }, tf)).toBe('與資料集目前的設定不同：前處理步驟不同（這裡 0 個，資料集 1 個）。');
  });

  it('a setting saved from the dataset shows no difference right after saving', async () => {
    await saveTargetFeature('diagnosis', ['sex_F', 'sex_M', 'age', 'glucose'], [{ id: 'onehot', columns: ['sex'] }], { missing: 'impute' });
    const { user } = await renderApp('/training?dataset=2', 'pi01');
    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    await within(form).findByRole('checkbox', { name: 'sex（已轉成 sex_F、sex_M）' });
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText(/已新增訓練設定/);
    await screen.findByRole('button', { name: /^送出訓練/ });
    await new Promise((r) => setTimeout(r, 300));     // 等資料集設定載入後再確認沒有差異提示
    expect(screen.queryByText('與資料集設定不同')).toBeNull();
  });
});

describe('5 術語與圖表', () => {
  it('histogram labels that would overlap are drawn slanted; short ones stay flat', () => {
    const band = 568 / 10;
    expect(tickLayout(['25–31.4', '31.4–37.8', '37.8–44.2'], band).angle).toBe(-40);
    expect(tickLayout(['25–31.4', '31.4–37.8'], band).extra).toBeGreaterThan(0);
    expect(tickLayout(['0', '1'], 284)).toEqual({ angle: 0, extra: 0, every: 1 });
  });

  it('feature importance is a horizontal bar chart with every feature name readable', async () => {
    render(<BarChart horizontal title="特徵重要性" xLabel="準確率下降（百分點）" yLabel="特徵"
      bars={[{ label: 'smoker_current', value: 9.5 }, { label: 'age', value: 3 }]} />);
    const fig = screen.getByRole('figure', { name: '特徵重要性' });
    expect(within(fig).getByRole('img', { name: '特徵重要性：2 個橫條，最大值 9.5' })).toBeInTheDocument();
    expect(fig.querySelector('svg')!.textContent).toContain('smoker_current');
  });

  it('the overview and the form use plain names for Target and Feature; statistics terms are explained up front', async () => {
    await renderApp('/data/tabular/2/target', 'pi01');
    const form = await screen.findByRole('form', { name: '設定 Target 與 Feature' }, { timeout: 10_000 });
    expect(within(form).getByRole('columnheader', { name: '要預測的結果（Target）' })).toBeInTheDocument();
    expect(within(form).getByRole('columnheader', { name: '用來預測的資料（Feature）' })).toBeInTheDocument();
  });

  it('describe headers carry hover help and the explanation is open by default', async () => {
    await renderApp('/data/tabular/2/describe', 'vw01');
    const table = await screen.findByRole('table', { name: '描述統計' });
    expect(within(table).getByText('P25')).toHaveAttribute('title', expect.stringContaining('25% 位置'));
    expect(within(table).getByText('標準差')).toHaveAttribute('title', expect.stringContaining('分散'));
    expect((screen.getByText(/^表頭說明/).closest('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('One-Hot hides “drop first category” under advanced with its default, and the summary leaves defaults out', async () => {
    const { user } = await renderApp('/data/tabular/2/preprocess', 'vw01');
    const form = await screen.findByRole('form', { name: '加入前處理步驟' });
    await user.selectOptions(within(form).getByLabelText('類別'), within(form).getByRole('option', { name: /^類別編碼/ }));
    await user.selectOptions(within(form).getByLabelText('方法'), 'One-Hot 編碼');
    const advanced = within(form).getByText('進階（一般不需要調整）').closest('details')!;
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByLabelText('移除第一個類別（避免共線）')).toBeInTheDocument();
    await user.click(within(form).getByRole('checkbox', { name: 'sex' }));
    await user.click(within(form).getByRole('button', { name: '加入步驟' }));
    expect(within(screen.getByRole('list', { name: '已加入的步驟' })).getByText('One-Hot 編碼：sex')).toBeInTheDocument();
  });

  it('K-fold results explain each metric, including F1', async () => {
    seed('kf', tabularConfig('tabular_classification', {}, { split: { train: 0.8, validation: 0, test: 0.2 }, validation: { method: 'kfold', folds: 5 } }));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, 'kf');
    const table = screen.getByRole('table', { name: '訓練 #1 的 K 折結果' });
    expect(within(table).getByRole('row', { name: /F1 分數/ })).toHaveTextContent('同時考慮「抓得到」與「抓得準」');
  });
});

describe('6 次要問題', () => {
  const run = (metrics: Record<string, unknown>) => ({ id: 1, kind: 'tabular_classification', executor: 'template', metrics }) as unknown as TrainingRun;

  it('the baseline names the training majority and explains a low score on a test set with fewer of them', () => {
    // 改善後測試的情形：訓練資料多數是「0」，測試集 18 人只有 7 人是「0」→ 38.9%
    const r = run({ rows: { train: 76, validation: 0, test: 18 }, labels: { majority: '0', positive: '1', majority_train: { count: 46, rows: 76 } },
      test: { accuracy: 0.667, baseline_accuracy: 7 / 18 } });
    expect(plainSentence(r, 'test', 'baseline_accuracy', 7 / 18)).toBe(
      '訓練資料中最常見的是「0」（76 人中 46 人）；如果測試集每個人都猜「0」，18 人中會猜對 7 人。測試集裡「0」只占 39%，比訓練資料的 61% 少，所以這個基準偏低');
    expect(metricLabel('baseline_accuracy')).toBe('比較基準：全部猜訓練資料最常見的類別');
  });

  it('explains when the test result differs from the K-fold mean', () => {
    const r = run({ rows: { train: 80, validation: 0, test: 18 }, test: { accuracy: 0.667, auc: 0.818 },
      cv: { method: 'kfold', folds: 5, rows: 80, stratified: true, accuracy: { mean: 0.791, std: 0.06, values: [] }, auc: { mean: 0.835, std: 0.04, values: [] } } });
    expect(warnings(r).join('\n')).toContain('測試集的準確率（66.7%）和 K 折平均（79.1%）差很多：測試集人數少，剛好分到哪些人影響很大；以 K 折平均為準。');
    const close = run({ rows: { train: 80, validation: 0, test: 18 }, test: { accuracy: 0.75 },
      cv: { method: 'kfold', folds: 5, rows: 80, stratified: true, accuracy: { mean: 0.79, std: 0.06, values: [] } } });
    expect(warnings(close).join('\n')).not.toContain('K 折平均（');
  });

  it('the header shows the Chinese role name', async () => {
    await renderApp('/training', 'pi01');
    expect(await screen.findByTestId('header-role')).toHaveTextContent('（計畫主持人）');
  });
});
