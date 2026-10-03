// 建模端使用性（2026-10-03 B 組與使用性測試回饋）：從資料集建立訓練、超參數說明與進階收合、K 折、
// 步驟條、排序與展開、指標白話與圖表、報表、失敗訊息、設定同步、部署此模型、試用預測。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import type { TrainingConfig, TrainingKind, TrainingRun } from '../../src/pages/training/api';
import { splitFailure, warnings } from '../../src/pages/training/metrics';
import { suggestKind } from '../../src/pages/training/settingForm';
import { stepsOf } from '../../src/pages/training/RunSteps';
import { createApiClient } from '../../src/api/client';
import { renderApp } from '../render';

/** 直接以 API 存資料集的 Target／Feature（不依賴資料集頁的版面，那一頁由 A 組改版）。 */
async function saveTargetFeature(target: string, features: string[], steps: unknown[] = []) {
  const api = createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:pi01', onUnauthorized: () => {} });
  await api.put('/api/projects/1/tabular/datasets/2/target-feature', { target, features, steps });
}

trainingMockOptions.stepMs = 0;
// 整套平行執行時頁面載入較慢
vi.setConfig({ testTimeout: 30_000 });

const saved: string[] = [];
beforeEach(() => {
  saved.length = 0;
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
});
afterEach(() => vi.restoreAllMocks());

function tabularConfig(kind: TrainingKind, extra: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    version: 1, kind, source: { type: 'tabular', dataset_id: 2 }, split: { train: 0.6, validation: 0.2, test: 0.2 }, seed: 1,
    tabular: { target: kind === 'tabular_regression' ? 'sbp' : 'diagnosis', features: ['age', 'bmi'], steps: [], algorithm: 'random_forest' },
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

describe('B1 從資料集建立訓練', () => {
  it('the dataset page links to a prefilled training form with the kind chosen from the target', async () => {
    await saveTargetFeature('diagnosis', ['age', 'sex', 'smoker']);   // 數字編碼的 0／1 → 分類
    const first = await renderApp('/data/tabular/2', 'pi01');
    const link = await screen.findByRole('link', { name: '用這份資料建立訓練' }, { timeout: 10_000 });
    expect(link).toHaveAttribute('href', '/training?dataset=2');
    await first.user.click(link);

    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    expect(screen.getByText(/已帶入資料集「lung-clinical」的 Target（diagnosis）、3 個 Feature/)).toBeInTheDocument();
    expect(screen.getByText(/預選「結構式分類」/)).toBeInTheDocument();
    expect(within(form).getByLabelText('訓練種類')).toHaveValue('tabular_classification');
    expect(within(form).getByLabelText('設定名稱')).toHaveValue('lung-clinical 訓練');
    await waitFor(() => expect(within(form).getByLabelText('要預測的結果（Target）')).toHaveValue('diagnosis'));
    const features = within(form).getByRole('group', { name: '用來預測的資料（Feature）' });
    expect(within(features).getByRole('checkbox', { name: 'sex' })).toBeChecked();
    expect(within(form).getByTestId('text-features')).toHaveTextContent('「sex、smoker」是文字或類別欄位，訓練時會自動轉成 0／1 欄位');
    await first.user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已新增訓練設定「lung-clinical 訓練」。');
    expect(trainingMock().settings[0].config).toMatchObject({ kind: 'tabular_classification', source: { dataset_id: 2 },
      tabular: { target: 'diagnosis', features: ['age', 'sex', 'smoker'] } });
  });

  it('users without Training do not see the link', async () => {
    await renderApp('/data/tabular/2', 'md01');
    await screen.findByRole('heading', { name: /資料集：/ }, { timeout: 10_000 });
    expect(screen.queryByRole('link', { name: '用這份資料建立訓練' })).toBeNull();
  });

  it('numeric targets with many values suggest regression', () => {
    expect(suggestKind('numeric', 80)).toBe('tabular_regression');
    expect(suggestKind('numeric', 2)).toBe('tabular_classification');
    expect(suggestKind('categorical', null)).toBe('tabular_classification');
  });
});

describe('B2 超參數說明與 B3 K 折', () => {
  it('each hyperparameter has a plain explanation; rarely tuned ones are under advanced settings', async () => {
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '新增訓練設定' }));
    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    expect(within(form).getByLabelText('訓練回合數')).toHaveAccessibleDescription(/看過幾遍.*預設 3/);
    const advanced = within(form).getByText('進階設定（一般不需要調整）').closest('details')!;
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByLabelText('學習率')).toHaveAccessibleDescription(/修正模型的幅度/);
    expect(within(form).getByLabelText('亂數種子')).toHaveAccessibleDescription(/完全相同的結果/);
    await user.selectOptions(within(form).getByLabelText('訓練種類'), 'tabular_classification');
    await user.selectOptions(within(form).getByLabelText('演算法'), 'logistic_regression');
    expect(within(form).getByText('這個演算法使用建議值即可，不需要調整。')).toBeInTheDocument();
  });

  it('TC-B05-02 a K-fold setting is saved and read back identical; only the test share is asked', async () => {
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '新增訓練設定' }));
    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    await user.type(within(form).getByLabelText('設定名稱'), 'kfold');
    await user.selectOptions(within(form).getByLabelText('訓練種類'), 'tabular_classification');
    await user.selectOptions(await within(form).findByLabelText('資料集'), await within(form).findByRole('option', { name: /^lung-clinical/ }));
    await waitFor(() => expect(within(form).getByLabelText('要預測的結果（Target）')).toBeEnabled());
    await user.selectOptions(within(form).getByLabelText('要預測的結果（Target）'), 'diagnosis');
    await user.click(within(within(form).getByRole('group', { name: '用來預測的資料（Feature）' })).getByRole('checkbox', { name: 'age' }));
    await user.click(within(form).getByRole('radio', { name: 'K 折交叉驗證' }));
    expect(within(form).queryByLabelText('訓練集（%）')).toBeNull();
    const folds = within(form).getByLabelText('交叉驗證折數（K）');
    await user.clear(folds);
    await user.type(folds, '4');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已新增訓練設定「kfold」。');
    const config = trainingMock().settings[0].config;
    expect(config.validation).toEqual({ method: 'kfold', folds: 4 });
    expect(config.split).toEqual({ train: 0.8, validation: 0, test: 0.2 });

    await user.click(screen.getByRole('button', { name: '編輯「kfold」' }));
    const edit = await screen.findByRole('form', { name: '修改訓練設定「kfold」' });
    expect(within(edit).getByRole('radio', { name: 'K 折交叉驗證' })).toBeChecked();
    expect(within(edit).getByLabelText('交叉驗證折數（K）')).toHaveValue(4);
    await user.click(within(edit).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已儲存訓練設定「kfold」的修改。');
    expect(trainingMock().settings[0].config).toEqual(config);
  });

  it('an old setting without validation opens as fixed split and still saves and runs', async () => {
    seed('old', tabularConfig('tabular_classification'));
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '編輯「old」' }));
    const edit = await screen.findByRole('form', { name: '修改訓練設定「old」' });
    expect(within(edit).getByRole('radio', { name: '固定比例切分' })).toBeChecked();
    await user.click(within(edit).getByRole('button', { name: '儲存設定' }));
    await screen.findByText('已儲存訓練設定「old」的修改。');
    expect(trainingMock().settings[0].config.validation).toEqual({ method: 'holdout' });
    await finish(user, 'old');
  });
});

describe('B4 結果、B5 步驟條、B6 部署此模型', () => {
  it('step bar shows submitted → queued → training → done with icons and text', () => {
    expect(stepsOf('queued').map((s) => `${s.label}:${s.state}`)).toEqual(['已送出:done', '排隊中:current', '訓練中:todo', '完成:todo']);
    expect(stepsOf('running').map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo']);
    expect(stepsOf('failed').at(-1)).toEqual({ label: '失敗', state: 'failed' });
  });

  it('a finished K-fold classification shows plain metrics, baseline, warnings, charts and a report', async () => {
    seed('cls', tabularConfig('tabular_classification', { split: { train: 0.8, validation: 0, test: 0.2 }, validation: { method: 'kfold', folds: 5 } }));
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '送出訓練「cls」' }));
    const steps = await screen.findByRole('list', { name: '訓練 #1 的進度' });
    expect(within(steps).getByText('排隊中').closest('li')).toHaveAttribute('aria-current', 'step');
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'));

    const cards = screen.getByRole('list', { name: '訓練 #1 的重點指標' });
    expect(cards).toHaveTextContent(/準確率\d+(\.\d)?%測試集的 20 人中猜對 \d+ 人/);
    expect(cards).toHaveTextContent('AUC（ROC 曲線下面積）');
    expect(cards).toHaveTextContent('0.5 等於亂猜');
    expect(cards).toHaveTextContent('敏感度70%實際為「1」的人，模型抓到 70%');
    expect(cards).toHaveTextContent('特異度');
    expect(screen.getByText(/比較基準：全部猜訓練資料最常見的類別：55%/).closest('p')).toHaveTextContent(
      '訓練資料中最常見的是「0」（80 人中 48 人）；如果測試集每個人都猜「0」，20 人中會猜對 11 人');
    expect(screen.getByText(/測試集只有 20 人/)).toHaveTextContent('請以下方的 K 折平均為主');
    expect(screen.getByRole('table', { name: '訓練 #1 的 K 折結果' })).toHaveTextContent(/準確率\d+(\.\d)?% ± \d/);
    expect(await screen.findByRole('table', { name: '訓練 #1 的混淆矩陣' })).toHaveTextContent('9 人（82%），正確');
    expect(screen.getByText(/ROC 曲線（陽性＝「1」/)).toBeInTheDocument();
    expect(screen.getByText('特徵重要性（打亂後分數下降多少）')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '訓練清單' })).toHaveTextContent(/AUC（ROC 曲線下面積） 0\.\d+（5 折平均）/);

    await user.click(screen.getByRole('button', { name: '下載報表（可列印）' }));
    await screen.findByText('已下載 training-run-1-report.html');
    expect(saved).toEqual(['training-run-1-report.html']);

    const deploy = screen.getByRole('link', { name: '分享給同事使用' });
    expect(deploy.getAttribute('href')).toMatch(/^\/deployment\?model=\d+$/);
  });

  it('regression shows R², RMSE against the predict-the-mean baseline and the scatter and residual charts', async () => {
    seed('reg', tabularConfig('tabular_regression'));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, 'reg');
    expect(screen.getByRole('list', { name: '訓練 #1 的重點指標' })).toHaveTextContent('R²（解釋量）');
    expect(screen.getByText(/比較基準：每次都猜平均值：16\.2/)).toBeInTheDocument();
    expect(await screen.findByText('預測值與實際值')).toBeInTheDocument();
    expect(screen.getByText('殘差分布（實際值 − 預測值）')).toBeInTheDocument();
  });

  it('the run list sorts by main score, expands one run at a time and defaults to my runs', async () => {
    seed('a', tabularConfig('tabular_classification'));
    seed('b', tabularConfig('tabular_classification'));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, 'a');
    await finish(user, 'b');
    const run = (id: number) => trainingMock().runs.find((r) => r.id === id)!;
    (run(1).metrics.test as Record<string, number>).auc = 0.9;
    (run(2).metrics.test as Record<string, number>).auc = 0.6;
    trainingMock().runs.push({ ...run(1), id: 99, name: '別人的訓練', created_by: 'ra01' });
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    const table = screen.getByRole('table', { name: '訓練清單' });
    const order = () => within(table).getAllByRole('button', { name: /^(展開|收合)訓練 #/ }).map((b) => b.textContent);
    await waitFor(() => expect(order()).toEqual(['收合訓練 #2', '展開訓練 #1']));
    await user.click(within(table).getByRole('button', { name: '主要分數（依分數排序）' }));
    expect(order()).toEqual(['展開訓練 #1', '收合訓練 #2']);
    expect(within(table).getByRole('columnheader', { name: '主要分數（依分數排序）' })).toHaveAttribute('aria-sort', 'descending');
    await user.click(within(table).getByRole('button', { name: '展開訓練 #1' }));
    expect(order()).toEqual(['收合訓練 #1', '展開訓練 #2']);
    expect(screen.getAllByRole('heading', { name: /^訓練 #\d+：/ })).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: '只看我送出的' }));
    expect(order()).toHaveLength(3);
  });

  it('a failure shows the Chinese reason, a fix link and collapsed technical details', async () => {
    seed('會失敗', tabularConfig('tabular_classification'));
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('button', { name: '送出訓練「會失敗」' }));
    await user.click(await screen.findByRole('button', { name: '重新整理' }));
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('失敗'));
    expect(screen.getByRole('link', { name: '前往修正：資料集的 Target／Feature 設定' })).toHaveAttribute('href', '/data/tabular/2/target');
  });
});

describe('設定與資料集同步、執行方式、部署捷徑、試用預測', () => {
  it('a setting whose dataset Target/Feature changed offers to apply the new ones', async () => {
    seed('舊的', tabularConfig('tabular_classification', { tabular: { target: 'diagnosis', features: ['age', 'smoker_current'], steps: [], algorithm: 'random_forest' } }));
    await saveTargetFeature('diagnosis', ['age', 'smoker']);
    const { user } = await renderApp('/training', 'pi01');
    expect(await screen.findByText('與資料集設定不同')).toBeInTheDocument();
    expect(screen.getByTestId('setting-difference')).toHaveTextContent('與資料集目前的設定不同：Feature 多了 smoker_current，少了 smoker。');
    await user.click(screen.getByRole('button', { name: '套用資料集設定到「舊的」' }));
    await screen.findByText('已把資料集目前的 Target、Feature 與前處理套用到「舊的」。');
    expect(trainingMock().settings[0].config.tabular!.features).toEqual(['age', 'smoker']);
    await waitFor(() => expect(screen.queryByText('與資料集設定不同')).toBeNull());
  });

  it('only administrators see the fake-trainer option; settings default to mine', async () => {
    seed('mine', tabularConfig('tabular_classification'));
    seed('theirs', tabularConfig('tabular_classification'), 'ra01');
    await renderApp('/training', 'pi01');
    expect(await screen.findByRole('button', { name: '送出訓練「mine」' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '送出訓練「theirs」' })).toBeNull();
    expect(screen.getByText('（另有 1 份其他人的設定）')).toBeInTheDocument();
    expect(screen.queryByLabelText('執行方式')).toBeNull();
  });

  it('deploy shortcut preselects the model and suggests a name; try-out prediction shows class and probability', async () => {
    seed('心臟科確診預測', tabularConfig('tabular_classification', { tabular: { target: 'diagnosis', features: ['age', 'sex'], steps: [], algorithm: 'random_forest' } }));
    const { user } = await renderApp('/training', 'pi01');
    await finish(user, '心臟科確診預測');
    await user.click(screen.getByRole('link', { name: '分享給同事使用' }));
    const form = await screen.findByRole('form', { name: '分享給同事使用' });
    const modelId = String(trainingMock().runs[0].model_id);
    await waitFor(() => expect(within(form).getByLabelText('模型')).toHaveValue(modelId));
    expect(within(form).getByLabelText('顯示名稱（同事看到的名稱，可用中文）')).toHaveValue('心臟科確診預測');
    expect(within(form).getByText(/已選好剛訓練完成的模型/)).toBeInTheDocument();

    const tryForm = screen.getByRole('form', { name: '試用預測' });
    expect(within(tryForm).getByLabelText('模型')).toHaveValue(modelId);
    await user.click(within(tryForm).getByRole('button', { name: '預測' }));
    expect(await within(tryForm).findByRole('alert')).toHaveTextContent('請填寫：age、sex');
    await user.type(within(tryForm).getByLabelText('age'), '61');
    await user.selectOptions(within(tryForm).getByLabelText('sex'), 'M');
    await user.click(within(tryForm).getByRole('button', { name: '預測' }));
    expect(await within(tryForm).findByTestId('try-result')).toHaveTextContent(/^diagnosis 預測為「([01])」的機率 \d+%（為「[01]」的機率 \d+%）。$/);
  });
});

describe('metric helpers', () => {
  const run = (metrics: Record<string, unknown>, kind: TrainingKind = 'tabular_classification') => ({ kind, metrics, executor: 'template' }) as TrainingRun;

  it('old failure messages with a Python stack keep only the reason on top', () => {
    const old = '訓練程式以 1 結束： File "/work/template/runtime.py", line 131, in main ^^^ tabular.errors.TabularError: 特徵欄位「sex、smoker」不是數值，請先做類別編碼（例如 One-Hot）';
    expect(splitFailure(old)).toEqual({ reason: '特徵欄位「sex、smoker」不是數值，請先做類別編碼（例如 One-Hot）', details: old });
    expect(splitFailure('原因\n---\n細節')).toEqual({ reason: '原因', details: '細節' });
    expect(splitFailure('由 pi01 取消')).toEqual({ reason: '由 pi01 取消', details: '' });
  });

  it('warns about validation/test gaps, memorising the training data and no gain over the baseline', () => {
    const notes = warnings(run({ rows: { train: 300, validation: 100, test: 100 }, train: { accuracy: 0.95 }, validation: { accuracy: 0.8 },
      test: { accuracy: 0.62, baseline_accuracy: 0.6 } }));
    expect(notes.join('\n')).toMatch(/驗證集與測試集的準確率相差 18%/);
    expect(notes.join('\n')).toMatch(/模型可能只記住了訓練資料/);
    expect(notes.join('\n')).toMatch(/沒有明顯高於「全部都猜最常見類別」/);
    expect(notes.join('\n')).not.toMatch(/測試集只有/);
  });
});
