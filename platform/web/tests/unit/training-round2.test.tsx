// 使用性測試第二輪（docs/usability/2026-10-03-after.md）：One-Hot 欄位在訓練表單的呈現、缺值、分享、設定差異、
// 術語與圖表、次要問題。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import type { TrainingConfig, TrainingKind } from '../../src/pages/training/api';
import { featureChoices, normaliseFeatures, unknownFeatures } from '../../src/pages/training/settingForm';
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
    expect(await within(form).findByRole('checkbox', { name: 'sex（已轉成 sex_F、sex_M）' })).toBeChecked();
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
    await user.click(screen.getByRole('link', { name: '部署此模型' }));
    const tryForm = await screen.findByRole('form', { name: '試用預測' });
    expect(tryForm).toHaveTextContent('沒有的資料可以留白');
    await user.type(within(tryForm).getByLabelText('age'), '61');
    await user.click(within(tryForm).getByRole('button', { name: '預測' }));
    expect(await within(tryForm).findByTestId('try-result')).toHaveTextContent(/glucose 缺值，已用訓練資料的中位數補上/);
  });
});
