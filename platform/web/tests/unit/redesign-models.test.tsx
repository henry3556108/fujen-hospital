// 介面改版：建模管理（訓練紀錄、建立訓練任務精靈、單次訓練、訓練設定）、模型部署與推論服務（清單與五個分頁）、大型語言模型（七個分頁、下載審核）。
// 直接掛各區的 routes（不經 App.tsx），只測這幾區自己的行為。
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider } from '../../src/auth/SessionContext';
import { TestAuthAdapter } from '../../src/auth/testAdapter';
import { server } from '../../src/mocks/server';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import { trainingRoutes } from '../../src/pages/training/routes';
import { modelRoutes } from '../../src/pages/models/routes';
import { llmRoutes, LlmApprovalsPanel } from '../../src/pages/llm/routes';
import { EMPTY_FILTER, filterRuns, fixLink, queuePositions } from '../../src/pages/training/Runs';
import { labelDatasetProblem, splitProblem, versionText } from '../../src/pages/training/NewTrainingPage';
import { matchSetting } from '../../src/pages/training/TrainingPage';
import { FEW_TESTS, keyMetrics, sameTestData, testCount } from '../../src/pages/models/keyMetrics';
import { ENTRY_NOTES, loadExample } from '../../src/pages/models/ModelsPage';
import type { TrainingRun } from '../../src/pages/training/api';

trainingMockOptions.stepMs = 0;

async function renderAt(path: string, username = 'ra01') {
  const auth = new TestAuthAdapter();
  await auth.login({ username });
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider auth={auth} apiBase="">
        <Routes>
          <Route path="/training/*">{trainingRoutes()}</Route>
          <Route path="/models/*">{modelRoutes()}</Route>
          <Route path="/llm/*">{llmRoutes()}</Route>
          <Route path="/admin/approvals" element={<LlmApprovalsPanel />} />
          <Route path="*" element={<p>其他頁面</p>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
  return { ...utils, user };
}

const run = (over: Partial<TrainingRun>): TrainingRun =>
  ({
    id: 1, project_id: 1, setting_id: 1, name: 'r', kind: 'tabular_classification', executor: 'template', status: 'succeeded', message: '',
    seed: 42, config: { kind: 'tabular_classification', source: { type: 'tabular', dataset_id: 3 }, split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 42, hyperparameters: {} },
    dataset_version_id: 1, job_id: null, parent_run_id: null, metrics: {}, artifacts: {}, created_by: 'ra01', created_at: '2026-10-20T10:00:00Z',
    started_at: null, finished_at: null, custom_source: false, model_id: null, ...over,
  }) as TrainingRun;

describe('建模管理：純函式', () => {
  it('queue positions follow submission order', () => {
    const pos = queuePositions([run({ id: 5, status: 'queued' }), run({ id: 2, status: 'queued' }), run({ id: 3, status: 'running' })]);
    expect([...pos]).toEqual([[2, 1], [5, 2]]);
  });

  it('filters by status, kind, creator and date', () => {
    const runs = [
      run({ id: 1, status: 'failed', created_by: 'ra01' }),
      run({ id: 2, status: 'held', kind: 'image_classification', created_by: 'pi01', created_at: '2026-10-22T10:00:00Z' }),
    ];
    expect(filterRuns(runs, { ...EMPTY_FILTER, status: 'queued' }).map((r) => r.id)).toEqual([2]);
    expect(filterRuns(runs, { ...EMPTY_FILTER, kind: 'tabular_classification' }).map((r) => r.id)).toEqual([1]);
    expect(filterRuns(runs, { ...EMPTY_FILTER, creator: 'PI' }).map((r) => r.id)).toEqual([2]);
    expect(filterRuns(runs, { ...EMPTY_FILTER, from: '2026-10-21' }).map((r) => r.id)).toEqual([2]);
  });

  it('fix link goes to the data that needs fixing', () => {
    expect(fixLink(run({})).to).toBe('/data/tabular/3/prepare');
    expect(fixLink(run({ config: { ...run({}).config, source: { type: 'dicom', studies: 'all', label_source: { provider: 'annotations' } } }, label_dataset: { id: 7, name: 'x', version: 2 } })).to).toBe('/labeling/datasets/7');
  });

  it('label dataset version text and checks before submitting', () => {
    const current = { annotations: 10, studies: 5, by_class: { a: 4, b: 6 }, by_source: {}, drafts_excluded: 2 };
    expect(versionText({ current, latest_version: null })).toBe('將以目前內容建立第 1 版');
    expect(versionText({ current, latest_version: { version: 2, created_at: '', created_by: '', annotations: 10, by_class: { b: 6, a: 4 } } })).toContain('沿用第 2 版');
    expect(versionText({ current, latest_version: { version: 2, created_at: '', created_by: '', annotations: 8, by_class: { a: 4 } } })).toBe('將以目前內容建立第 3 版');
    expect(labelDatasetProblem('image_classification', { current: { ...current, by_class: { a: 10 } } })).toContain('至少要有 2 個類別');
    expect(labelDatasetProblem('image_classification', { current })).toBeNull();
    expect(splitProblem({ kind: 'image_classification', validationMethod: 'holdout', train: '50', validation: '20', test: '20' })).toContain('100%');
    expect(splitProblem({ kind: 'image_classification', validationMethod: 'holdout', train: '70', validation: '30', test: '0' })).toContain('測試集');
  });

  it('settings search matches name, creator and task', () => {
    const s = { name: '胸部 CT', created_by: 'ra01', updated_by: 'ra01', kind: 'image_classification' as const };
    expect(matchSetting(s, 'ct')).toBe(true);
    expect(matchSetting(s, '影像分類')).toBe(true);
    expect(matchSetting(s, 'pi01')).toBe(false);
  });
});

describe('模型部署與推論服務：純函式', () => {
  it('key metrics follow the task (max 3) and fall back to existing metrics', () => {
    const binary = keyMetrics('tabular_classification', { test: { accuracy: 0.8, sensitivity: 0.7, specificity: 0.75, auc: 0.85 } });
    expect(binary.map((k) => k.label)).toEqual(['敏感度', '特異度', 'AUC（ROC 曲線下面積）']);
    expect(keyMetrics('tabular_regression', { test: { r2: 0.5, mae: 9.8, rmse: 12.5 } }).map((k) => k.name)).toEqual(['mae', 'rmse', 'r2']);
    expect(keyMetrics('image_classification', { test: { accuracy: 0.9 } }).map((k) => k.name)).toEqual(['accuracy']);
    const multi = keyMetrics('image_classification', { test: { accuracy: 0.9, recall_per_class: { a: 0.5, b: 1 } } }, ['a', 'b', 'c']);
    expect(multi.map((k) => k.text)).toEqual(['90%', 'a 50%、b 100%']);
  });

  it('test count, same test data and load examples', () => {
    expect(testCount(run({ test_count: 12 }))).toBe(12);
    expect(testCount(run({ metrics: { rows: { test: 20 } } }))).toBe(20);
    expect(FEW_TESTS).toBe(30);
    expect(sameTestData(run({ id: 1 }), run({ id: 2 }))).toBe(true);
    expect(sameTestData(run({ id: 1 }), run({ id: 2, seed: 7 }))).toBe(false);
    expect(loadExample({ format: 'pkl', filename: 'm.pkl', card: { features: ['age'] } })).toContain('joblib.load("m.pkl")');
    expect(loadExample({ format: 'h5', filename: 'm.h5', card: {} })).toContain('keras.models.load_model("m.h5")');
    expect(ENTRY_NOTES.deployment).toContain('模型部署');
  });
});

describe('建模管理：頁面', () => {
  it('empty training list offers creating a training; tabs show records and saved settings', async () => {
    await renderAt('/training');
    expect(await screen.findByTestId('runs-empty')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '建立訓練任務' })[0]).toHaveAttribute('href', '/training/new');
    const tabs = screen.getByRole('navigation', { name: '建模管理分頁' });
    expect(within(tabs).getByRole('link', { name: '訓練紀錄' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: '訓練設定' })).toBeInTheDocument();
  });

  it('wizard: purpose → data → submit saves the setting and opens the run page', async () => {
    const { user } = await renderAt('/training/new');
    await user.click(await screen.findByRole('radio', { name: /影像分類/ }));
    await user.click(screen.getByRole('button', { name: '下一步：確認資料' }));
    await user.click(await screen.findByRole('button', { name: '下一步：確認並送出' }));
    const form = await screen.findByRole('form', { name: '確認並送出' });
    expect(within(form).queryByLabelText('訓練種類')).toBeNull();
    await user.type(within(form).getByLabelText('Label（以逗號分隔）'), 'a, b');
    const name = within(form).getByLabelText('設定名稱');
    await user.clear(name);
    await user.type(name, '精靈分類');
    await user.click(within(form).getByRole('button', { name: '確認並送出訓練' }));
    expect(await screen.findByText(/訓練 #1（精靈分類）/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /訓練 #1：精靈分類/ })).toBeInTheDocument();
    expect(trainingMock().settings.map((s) => s.name)).toEqual(['精靈分類']);
    expect(trainingMock().runs).toHaveLength(1);
  }, 20_000);

  it('saved settings: apply opens the wizard, copy creates a copy', async () => {
    const first = await renderAt('/training/new');
    await first.user.click(await screen.findByRole('radio', { name: /影像分類/ }));
    await first.user.click(screen.getByRole('button', { name: '下一步：確認資料' }));
    await first.user.click(await screen.findByRole('button', { name: '下一步：確認並送出' }));
    const form = await screen.findByRole('form', { name: '確認並送出' });
    await first.user.type(within(form).getByLabelText('設定名稱'), 'A');
    await first.user.type(within(form).getByLabelText('Label（以逗號分隔）'), 'a, b');
    await first.user.click(within(form).getByRole('button', { name: '確認並送出訓練' }));
    await screen.findByText(/已送出訓練 #/);
    first.unmount();

    const { user } = await renderAt('/training/settings');
    const name = trainingMock().settings[0].name;
    expect(await screen.findByRole('link', { name: `套用「${name}」` })).toHaveAttribute('href', `/training/new?setting=${trainingMock().settings[0].id}`);
    await user.click(screen.getByRole('button', { name: `複製「${name}」` }));
    expect(await screen.findByText(`已複製為「${name}（複本）」。`)).toBeInTheDocument();
  }, 20_000);
});

describe('模型部署與推論服務：頁面', () => {
  it('list shows the entry note and a finished model opens with five tabs', async () => {
    // 先完成一次結構式以外的訓練
    const first = await renderAt('/training/new');
    await first.user.click(await screen.findByRole('radio', { name: /影像分類/ }));
    await first.user.click(screen.getByRole('button', { name: '下一步：確認資料' }));
    await first.user.click(await screen.findByRole('button', { name: '下一步：確認並送出' }));
    const form = await screen.findByRole('form', { name: '確認並送出' });
    await first.user.type(within(form).getByLabelText('設定名稱'), 'M');
    await first.user.type(within(form).getByLabelText('Label（以逗號分隔）'), 'a, b');
    await first.user.click(within(form).getByRole('button', { name: '確認並送出訓練' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'), { timeout: 10_000 });
    first.unmount();

    const runId = trainingMock().runs[0].id;
    await renderAt('/models?entry=deployment');
    expect(await screen.findByTestId('entry-note')).toHaveTextContent('模型部署');
    expect(await screen.findByRole('link', { name: /M-run/ })).toHaveAttribute('href', `/models/${runId}/result`);
    screen.getByRole('table', { name: '模型清單' });
  }, 30_000);

  it('model page result tab shows data version, test count and key metrics; download tab has the Python example', async () => {
    const first = await renderAt('/training/new');
    await first.user.click(await screen.findByRole('radio', { name: /影像分類/ }));
    await first.user.click(screen.getByRole('button', { name: '下一步：確認資料' }));
    await first.user.click(await screen.findByRole('button', { name: '下一步：確認並送出' }));
    const form = await screen.findByRole('form', { name: '確認並送出' });
    await first.user.type(within(form).getByLabelText('設定名稱'), 'R');
    await first.user.type(within(form).getByLabelText('Label（以逗號分隔）'), 'a, b');
    await first.user.click(within(form).getByRole('button', { name: '確認並送出訓練' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'), { timeout: 10_000 });
    first.unmount();

    const runId = trainingMock().runs[0].id;
    const second = await renderAt(`/models/${runId}/result`);
    const tabs = await screen.findByRole('navigation', { name: '模型分頁' });
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['訓練結果', '推論', '推論服務歷史紀錄', '模型部署']);
    expect(await screen.findByTestId('result-data')).toHaveTextContent('測試筆數');
    expect(screen.getByText('測試筆數少，結果僅供參考。')).toBeInTheDocument();
    expect(screen.getByTestId('key-metrics')).toHaveTextContent('敏感度');
    second.unmount();

    await renderAt(`/models/${runId}/download`);
    expect(await screen.findByLabelText('Python 載入範例')).toHaveTextContent('keras.models.load_model');
  }, 30_000);
});

describe('大型語言模型', () => {
  it('seven tabs in order with contract names; old playground address redirects to chat', async () => {
    const { user } = await renderAt('/llm/playground', 'ca01');
    const tabs = await screen.findByRole('navigation', { name: '大型語言模型分頁' });
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['LLM Playground', 'RAG 知識庫', 'Prompt Template', '內部服務', 'LLM 模型管理', 'LangGraph 工作流', 'Wiki 知識庫']);
    expect(await screen.findByRole('heading', { name: 'LLM Playground' })).toBeInTheDocument();
    // System Prompt 與文字產生設定參數在右側面板（設計稿 B14），按「設定」打開
    expect(screen.queryByTestId('chat-settings')).toBeNull();
    await user.click(screen.getByRole('button', { name: '設定' }));
    expect(await screen.findByTestId('chat-settings')).toHaveTextContent('System Prompt');
  });

  it('internal service shows a publish summary', async () => {
    await renderAt('/llm/services', 'ca01');
    expect(await screen.findByTestId('publish-summary')).toHaveTextContent('授權對象');
  });

  it('download approvals panel lists pending requests for Admin', async () => {
    server.use(
      http.get('*/api/admin/llm/downloads', () =>
        HttpResponse.json([{ id: 9, name: 'fake-llm-small', status: 'pending', user: 'ca01', reviewer: null, commit: null, hash: null, time: null, mode: 'online' }]),
      ),
    );
    await renderAt('/admin/approvals', 'admin01');
    const table = await screen.findByRole('table', { name: '待審核的下載申請' });
    expect(within(table).getByText('fake-llm-small')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '核准' })).toBeInTheDocument();
  });
});
