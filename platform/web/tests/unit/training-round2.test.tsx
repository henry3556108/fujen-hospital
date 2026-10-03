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
