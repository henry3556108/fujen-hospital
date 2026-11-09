// 後台佇列順序、暫存與恢復排隊、另存為訓練設定。
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { createApiClient } from '../../src/api/client';
import { advanceMockClock, mockJobs } from '../../src/mocks/scheduling';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import { stepsOf } from '../../src/pages/training/RunSteps';
import type { TrainingConfig } from '../../src/pages/training/api';
import { renderApp } from '../render';

trainingMockOptions.stepMs = 0;
vi.setConfig({ testTimeout: 30_000 });

const row = (table: HTMLElement, name: string | RegExp) => within(table).getByRole('row', { name: new RegExp(name) });

/** 直接以 API 送出 n 件訓練工作（不依賴工作頁的表單） */
async function submitJobs(n: number, username = 'pi01') {
  const api = createApiClient({ base: 'http://localhost', getToken: async () => `test-token:${username}`, onUnauthorized: () => {} });
  for (let i = 0; i < n; i++) await api.post('/api/projects/1/jobs', { kind: 'training', duration_seconds: 30 });
}

const status = (id: number) => mockJobs().find((j) => j.id === id)?.status;

describe('專案工作：暫存與恢復排隊', () => {
  it('a queued job can be held and resumed; running jobs have no 暫存 button', async () => {
    await submitJobs(3);
    const { user } = await renderApp('/admin/compute/jobs', 'admin01');
    const table = await screen.findByRole('table', { name: '工作列表' });
    await waitFor(() => expect(row(table, '^3 ')).toHaveTextContent('等待中'));
    expect(within(row(table, '^1 ')).queryByRole('button', { name: /暫存/ })).toBeNull();

    await user.click(within(table).getByRole('button', { name: '暫存工作 3' }));
    expect(await screen.findByText(/已暫存工作 3/)).toBeInTheDocument();
    await waitFor(() => expect(row(table, '^3 ')).toHaveTextContent('已暫存'));
    expect(row(table, '^3 ')).toHaveTextContent('由 admin01 暫存');
    // 暫存中卡空出來也不會開始
    advanceMockClock(31);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(row(table, '^1 ')).toHaveTextContent('已完成'));
    expect(status(3)).toBe('held');

    await user.click(within(table).getByRole('button', { name: '恢復排隊工作 3' }));
    expect(await screen.findByText(/工作 3 已恢復排隊/)).toBeInTheDocument();
    await waitFor(() => expect(row(table, '^3 ')).toHaveTextContent('執行中'));
  });

  it('a held job can be cancelled', async () => {
    await submitJobs(3);
    const { user } = await renderApp('/admin/compute/jobs', 'admin01');
    const table = await screen.findByRole('table', { name: '工作列表' });
    await user.click(await within(table).findByRole('button', { name: '暫存工作 3' }));
    await waitFor(() => expect(row(table, '^3 ')).toHaveTextContent('已暫存'));
    await user.click(within(table).getByRole('button', { name: '取消工作 3' }));
    await user.click(within(screen.getByRole('dialog', { name: '取消工作' })).getByRole('button', { name: '確定取消工作' }));
    await waitFor(() => expect(row(table, '^3 ')).toHaveTextContent('已取消'));
  });
});

describe('後台：佇列順序', () => {
  it('moves a waiting job, applies the order and the jobs start in the new order', async () => {
    await submitJobs(5);
    const { user } = await renderApp('/admin/compute/queues', 'admin01');
    expect(await screen.findByRole('link', { name: '佇列排程' })).toHaveAttribute('aria-current', 'page');
    const table = await screen.findByRole('table', { name: '佇列 gpu-exclusive' });
    expect(row(table, '執行中 1 ')).toHaveTextContent('不可移動');
    expect(within(row(table, '執行中 1 ')).queryByRole('button')).toBeNull();
    const order = () => within(table).getAllByRole('row').slice(1).map((r) => r.querySelector('th')?.textContent);
    expect(order()).toEqual(['1', '2', '3', '4', '5']);
    expect(row(table, '^第 1 位 3 ')).toHaveTextContent('P1-lung-ct');

    const apply = screen.getByRole('button', { name: '套用 gpu-exclusive 的順序' });
    expect(apply).toBeDisabled();
    expect(within(table).getByRole('button', { name: '上移工作 3' })).toBeDisabled();
    await user.click(within(table).getByRole('button', { name: '下移工作 3' }));
    expect(order()).toEqual(['1', '2', '4', '3', '5']);
    expect(screen.getByText('順序已調整，尚未套用。')).toBeInTheDocument();
    await user.click(apply);
    expect(await screen.findByText('已套用 gpu-exclusive 的順序：4、3、5')).toBeInTheDocument();
    await waitFor(() => expect(order()).toEqual(['1', '2', '4', '3', '5']));

    advanceMockClock(31);
    expect([status(4), status(3), status(5)]).toEqual(['running', 'running', 'queued']);
  });

  it('holds a waiting job from the admin page and resumes it at the end', async () => {
    await submitJobs(5);
    const { user } = await renderApp('/admin/compute/queues', 'admin01');
    const table = await screen.findByRole('table', { name: '佇列 gpu-exclusive' });
    await within(table).findByRole('button', { name: '暫存工作 3' });
    await user.click(within(table).getByRole('button', { name: '暫存工作 3' }));
    expect(await screen.findByText('已暫存工作 3')).toBeInTheDocument();
    await waitFor(() => expect(row(table, '暫存（admin01')).toHaveTextContent('已暫存'));
    expect(row(table, '^第 1 位 4 ')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: '恢復排隊工作 3' }));
    expect(await screen.findByText('工作 3 已恢復排隊（排在佇列最後）')).toBeInTheDocument();
    await waitFor(() => expect(row(table, '^第 3 位 3 ')).toBeInTheDocument());
  });

  it('shows the 409 when the waiting jobs changed since the page was loaded', async () => {
    await submitJobs(4);
    const { user } = await renderApp('/admin/compute/queues', 'admin01');
    const table = await screen.findByRole('table', { name: '佇列 gpu-exclusive' });
    await within(table).findByRole('button', { name: '下移工作 3' });
    await submitJobs(1);
    await user.click(within(table).getByRole('button', { name: '下移工作 3' }));
    await user.click(screen.getByRole('button', { name: '套用 gpu-exclusive 的順序' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('請重新整理後再調整');
    // 失敗後重新載入：新送出的工作也出現了
    await waitFor(() => expect(row(table, '^第 3 位 5 ')).toBeInTheDocument());
  });

  it('non-admin users cannot open the page', async () => {
    await renderApp('/admin/compute/queues', 'pi01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });
});

function tabularConfig(): TrainingConfig {
  return {
    version: 1, kind: 'tabular_classification', source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 },
    seed: 1, tabular: { target: 'diagnosis', features: ['age', 'bmi'], steps: [], algorithm: 'random_forest' }, hyperparameters: {},
  };
}

describe('訓練：暫存、恢復排隊、另存為訓練設定', () => {
  it('step bar shows 已暫存 in place of 等待中', () => {
    expect(stepsOf('held').map((s) => `${s.label}:${s.state}`)).toEqual(['已送出:done', '已暫存:current', '訓練中:todo', '完成:todo']);
  });

  it('holds a queued run, resumes it, and saves its configuration as a new setting', async () => {
    const s = trainingMock();
    s.settings.push({ id: s.nextSetting++, project_id: 1, name: 'cls', kind: 'tabular_classification', config: tabularConfig(),
      created_by: 'pi01', updated_by: 'pi01', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
    const { user } = await renderApp('/training/settings', 'pi01');
    await user.click(await screen.findByRole('button', { name: '送出訓練「cls」' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('等待中'));

    await user.click(screen.getByRole('button', { name: '暫存' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已暫存'));
    expect(screen.getByRole('button', { name: '取消訓練' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '依原版本重跑' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '恢復排隊' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).not.toHaveTextContent('已暫存'));
    expect(trainingMock().runs[0].status).not.toBe('held');

    await user.click(screen.getByRole('button', { name: '另存設定' }));
    const form = screen.getByRole('form', { name: '把訓練 #1 的設定另存為訓練設定' });
    const name = within(form).getByLabelText('新設定名稱');
    expect(name).toHaveValue('cls（訓練 #1）');
    await user.clear(name);
    await user.type(name, 'cls 備份');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByText(/已另存為訓練設定「cls 備份」/)).toBeInTheDocument();
    const copy = trainingMock().settings.find((x) => x.name === 'cls 備份');
    expect(copy?.config.tabular).toEqual(tabularConfig().tabular);
  });
});
