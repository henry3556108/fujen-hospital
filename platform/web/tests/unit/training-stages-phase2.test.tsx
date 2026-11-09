// 各階段處理程式碼（錄製巨集）第二階段：資料匯入與部署兩個階段（只有設定檔，Training 權限即可）、
// 部署頁的鎖定標示、匯入整個流程（專案包）的檢查、資料對應與匯入。
import '../upload-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { createApiClient } from '../../src/api/client';
import { normalise, trainingMock, trainingMockOptions } from '../../src/mocks/training';
import { lockedStages } from '../../src/mocks/trainingStages';
import type { TrainingConfig } from '../../src/pages/training/api';
import { keepLocked } from '../../src/pages/training/stages';
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
const SHA = 'ab'.repeat(32);

function seed(name = '糖尿病預測', config: TrainingConfig = TABULAR) {
  const s = trainingMock();
  const row = { id: s.nextSetting++, project_id: 1, name, kind: config.kind, config: normalise(JSON.parse(JSON.stringify(config))),
    created_by: 'pi01', updated_by: 'pi01', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  s.settings.push(row);
  return row;
}

/** 本專案訓練出的模型（部署階段用 sha256 指定） */
function seedModel() {
  const s = trainingMock();
  s.models.push({ id: 1000 + s.nextModel++, run_id: 9, project_id: 1, name: '糖尿病預測-run9', kind: 'tabular_classification', format: 'pkl', sha256: SHA,
    filename: 'm.pkl', created_by: 'pi01', created_at: '2026-10-01T00:00:00Z', card: {} } as never);
}

const client = (user = 'pi01') =>
  createApiClient({ base: 'http://localhost', getToken: async () => `test-token:${user}`, onUnauthorized: () => {} });

async function openFlow(name = '糖尿病預測', username = 'pi01') {
  const app = await renderApp('/training/settings', username);
  if (username !== 'pi01') await app.user.click(await screen.findByRole('checkbox', { name: '只看我建立的' }));
  await app.user.click(await screen.findByRole('link', { name: `各階段處理程式碼「${name}」` }));
  const panel = await screen.findByRole('region', { name: `各階段處理程式碼「${name}」` });
  await within(panel).findByRole('table', { name: '流程階段' });
  return { ...app, panel };
}

async function replaceText(user: Awaited<ReturnType<typeof renderApp>>['user'], box: HTMLElement, text: string) {
  await user.clear(box);
  await user.click(box);
  await user.paste(text);
}

const deployJson = (users: string[] = ['pi01']) =>
  JSON.stringify({ model: { sha256: SHA }, deployment: { name: 'diabetes-svc', title: '糖尿病預測服務', allowed_users: users } });

describe('資料匯入與部署階段', () => {
  it('keeps the data source of a locked import stage when the form is saved', () => {
    const changed: TrainingConfig = { ...TABULAR, source: { type: 'tabular', dataset_id: 9 }, seed: 1 };
    const out = keepLocked(changed, TABULAR, ['import']);
    expect(out.source).toEqual({ type: 'tabular', dataset_id: 2 });
    expect(out.seed).toBe(1);
  });

  it('lists five stages; data import and deploy only have settings files', async () => {
    seed();
    const { panel } = await openFlow();
    const rows = within(within(panel).getByRole('table', { name: '流程階段' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['資料匯入', '標註', '資料清理與前處理', '訓練', '部署']);
    expect(within(panel).getByRole('button', { name: '檢視設定檔「資料匯入」' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '檢視設定檔「部署」' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '檢視程式碼「訓練」' })).toBeInTheDocument();
  });

  it('a research assistant without Coding applies the data import stage; the form then disables the dataset', async () => {
    const row = seed();
    const { user, panel } = await openFlow('糖尿病預測', 'ra01');
    expect(within(panel).queryByRole('button', { name: /檢視程式碼/ })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: '檢視設定檔「資料匯入」' }));
    const box = await within(panel).findByRole('textbox', { name: 'import.json' });
    expect(JSON.parse((box as HTMLTextAreaElement).value)).toEqual({ type: 'tabular', dataset_id: 2 });
    expect(within(panel).getByRole('textbox', { name: 'schema.json' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /還原成平台預設程式/ })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: '套用「資料匯入」' }));
    await within(panel).findByText(/已套用「資料匯入」：這個階段改由匯入的內容控制，訓練設定表單上資料來源已停用/);
    expect(lockedStages(row.id)).toEqual(['import']);

    await user.click(within(panel).getByRole('button', { name: '關閉各階段處理程式碼' }));
    await user.click(screen.getByRole('link', { name: '訓練設定' }));
    await user.click(await screen.findByRole('checkbox', { name: '只看我建立的' }));
    await user.click(await screen.findByRole('button', { name: '修改「糖尿病預測」' }));
    const form = await screen.findByRole('form', { name: '修改訓練設定「糖尿病預測」' });
    expect(within(form).getByTestId('stage-locks')).toHaveTextContent('「資料匯入」由匯入的檔案控制：import.json、schema.json');
    expect(within(form).getByLabelText('資料集')).toBeDisabled();
    expect(within(form).getByLabelText('隨機種子')).toBeEnabled();
  });

  it('a wrong data import file lists the problem and keeps the setting', async () => {
    const row = seed();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視設定檔「資料匯入」' }));
    await replaceText(user, await within(panel).findByRole('textbox', { name: 'import.json' }), '{"type": "dicom", "studies": "all"}');
    await user.click(within(panel).getByRole('button', { name: '套用「資料匯入」' }));
    expect(await within(panel).findByText('import.json：資料來源種類必須是「tabular」')).toBeInTheDocument();
    expect(lockedStages(row.id)).toEqual([]);
  });

  it('deploys from deploy.json and locks the deployment; unlocking keeps the new deployment', async () => {
    const row = seed();
    seedModel();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視設定檔「部署」' }));
    const box = await within(panel).findByRole('textbox', { name: 'deploy.json' });
    expect(JSON.parse((box as HTMLTextAreaElement).value).deployment.title).toBe('糖尿病預測');
    await replaceText(user, box, deployJson(['pi01', 'md01']));
    await user.click(within(panel).getByRole('button', { name: '套用「部署」' }));
    await within(panel).findByText('已套用「部署」：服務已依 deploy.json 建立或更新，部署頁上這個服務的授權帳號改由匯入檔控制。');
    const dep = trainingMock().deployments.find((d) => d.name === 'diabetes-svc')!;
    expect(dep).toMatchObject({ title: '糖尿病預測服務', allowed_users: ['pi01', 'md01'] });
    expect(dep.stage_lock?.setting).toEqual({ id: row.id, name: '糖尿病預測' });

    await user.click(within(panel).getByRole('button', { name: '改回用介面設定「部署」' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('由匯入建立的部署會保留');
    await user.click(within(dialog).getByRole('button', { name: '刪除匯入檔並改回介面設定' }));
    await within(panel).findByText('已改回用介面設定「部署」，匯入的檔案已刪除。');
    expect(trainingMock().deployments.find((d) => d.name === 'diabetes-svc')!.stage_lock).toBeNull();
  });

  it('a deploy.json with an unknown model or a bad name lists both problems', async () => {
    seed();
    const { user, panel } = await openFlow();
    await user.click(within(panel).getByRole('button', { name: '檢視設定檔「部署」' }));
    await replaceText(user, await within(panel).findByRole('textbox', { name: 'deploy.json' }),
      JSON.stringify({ model: { sha256: 'cd'.repeat(32) }, deployment: { name: 'Bad Name' } }));
    await user.click(within(panel).getByRole('button', { name: '套用「部署」' }));
    const list = await within(panel).findByRole('list', { name: '錯誤清單' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'deploy.json：本專案沒有 sha256 為 cdcdcdcdcdcd 的模型，請先匯入或重新訓練',
      'deploy.json：服務名稱（deployment.name）只能用小寫英數字與連字號，開頭結尾必須是英數字，最多 63 字',
    ]);
  });

  it('the deployment page marks a deployment controlled by deploy.json and does not allow editing who can use it', async () => {
    const row = seed();
    seedModel();
    await client().put(`/api/projects/1/training/settings/${row.id}/stages/deploy`, { files: { 'deploy.json': deployJson() } });
    await renderApp('/models/9/share', 'pi01');
    const table = await screen.findByRole('table', { name: '已部署的模型' });
    const tr = within(table).getByRole('row', { name: /糖尿病預測服務/ });
    expect(within(tr).getByTestId('deployment-lock')).toHaveTextContent('由 deploy.json 控制（pi01，');
    expect(within(tr).getByTestId('deployment-lock')).toHaveTextContent('訓練設定「糖尿病預測」');
    expect(within(tr).getByRole('button', { name: '修改授權帳號「糖尿病預測服務」' })).toBeDisabled();
    const err = await client().put('/api/projects/1/deployments/' + trainingMock().deployments.at(-1)!.id + '/access', { allowed_users: [] })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/由匯入的 deploy\.json 控制/);
  });
});

describe('匯入整個流程（專案包）', () => {
  const pkg = (spec: Record<string, unknown>) => makeFile(JSON.stringify({ package: spec }), 'flow.zip', 'application/zip');

  async function openImport(username = 'pi01') {
    const app = await renderApp('/training/code', username);
    await app.user.click(await screen.findByRole('button', { name: '匯入專案包' }));
    const region = await screen.findByRole('region', { name: '匯入整個流程（專案包）' });
    return { ...app, region };
  }

  it('checks a package with its own data, shows what will happen and imports it as a new setting', async () => {
    seed();
    const { user, region } = await openImport();
    await user.upload(within(region).getByLabelText('專案包（zip）'), pkg({ name: '糖尿病預測', locked: ['preprocess'], data: true, rows: 80 }));
    await user.click(within(region).getByRole('button', { name: '檢查專案包' }));
    const dl = await within(region).findByLabelText('專案包內容');
    expect(dl).toHaveTextContent('糖尿病預測');
    expect(dl).toHaveTextContent('資料清理與前處理');
    expect(within(region).getByTestId('package-mapping')).toHaveTextContent('會用專案包內附的資料（80 列）建立一個新的資料集。');
    await user.click(within(region).getByRole('button', { name: '匯入「糖尿病預測」' }));
    expect(await screen.findByText(/^已匯入專案包，建立訓練設定「糖尿病預測（匯入 1）」。已用專案包內附的資料建立資料集「糖尿病預測（專案包資料）」。由匯入檔控制的階段：資料清理與前處理。可以送出訓練。$/))
      .toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '匯入整個流程（專案包）' })).toBeNull();
    const created = trainingMock().settings.find((s) => s.name === '糖尿病預測（匯入 1）')!;
    expect(lockedStages(created.id)).toEqual(['preprocess']);
  });

  it('asks for a dataset when the package has no data and nothing matches, then imports with the chosen one', async () => {
    const { user, region } = await openImport();
    await user.upload(within(region).getByLabelText('專案包（zip）'), pkg({ name: '肺部預測', deploy: true }));
    await user.click(within(region).getByRole('button', { name: '檢查專案包' }));
    const select = await within(region).findByLabelText('要使用的資料集');
    expect(within(region).getByText(/部署階段沒有匯入/)).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '匯入「肺部預測」' })).toBeDisabled();
    expect(within(region).getByRole('button', { name: '用這個資料重新檢查' })).toBeDisabled();
    await user.selectOptions(select, within(select).getByRole('option', { name: /lung-clinical/ }));
    await user.click(within(region).getByRole('button', { name: '用這個資料重新檢查' }));
    await waitFor(() => expect(within(region).getByTestId('package-mapping')).toHaveTextContent('會使用你選的資料集「lung-clinical」。'));
    await user.click(within(region).getByRole('button', { name: '匯入「肺部預測」' }));
    await screen.findByText(/^已匯入專案包，建立訓練設定「肺部預測」。會使用你選的資料集「lung-clinical」。/);
    const created = trainingMock().settings.find((s) => s.name === '肺部預測')!;
    expect(created.config.source).toEqual({ type: 'tabular', dataset_id: 2 });
  });

  it('lists every problem of a package that does not fit and does not import it', async () => {
    const before = trainingMock().settings.length;
    const { user, region } = await openImport();
    await user.upload(within(region).getByLabelText('專案包（zip）'),
      pkg({ name: '壞掉的', data: true, errors: ['preprocess/preprocess.py 第 3 行 import 了平台沒有的套件「requests」', 'flow.json：sha256 與檔案內容不符'] }));
    await user.click(within(region).getByRole('button', { name: '檢查專案包' }));
    const list = await within(region).findByRole('list', { name: '錯誤清單' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(region).getByRole('button', { name: '匯入「壞掉的」' })).toBeDisabled();
    expect(trainingMock().settings).toHaveLength(before);
  });

  it('a file that is not a package is rejected with the reason', async () => {
    const { user, region } = await openImport();
    await user.upload(within(region).getByLabelText('專案包（zip）'), makeFile('not a zip', 'notes.zip', 'application/zip'));
    await user.click(within(region).getByRole('button', { name: '檢查專案包' }));
    expect(await within(region).findByText('檔案不是 zip，或缺少 flow.json（不是平台匯出的專案包）')).toBeInTheDocument();
  });

  it('an image package asks which studies to use', async () => {
    const { user, region } = await openImport();
    await user.upload(within(region).getByLabelText('專案包（zip）'), pkg({ name: '胸腔 X 光', kind: 'image_classification' }));
    await user.click(within(region).getByRole('button', { name: '檢查專案包' }));
    const range = await within(region).findByRole('radiogroup', { name: '要使用的影像範圍' });
    expect(within(range).getByRole('radio', { name: /本專案全部影像（3 個）/ })).toBeChecked();
    expect(within(region).getByRole('button', { name: '匯入「胸腔 X 光」' })).toBeDisabled();
    await user.click(within(region).getByRole('button', { name: '用這個資料重新檢查' }));
    await waitFor(() => expect(within(region).getByTestId('package-mapping')).toHaveTextContent('影像範圍：本專案全部影像。'));
    expect(within(region).getByRole('button', { name: '匯入「胸腔 X 光」' })).toBeEnabled();
    // 重新檢查後選項會收起來，匯入時仍要送出檢查時選的範圍（平台匯入會用同樣的選擇再檢查一次）
    await user.click(within(region).getByRole('button', { name: '匯入「胸腔 X 光」' }));
    await screen.findByText(/^已匯入專案包，建立訓練設定「胸腔 X 光」/);
    const created = trainingMock().settings.find((s) => s.name === '胸腔 X 光')!;
    expect(created.config.source).toMatchObject({ type: 'dicom', studies: 'all' });
  });

  it('an image package imports with the studies chosen when it was checked', async () => {
    const { user, region } = await openImport();
    await user.upload(within(region).getByLabelText('專案包（zip）'), pkg({ name: '腦部 MRI', kind: 'image_classification' }));
    await user.click(within(region).getByRole('button', { name: '檢查專案包' }));
    const range = await within(region).findByRole('radiogroup', { name: '要使用的影像範圍' });
    await user.click(within(range).getByRole('radio', { name: '部分影像' }));
    await user.type(within(region).getByLabelText('研究 UID（每行一個）'), '1.2.3{enter}1.2.4');
    await user.click(within(region).getByRole('button', { name: '用這個資料重新檢查' }));
    await waitFor(() => expect(within(region).getByTestId('package-mapping')).toHaveTextContent('影像範圍：2 個研究。'));
    await user.click(within(region).getByRole('button', { name: '匯入「腦部 MRI」' }));
    await screen.findByText(/^已匯入專案包，建立訓練設定「腦部 MRI」/);
    const created = trainingMock().settings.find((s) => s.name === '腦部 MRI')!;
    expect(created.config.source).toMatchObject({ type: 'dicom', studies: ['1.2.3', '1.2.4'] });
  });

  it('is not offered to members without Coding', async () => {
    seed();
    await renderApp('/training/settings', 'ra01');
    await screen.findByRole('button', { name: '新增訓練設定' });
    expect(screen.queryByRole('button', { name: '匯入專案包' })).toBeNull();
  });
});
