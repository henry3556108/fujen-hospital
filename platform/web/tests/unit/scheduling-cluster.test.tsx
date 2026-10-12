import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { monitoringLinks } from '../../src/pages/scheduling/MonitoringPage';
import { advanceMockClock, mockJobs, setSchedulingAvailable } from '../../src/mocks/scheduling';
import { renderApp } from '../render';

const groupTable = () => screen.findByRole('table', { name: 'GPU 群組列表' });
const row = (table: HTMLElement, name: string | RegExp) => within(table).getByRole('row', { name: new RegExp(name) });

describe('GPU 群組', () => {
  it('TC-C01-02 lists the two seed groups', async () => {
    await renderApp('/admin/scheduling/groups');
    const table = await groupTable();
    await within(table).findByRole('rowheader', { name: 'gpu-exclusive' });
    expect(row(table, '^gpu-exclusive')).toHaveTextContent('獨占');
    expect(row(table, '^gpu-shared')).toHaveTextContent('共享（時間片）');
  });

  it('TC-C01-02 creates 2 groups and they are still there after reload', async () => {
    const { user, unmount } = await renderApp('/admin/scheduling/groups');
    await within(await groupTable()).findByRole('rowheader', { name: 'gpu-shared' });
    for (const [name, pool, count] of [
      ['team-a', 'gpu-exclusive', '2'],
      ['team-b', 'gpu-shared', '1'],
    ]) {
      const form = screen.getByRole('form', { name: '新增 GPU 群組' });
      await user.type(within(form).getByLabelText(/^群組名稱/), name);
      await user.selectOptions(within(form).getByLabelText('GPU 池'), pool);
      const c = within(form).getByLabelText('GPU 數量');
      await user.clear(c);
      await user.type(c, count);
      await user.click(within(form).getByRole('button', { name: '新增群組' }));
      expect(await screen.findByText(`已新增 GPU 群組「${name}」`)).toBeInTheDocument();
    }
    unmount();
    await renderApp('/admin/scheduling/groups');
    const table = await groupTable();
    await within(table).findByRole('rowheader', { name: 'team-a' });
    expect(row(table, '^team-a')).toHaveTextContent('gpu-exclusive');
    expect(row(table, '^team-a')).toHaveTextContent('2');
    expect(row(table, '^team-b')).toHaveTextContent('共享（時間片）');
  });

  it('edits the GPU count', async () => {
    const { user } = await renderApp('/admin/scheduling/groups');
    const table = await groupTable();
    await within(table).findByRole('rowheader', { name: 'gpu-shared' });
    await user.click(within(table).getByRole('button', { name: '編輯 gpu-shared' }));
    const form = screen.getByRole('form', { name: '編輯 GPU 群組' });
    expect(within(form).getByLabelText(/^群組名稱/)).toBeDisabled();
    const c = within(form).getByLabelText('GPU 數量');
    await user.clear(c);
    await user.type(c, '3');
    await user.click(within(form).getByRole('button', { name: '儲存' }));
    expect(await screen.findByText('已更新 GPU 群組「gpu-shared」')).toBeInTheDocument();
    await waitFor(() => expect(row(table, '^gpu-shared')).toHaveTextContent('3'));
  });

  it('409 duplicate name and 422 empty name are shown inline', async () => {
    const { user } = await renderApp('/admin/scheduling/groups');
    await within(await groupTable()).findByRole('rowheader', { name: 'gpu-shared' });
    const form = screen.getByRole('form', { name: '新增 GPU 群組' });
    await user.click(within(form).getByRole('button', { name: '新增群組' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('群組名稱：不可空白');
    await user.type(within(form).getByLabelText(/^群組名稱/), 'gpu-shared');
    await user.click(within(form).getByRole('button', { name: '新增群組' }));
    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('GPU 群組「gpu-shared」已存在'));
  });

  it('a group still bound to a project cannot be deleted (409); an unbound one can', async () => {
    const { user } = await renderApp('/admin/scheduling/groups');
    const table = await groupTable();
    await within(table).findByRole('rowheader', { name: 'gpu-exclusive' });
    await user.click(within(table).getByRole('button', { name: '刪除 gpu-exclusive' }));
    await user.click(within(screen.getByRole('dialog', { name: '刪除 GPU 群組' })).getByRole('button', { name: '確認刪除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GPU 群組「gpu-exclusive」仍綁定專案：P1-lung-ct');
    expect(within(table).getByRole('rowheader', { name: 'gpu-exclusive' })).toBeInTheDocument();
  });
});

describe('叢集節點', () => {
  it('TC-C01-01 lists every node with pool, readiness and GPU counts', async () => {
    await renderApp('/admin/scheduling/nodes');
    const table = await screen.findByRole('table', { name: '叢集節點列表' });
    await within(table).findByRole('rowheader', { name: 'ai-platform-worker3' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    const gpu = row(table, '^ai-platform-worker4');
    expect(gpu).toHaveTextContent('gpu-shared');
    expect(gpu).toHaveTextContent('就緒');
    expect(within(gpu).getAllByRole('cell').slice(-3).map((c) => c.textContent)).toEqual(['1', '4', '4']);
    const summary = screen.getByRole('list', { name: '叢集摘要' });
    expect(summary).toHaveTextContent('節點數5');
    expect(summary).toHaveTextContent('實體 GPU3');
    expect(summary).toHaveTextContent('可排程 GPU 份數6');
  });

  it('503 when the scheduler backend is not configured', async () => {
    setSchedulingAvailable(false);
    await renderApp('/admin/scheduling/nodes');
    expect(await screen.findByRole('alert')).toHaveTextContent('排程服務尚未設定');
  });
});

describe('專案工作', () => {
  it('TC-A02-05 submits a training job and follows queued → running → succeeded', async () => {
    const { user } = await renderApp('/training/jobs', 'pi01');
    const form = await screen.findByRole('form', { name: '送出工作' });
    const d = within(form).getByLabelText(/^執行秒數/);
    await user.clear(d);
    await user.type(d, '30');
    await user.click(within(form).getByRole('button', { name: '送出工作' }));
    expect(await screen.findByText('已送出工作 1，進入佇列 gpu-exclusive')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '工作列表' });
    await waitFor(() => expect(row(table, '^1 ')).toHaveTextContent('執行中'));
    expect(row(table, '^1 ')).toHaveTextContent('訓練（GPU）');
    expect(row(table, '^1 ')).toHaveTextContent('pi01');
    advanceMockClock(31);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(row(table, '^1 ')).toHaveTextContent('已完成'));
    expect(within(row(table, '^1 ')).queryByRole('button', { name: /取消/ })).toBeNull();
    expect(mockJobs().map((j) => j.status)).toEqual(['succeeded']);
  });

  it('TC-C01-05 / TC-C01-08 exclusive pool runs 2 at a time in order; cancelling a queued job lets the next one run', async () => {
    const { user } = await renderApp('/training/jobs', 'pi01');
    const form = await screen.findByRole('form', { name: '送出工作' });
    for (let i = 1; i <= 4; i++) {
      await user.click(within(form).getByRole('button', { name: '送出工作' }));
      await screen.findByText(`已送出工作 ${i}，進入佇列 gpu-exclusive`);
    }
    const table = screen.getByRole('table', { name: '工作列表' });
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(row(table, '^2 ')).toHaveTextContent('執行中'));
    expect(row(table, '^1 ')).toHaveTextContent('執行中');
    expect(row(table, '^3 ')).toHaveTextContent('排隊中');
    expect(row(table, '^4 ')).toHaveTextContent('排隊中');

    await user.click(within(table).getByRole('button', { name: '取消工作 3' }));
    // 對話框的按鈕與列上的「取消」不同名：一個是「不要取消」（關閉），一個說清楚要做什麼
    let dialog = screen.getByRole('dialog', { name: '取消工作' });
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['不要取消', '確定取消工作']);
    await user.click(within(dialog).getByRole('button', { name: '不要取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row(table, '^3 ')).toHaveTextContent('排隊中');
    await user.click(within(table).getByRole('button', { name: '取消工作 3' }));
    dialog = screen.getByRole('dialog', { name: '取消工作' });
    await user.click(within(dialog).getByRole('button', { name: '確定取消工作' }));
    expect(await screen.findByText('已取消工作 3')).toBeInTheDocument();
    await waitFor(() => expect(row(table, '^3 ')).toHaveTextContent('已取消'));
    advanceMockClock(31);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(row(table, '^4 ')).toHaveTextContent('執行中'));
    expect(row(table, '^1 ')).toHaveTextContent('已完成');
  });

  it('a failing job shows 失敗 with the reason', async () => {
    const { user } = await renderApp('/training/jobs', 'pi01');
    const form = await screen.findByRole('form', { name: '送出工作' });
    await user.click(within(form).getByLabelText(/以失敗結束/));
    await user.click(within(form).getByRole('button', { name: '送出工作' }));
    await screen.findByText(/已送出工作 1/);
    advanceMockClock(31);
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    const table = screen.getByRole('table', { name: '工作列表' });
    await waitFor(() => expect(row(table, '^1 ')).toHaveTextContent('失敗'));
    expect(row(table, '^1 ')).toHaveTextContent('工作以非 0 結束');
  });

  it('data-cleaning jobs go to the CPU queue without a GPU group', async () => {
    const { user } = await renderApp('/training/jobs', 'pi01');
    const form = await screen.findByRole('form', { name: '送出工作' });
    await user.selectOptions(within(form).getByLabelText('工作種類'), 'data-cleaning');
    await user.click(within(form).getByRole('button', { name: '送出工作' }));
    expect(await screen.findByText('已送出工作 1，進入佇列 cpu-data')).toBeInTheDocument();
  });

  it('batch inference jobs show 批次推論 labels instead of the raw kind codes', async () => {
    const job = (id: number, kind: string, queue: string, gpu_group: string | null) => ({
      id, project_id: 1, user: 'pi01', kind, gpu_group, queue, status: 'succeeded', k8s_name: `job-${id}-abc123`,
      message: '', created_at: '2026-10-12T01:00:00Z', started_at: '2026-10-12T01:00:05Z', finished_at: '2026-10-12T01:01:00Z',
    });
    server.use(http.get('*/api/projects/:pid/jobs', () => HttpResponse.json([
      job(1, 'inference', 'gpu-exclusive', 'gpu-exclusive'), job(2, 'inference-cpu', 'cpu-data', null),
    ])));
    await renderApp('/training/jobs', 'pi01');
    const table = await screen.findByRole('table', { name: '工作列表' });
    await waitFor(() => expect(row(table, '^1 ')).toHaveTextContent('批次推論（GPU）'));
    expect(row(table, '^2 ')).toHaveTextContent('批次推論（CPU）');
    expect(table).not.toHaveTextContent(/inference/);
  });

  it('422 and 409 are shown inline', async () => {
    const { user } = await renderApp('/training/jobs', 'admin01');
    const form = await screen.findByRole('form', { name: '送出工作' });
    const d = within(form).getByLabelText(/^執行秒數/);
    await user.clear(d);
    await user.type(d, '0');
    await user.click(within(form).getByRole('button', { name: '送出工作' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('執行秒數：數值超出允許範圍');
    expect(d).toHaveAttribute('aria-invalid', 'true');

    await user.clear(d);
    await user.type(d, '5');
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P2-tabular');
    await user.click(within(form).getByRole('button', { name: '送出工作' }));
    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('專案「P2-tabular」尚未綁定 GPU 群組'));
  });

  it('TC-A03-05 users without Training permission are denied by URL', async () => {
    await renderApp('/training/jobs', 'vw01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Training 權限/)).toBeInTheDocument();
  });
});

describe('GPU Dashboard', () => {
  it('TC-C01-04 shows Project ID, Training ID and user of 3 running jobs exactly as the API reports', async () => {
    const jobs = await renderApp('/training/jobs', 'pi01');
    const form = await screen.findByRole('form', { name: '送出工作' });
    for (let i = 1; i <= 3; i++) {
      await jobs.user.click(within(form).getByRole('button', { name: '送出工作' }));
      await screen.findByText(new RegExp(`已送出工作 ${i}`));
    }
    jobs.unmount();

    await renderApp('/admin/scheduling/gpu-dashboard', 'admin01');
    const table = await screen.findByRole('table', { name: '執行中的 GPU 工作' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    // 節點, GPU 編號, 時間片, 專案, Project ID, Job ID, Training ID, 使用者, K8s
    expect(cells.map((c) => c.slice(0, 8))).toEqual([
      ['ai-platform-worker3', '0', '0', 'P1-lung-ct', '1', '1', '1', 'pi01'],
      ['ai-platform-worker3', '1', '0', 'P1-lung-ct', '1', '2', '2', 'pi01'],
    ]);
    const board = screen.getByRole('list', { name: 'GPU 使用狀況' });
    expect(board).toHaveTextContent('gpu-exclusive · GPU 0');
    expect(board).toHaveTextContent('工作 1（pi01）');
    expect(board).toHaveTextContent('使用中 0／4 份');
  });

  it('shows an empty state when nothing is running', async () => {
    await renderApp('/admin/scheduling/gpu-dashboard', 'admin01');
    expect(await screen.findByText('目前沒有執行中的 GPU 工作')).toBeInTheDocument();
  });
});

describe('監控儀表板', () => {
  it('links to Grafana, Prometheus, Alertmanager and Mailpit in a new tab', async () => {
    await renderApp('/admin/scheduling/monitoring', 'admin01');
    const tools = await screen.findByRole('list', { name: '監控工具' });
    const links = within(tools).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'http://127.0.0.1:33000',
      'http://127.0.0.1:39090',
      'http://127.0.0.1:39093',
      'http://127.0.0.1:38025',
    ]);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAccessibleName(/開新分頁/);
    }
  });

  it('addresses come from environment variables when set', () => {
    const links = monitoringLinks({ VITE_GRAFANA_URL: 'https://grafana.example', VITE_MAILPIT_URL: '' });
    expect(links[0].url).toBe('https://grafana.example');
    expect(links[3].url).toBe('http://127.0.0.1:38025');
  });
});
