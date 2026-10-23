// 網頁缺口（2026-10-12）：非 Admin 選帳號、部署顯示模型名稱、網頁上試呼叫部署、訓練紀錄分頁。
import { makeFile } from '../upload-env';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { createApiClient } from '../../src/api/client';
import { currentToken, pickInto } from '../../src/components/UserPicker';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import { parseRows, sampleRows } from '../../src/pages/deployment/TryCall';
import type { Model } from '../../src/pages/inference/api';
import { createTrainingApi, type TrainingRun } from '../../src/pages/training/api';
import { RUN_PAGE } from '../../src/pages/training/Runs';
import { renderApp } from '../render';

trainingMockOptions.stepMs = 0;
vi.setConfig({ testTimeout: 30_000 });

function client(username: string) {
  const token = async () => `test-token:${username}`;
  const api = createApiClient({ base: 'http://localhost', getToken: token, onUnauthorized: () => {} });
  return { api, training: createTrainingApi(api, 1, token, 'http://localhost') };
}

describe('選帳號（UserPicker）', () => {
  it('replaces only the account being typed', () => {
    expect(currentToken('md01, p')).toBe('p');
    expect(currentToken('md01, ')).toBe('');
    expect(pickInto('md01, p', 'pi01')).toBe('md01, pi01, ');
    expect(pickInto('', 'md01')).toBe('md01, ');
  });

  it('a non-admin with Training picks a colleague by typing the start of the account', async () => {
    const { user } = await renderApp('/models/101/share', 'ra01');
    const form = await screen.findByRole('form', { name: '分享給同事使用' });
    const input = within(form).getByLabelText('分享給（同事的帳號，以逗號分隔）');
    await user.type(input, 'md01, u');
    const list = await within(form).findByRole('list', { name: '符合的帳號' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['user01（不是本專案成員）', 'user02（不是本專案成員）']);
    await user.click(within(list).getByRole('button', { name: 'user02（不是本專案成員）' }));
    expect(input).toHaveValue('md01, user02, ');
    expect(input).toHaveFocus();
    await user.type(input, 'p');
    const again = await within(form).findByRole('list', { name: '符合的帳號' });
    expect(within(again).getByRole('button', { name: 'pi01' })).toBeInTheDocument();
  });

  it('the lookup API needs Training or Coding and returns only the account name', async () => {
    const lookup = (who: string) => client(who).api.get<unknown[]>('/api/projects/1/user-lookup?q=m');
    expect(await lookup('ca01')).toEqual([{ username: 'md01', member: true }]);
    await expect(lookup('md01')).rejects.toMatchObject({ status: 403 });
    await expect(lookup('vw01')).rejects.toMatchObject({ status: 403 });
  });

  it('the LLM service grants use the same picker', async () => {
    const { user } = await renderApp('/llm/services', 'ca01');
    const input = await screen.findByLabelText('授權帳號（以逗號分隔）');
    await user.type(input, 'v');
    await user.click(await screen.findByRole('button', { name: 'vw01' }));
    expect(input).toHaveValue('vw01, ');
  });
});

describe('部署：模型名稱與試呼叫', () => {
  const model = { id: 101, name: 'diagnosis-rf-run1', kind: 'tabular_classification', card: { features: ['age', 'bmi'] } } as unknown as Model;

  it('sample rows follow the model features and bad JSON is explained', () => {
    expect(JSON.parse(sampleRows(model))).toEqual({ rows: [{ age: null, bmi: null }] });
    expect(() => parseRows('{')).toThrow('輸入不是有效的 JSON');
    expect(() => parseRows('{"rows": []}')).toThrow('至少一筆');
    expect(parseRows('{"rows": [{"age": 50}]}')).toEqual({ rows: [{ age: 50 }] });
  });

  it('the deployment API carries the model name and kind', async () => {
    const { training } = client('pi01');
    const d = await training.deploy({ model_id: 101, title: '確診預測', allowed_users: ['md01'] });
    expect(d).toMatchObject({ model_name: 'diagnosis-rf-run1', model_kind: 'tabular_classification' });
    expect((await training.deployments())[0].model_name).toBe('diagnosis-rf-run1');
  });

  it('try-calls a deployment as the logged-in user: refused until the user is on the share list', async () => {
    const { training } = client('pi01');
    await training.deploy({ model_id: 101, title: '確診預測', allowed_users: ['md01'] });
    const { user } = await renderApp('/models/101/share', 'pi01');
    const form = await screen.findByRole('form', { name: '試呼叫' });
    expect(within(form).getByText(/你（pi01）不在「確診預測」的分享對象中/)).toBeInTheDocument();
    const body = within(form).getByLabelText('送出的 JSON');
    expect(JSON.parse((body as HTMLTextAreaElement).value)).toEqual({ rows: [{ age: null, bmi: null, glucose: null, sbp: null }] });
    await user.click(within(form).getByRole('button', { name: /^送出試呼叫/ }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('你沒有呼叫這個推論服務的授權');

    // 把自己加入分享對象後再呼叫
    const table = screen.getByRole('table', { name: '已分享的模型' });
    expect(within(table).getByRole('row', { name: /確診預測/ })).toHaveTextContent('diagnosis-rf-run1');
    await user.click(within(table).getByRole('button', { name: '修改分享對象「確診預測」' }));
    const access = screen.getByRole('form', { name: '修改分享對象' });
    await user.type(within(access).getByLabelText(/分享給/), ', pi01');
    await user.click(within(access).getByRole('button', { name: '儲存分享對象' }));
    await waitFor(() => expect(within(screen.getByRole('form', { name: '試呼叫' })).queryByText(/不在「確診預測」的分享對象中/)).toBeNull());
    const call = screen.getByRole('form', { name: '試呼叫' });
    const input = within(call).getByLabelText('送出的 JSON');
    await user.clear(input);
    await user.click(input);
    await user.paste('{"rows": [{"age": 51, "bmi": 24}, {"age": 70, "bmi": 30}]}');
    await user.click(within(call).getByRole('button', { name: /^送出試呼叫/ }));
    const reply = await within(call).findByLabelText('試呼叫的回應');
    expect(JSON.parse(reply.textContent!)).toMatchObject({ deployment: 'model-101', predictions: ['1', '0'] });
    expect(within(call).getByText(/^呼叫成功/)).toBeInTheDocument();
  });

  it('an image deployment is try-called with uploaded files', async () => {
    const { training } = client('pi01');
    await training.deploy({ model_id: 102, title: '影像分類', allowed_users: ['pi01'] });
    const { user } = await renderApp('/models/102/share', 'pi01');
    const form = await screen.findByRole('form', { name: '試呼叫' });
    await user.click(within(form).getByRole('button', { name: /^送出試呼叫/ }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('請選擇至少一個影像檔');
    await user.upload(within(form).getByLabelText(/影像檔/), [makeFile('x', 'IM0001.dcm'), makeFile('y', 'IM0002.dcm')]);
    await user.click(within(form).getByRole('button', { name: /^送出試呼叫/ }));
    const reply = JSON.parse((await within(form).findByLabelText('試呼叫的回應')).textContent!) as { results: { name: string }[] };
    expect(reply.results.map((r) => r.name)).toEqual(['IM0001.dcm', 'IM0002.dcm']);
  });
});

describe('訓練紀錄分頁', () => {
  function seedRuns(count: number) {
    const s = trainingMock();
    for (let i = 0; i < count; i += 1) {
      const id = s.nextRun++;
      s.runs.push({
        id, project_id: 1, setting_id: null, name: `訓練-${id}`, kind: 'tabular_classification', executor: 'fake', status: 'cancelled',
        message: '', seed: 1, config: { kind: 'tabular_classification', source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 1, hyperparameters: {} },
        dataset_version_id: id, job_id: null, parent_run_id: null, metrics: {}, artifacts: {}, created_by: i % 5 === 0 ? 'ra01' : 'pi01',
        created_at: '2026-10-01T00:00:00Z', started_at: null, finished_at: null, custom_source: false, model_id: null,
        ticks: 0, fail: false, changedMs: 0,
      } as TrainingRun & { ticks: number; fail: boolean; changedMs: number });
    }
  }

  it('the API pages newest first and filters my runs on the server', async () => {
    seedRuns(25);
    const { training } = client('pi01');
    const first = await training.runPage({ limit: 10, offset: 0, mine: false });
    expect(first.total).toBe(25);
    expect(first.items.map((r) => r.id)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    const mine = await training.runPage({ limit: 50, offset: 0, mine: true });
    expect(mine.total).toBe(20);
    expect(mine.items.every((r) => r.created_by === 'pi01')).toBe(true);
    expect((await training.runs()).map((r) => r.id)[0]).toBe(1);   // 不分頁的舊呼叫不變
  });

  it('the run list shows one page at a time with previous / next', async () => {
    seedRuns(RUN_PAGE + 25);
    const { user } = await renderApp('/training', 'pi01');
    const table = await screen.findByRole('table', { name: '訓練清單' });
    const ids = () => within(screen.getByRole('table', { name: '訓練清單' })).getAllByRole('link', { name: /^查看(進度|結果) #/ })
      .map((b) => Number(b.textContent!.replace(/\D/g, '')));
    await waitFor(() => expect(ids()).toHaveLength(RUN_PAGE));
    expect(table).toBeInTheDocument();
    expect(ids()[0]).toBe(45);
    expect(screen.getByTestId('runs-range')).toHaveTextContent(`共 45 筆，這一頁是第 1–${RUN_PAGE} 筆`);
    expect(within(screen.getByRole('navigation', { name: '訓練紀錄分頁' })).getByText('第 1 / 3 頁')).toBeInTheDocument();

    // 篩選建立者：只剩 pi01 送出的
    await user.type(screen.getByLabelText('建立者'), 'pi01');
    await waitFor(() => expect(screen.getByTestId('runs-range')).toHaveTextContent(`共 36 筆，這一頁是第 1–${RUN_PAGE} 筆`));
    expect(ids().every((id) => trainingMock().runs.find((r) => r.id === id)!.created_by === 'pi01')).toBe(true);
    const pager = screen.getByRole('navigation', { name: '訓練紀錄分頁' });
    expect(within(pager).getByRole('button', { name: '上一頁' })).toBeDisabled();
    await user.click(within(pager).getByRole('button', { name: '下一頁' }));
    await waitFor(() => expect(ids()).toHaveLength(16));
    expect(within(pager).getByText('第 2 / 2 頁')).toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: '下一頁' })).toBeDisabled();
  });
});
