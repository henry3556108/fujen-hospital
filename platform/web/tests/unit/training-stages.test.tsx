// 各階段處理程式碼（錄製巨集）第一階段：標註、前處理、訓練三個階段的檢視與編輯、套用、一次列出全部錯誤、
// 鎖定（表單欄位停用、清單標籤）、改回用介面設定的確認視窗、權限、訓練紀錄標示。
import '../upload-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { ApiError, createApiClient } from '../../src/api/client';
import { normalise, trainingMock, trainingMockOptions } from '../../src/mocks/training';
import { lockedStages } from '../../src/mocks/trainingStages';
import type { TrainingConfig } from '../../src/pages/training/api';
import { keepLocked, lockText, stageNames } from '../../src/pages/training/stages';
import { renderApp } from '../render';
import { makeFile } from '../upload-env';

trainingMockOptions.stepMs = 0;
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => vi.restoreAllMocks());

const TABULAR: TrainingConfig = {
  version: 1, kind: 'tabular_classification', source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 },
  seed: 42, validation: { method: 'holdout' },
  tabular: { target: 'diagnosis', features: ['age', 'bmi'], steps: [], algorithm: 'random_forest' }, hyperparameters: { n_estimators: 20 },
};

function seed(name = '糖尿病預測', config: TrainingConfig = TABULAR) {
  const s = trainingMock();
  const row = { id: s.nextSetting++, project_id: 1, name, kind: config.kind, config: normalise(JSON.parse(JSON.stringify(config))),
    created_by: 'pi01', updated_by: 'pi01', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  s.settings.push(row);
  return row;
}

async function openFlow(name = '糖尿病預測', username = 'pi01') {
  const app = await renderApp('/training/settings', username);
  if (username !== 'pi01') await app.user.click(await screen.findByRole('checkbox', { name: '只看我建立的' }));
  await app.user.click(await screen.findByRole('link', { name: `各階段處理程式碼「${name}」` }));
  const panel = await screen.findByRole('region', { name: `各階段處理程式碼「${name}」` });
  await within(panel).findByRole('table', { name: '流程階段' });
  return { ...app, panel };
}

describe('輔助函式', () => {
  it('keeps the values of locked stages when the form is saved', () => {
    const changed: TrainingConfig = { ...TABULAR, seed: 1, split: { train: 0.7, validation: 0.1, test: 0.2 }, hyperparameters: { n_estimators: 5 },
      tabular: { ...TABULAR.tabular!, target: 'sbp', features: ['age'], algorithm: 'gradient_boosting', steps: [{ id: 'drop_columns', columns: ['bmi'], params: {} }] } };
    const out = keepLocked(changed, TABULAR, ['train']);
    expect(out.seed).toBe(42);
    expect(out.hyperparameters).toEqual({ n_estimators: 20 });
    expect(out.tabular!.algorithm).toBe('random_forest');
    expect(out.tabular!.target).toBe('sbp');
    const labels = keepLocked(changed, TABULAR, ['labels', 'preprocess']);
    expect([labels.tabular!.target, labels.tabular!.features, labels.tabular!.steps]).toEqual(['diagnosis', ['age', 'bmi'], []]);
    expect(labels.seed).toBe(1);
    expect(keepLocked(changed, TABULAR, [])).toBe(changed);
  });

  it('names stages and describes a lock', () => {
    expect(stageNames(['preprocess', 'train'])).toBe('資料清理與前處理、訓練');
    const text = lockText({ stage: 'preprocess', name: '資料清理與前處理', sha256: '41ab' + '0'.repeat(60), files: { 'preprocess.json': 'x', 'preprocess.py': 'y' },
      code_changed: true, imported_by: 'wang', imported_at: '2026-10-20T06:05:00Z' });
    expect(text).toMatch(/^「資料清理與前處理」由匯入的檔案控制：preprocess\.json、preprocess\.py（wang，.+ 匯入，sha256 41ab…）$/);
  });

  it('the API client keeps every error of a rejected stage file', async () => {
    const row = seed();
    const api = createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:pi01', onUnauthorized: () => {} });
    const err = await api.put(`/api/projects/1/training/settings/${row.id}/stages/labels`, {
      files: { 'labels.json': '{', 'labels.py': 'import xgboost\n' },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const messages = (err as ApiError).fieldErrors.map((f) => f.message);
    expect(messages).toEqual(['labels.json 不是正確的 JSON', 'labels.py 第 1 行 import 了平台沒有的套件「xgboost」',
      'labels.py 缺少函式 build_labels(frame, config)']);
    expect((err as ApiError).message).toBe('檔案不符合平台的流程框架，未套用');
  });
});

describe('各階段處理程式碼面板', () => {
  it('lists the stages controlled by the form', async () => {
    seed();
    const { panel } = await openFlow();
    const rows = within(within(panel).getByRole('table', { name: '流程階段' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['資料匯入', '標註', '資料清理與前處理', '訓練', '部署']);
    expect(rows.every((r) => r.textContent!.includes('介面設定'))).toBe(true);
    expect(within(panel).getByRole('button', { name: '下載整個流程（專案包）' })).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: /附上原始資料/ })).toBeInTheDocument();
  });

  it('edits the training stage in the browser, applies it and locks the stage', async () => {
    const row = seed();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視程式碼「訓練」' }));
    const config = await within(panel).findByRole('textbox', { name: 'train.json' });
    expect((within(panel).getByRole('textbox', { name: 'train.py' }) as HTMLTextAreaElement).value).toContain('def train(config, data_dir, out_dir)');
    const values = JSON.parse((config as HTMLTextAreaElement).value) as { hyperparameters: Record<string, number> };
    expect(values.hyperparameters.n_estimators).toBe(20);
    values.hyperparameters.n_estimators = 7;
    await user.clear(config);
    await user.click(config);
    await user.paste(JSON.stringify(values));
    await user.click(within(panel).getByRole('button', { name: '套用「訓練」' }));
    await within(panel).findByText(/已套用「訓練」：這個階段改由匯入的內容控制/);
    expect(trainingMock().settings.find((s) => s.id === row.id)!.config.hyperparameters.n_estimators).toBe(7);
    expect(lockedStages(row.id)).toEqual(['train']);
    expect(within(panel).getByText('匯入檔控制')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '改回用介面設定「訓練」' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '訓練設定' }));
    expect(await screen.findByTestId('locked-stages')).toHaveTextContent('匯入控制：訓練');
  });

  it('lists every problem at once and does not change the setting', async () => {
    const row = seed();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視程式碼「標註」' }));
    const code = await within(panel).findByRole('textbox', { name: 'labels.py' });
    await user.clear(code);
    await user.click(code);
    await user.paste('import xgboost\nimport torch\n');
    await user.click(within(panel).getByRole('button', { name: '套用「標註」' }));
    const list = await within(panel).findByRole('list', { name: '錯誤清單' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'labels.py 第 1 行 import 了平台沒有的套件「xgboost」', 'labels.py 第 2 行 import 了平台沒有的套件「torch」',
      'labels.py 缺少函式 build_labels(frame, config)']);
    expect(within(panel).getByText(/檔案不符合平台的流程框架/)).toBeInTheDocument();
    expect(lockedStages(row.id)).toEqual([]);
  });

  it('restores the platform program in the editor', async () => {
    seed();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視程式碼「資料清理與前處理」' }));
    const code = await within(panel).findByRole('textbox', { name: 'preprocess.py' });
    const original = (code as HTMLTextAreaElement).value;
    await user.clear(code);
    await user.click(within(panel).getByRole('button', { name: 'preprocess.py 還原成平台預設程式' }));
    expect(code).toHaveValue(original);
  });

  it('asks before switching back to the form; cancel keeps the lock, confirm restores the setting', async () => {
    const row = seed();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視程式碼「標註」' }));
    const config = await within(panel).findByRole('textbox', { name: 'labels.json' });
    await user.clear(config);
    await user.click(config);
    await user.paste('{"target": "diagnosis", "features": ["age"]}');
    await user.click(within(panel).getByRole('button', { name: '套用「標註」' }));
    await within(panel).findByText(/已套用「標註」/);
    expect(trainingMock().settings.find((s) => s.id === row.id)!.config.tabular!.features).toEqual(['age']);

    await user.click(within(panel).getByRole('button', { name: '改回用介面設定「標註」' }));
    let dialog = await screen.findByRole('dialog', { name: '改回用介面設定「標註」？' });
    expect(dialog).toHaveTextContent('匯入的檔案會從平台刪除，不能復原。需要保留請先下載。');
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['取消', '下載匯入檔', '刪除匯入檔並改回介面設定']);
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(lockedStages(row.id)).toEqual(['labels']);

    await user.click(within(panel).getByRole('button', { name: '改回用介面設定「標註」' }));
    dialog = await screen.findByRole('dialog', { name: '改回用介面設定「標註」？' });
    await user.click(within(dialog).getByRole('button', { name: '刪除匯入檔並改回介面設定' }));
    await within(panel).findByText('已改回用介面設定「標註」，匯入的檔案已刪除。');
    expect(lockedStages(row.id)).toEqual([]);
    expect(trainingMock().settings.find((s) => s.id === row.id)!.config.tabular!.features).toEqual(['age', 'bmi']);
  });

  it('a research assistant without Coding can see the status and switch back, but not view or import code', async () => {
    const row = seed();
    const api = createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:pi01', onUnauthorized: () => {} });
    const files = (await api.get<{ files: Record<string, string> }>(`/api/projects/1/training/settings/${row.id}/stages/train`)).files;
    await api.put(`/api/projects/1/training/settings/${row.id}/stages/train`, { files });
    const { panel } = await openFlow('糖尿病預測', 'ra01');
    expect(within(panel).getByText(/你沒有程式開發（Coding）權限/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /檢視程式碼/ })).toBeNull();
    for (const name of ['標註', '資料清理與前處理', '訓練']) {
      expect(within(panel).queryByRole('button', { name: `上傳階段檔「${name}」` })).toBeNull();
    }
    expect(within(panel).queryByRole('button', { name: '下載整個流程（專案包）' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '改回用介面設定「訓練」' })).toBeInTheDocument();
  });

  it('uploads a stage file; a file of another stage is rejected with the reason', async () => {
    const row = seed();
    const { user, panel } = await openFlow();
    const input = within(panel).getByLabelText('選擇階段檔（zip）');
    await user.click(within(panel).getByRole('button', { name: '上傳階段檔「標註」' }));
    await user.upload(input, makeFile('{"stage": "train"}', 'diabetes-train.zip', 'application/zip'));

    expect(await within(panel).findByText('這個檔案是「訓練」階段，請到「訓練」匯入')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '上傳階段檔「標註」' }));
    await user.upload(input, makeFile('{"stage": "labels"}', 'diabetes-labels.zip', 'application/zip'));
    await within(panel).findByText(/已套用「標註」/);
    expect(lockedStages(row.id)).toEqual(['labels']);
  });
});

describe('鎖定後的訓練設定', () => {
  async function lock(stage: 'labels' | 'train', id: number) {
    const api = createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:pi01', onUnauthorized: () => {} });
    const files = (await api.get<{ files: Record<string, string> }>(`/api/projects/1/training/settings/${id}/stages/${stage}`)).files;
    await api.put(`/api/projects/1/training/settings/${id}/stages/${stage}`, { files });
  }

  it('disables the fields of locked stages and still saves the other fields', async () => {
    const row = seed();
    await lock('train', row.id);
    const { user } = await renderApp('/training/settings', 'pi01');
    await user.click(await screen.findByRole('button', { name: '修改「糖尿病預測」' }));
    const form = await screen.findByRole('form', { name: '修改訓練設定「糖尿病預測」' });
    expect(within(form).getByTestId('stage-locks')).toHaveTextContent('「訓練」由匯入的檔案控制：train.json、train.py');
    expect(within(form).getByLabelText('隨機種子')).toBeDisabled();
    expect(within(form).getByLabelText('測試集（%）')).toBeDisabled();
    expect(within(form).getByLabelText('演算法')).toBeDisabled();
    expect(within(form).getByLabelText('訓練種類')).toBeDisabled();
    expect(within(form).getByLabelText('設定名稱')).toBeEnabled();
    await waitFor(() => expect(within(form).getByLabelText('資料集')).toBeEnabled());
    await user.clear(within(form).getByLabelText('設定名稱'));
    await user.type(within(form).getByLabelText('設定名稱'), '糖尿病預測 v2');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已儲存訓練設定「糖尿病預測 v2」的修改。');
    expect(trainingMock().settings.find((s) => s.id === row.id)!.config.seed).toBe(42);
  });

  it('locked labels disable the dataset fields and hide the button that applies the dataset settings', async () => {
    const row = seed();
    await lock('labels', row.id);
    const { user } = await renderApp('/training/settings', 'pi01');
    expect(await screen.findByTestId('locked-stages')).toHaveTextContent('匯入控制：標註');
    expect(screen.queryByRole('button', { name: /套用資料集設定/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '修改「糖尿病預測」' }));
    const form = await screen.findByRole('form', { name: '修改訓練設定「糖尿病預測」' });
    expect(within(form).getByLabelText('資料集')).toBeDisabled();
    expect(within(form).getByLabelText('Target 欄位')).toBeDisabled();
    expect(within(form).getByLabelText('隨機種子')).toBeEnabled();
  });

  it('the run list marks runs that used imported programs', async () => {
    const row = seed();
    await lock('train', row.id);
    const { user } = await renderApp('/training/settings', 'pi01');
    await user.click(await screen.findByRole('button', { name: '送出訓練「糖尿病預測」' }));
    await user.click(await screen.findByRole('link', { name: '訓練紀錄' }));
    expect(await screen.findByText('（使用匯入的程式：訓練）')).toBeInTheDocument();
  });
});
