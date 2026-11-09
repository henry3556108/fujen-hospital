// 介面改版（C 區）：指標計數（F3）、訓練設定右側詳情（B02）、精靈只儲存設定（A06）、模型下載與呼叫說明（B11）、流程步驟條（B08）。
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { trainingMock, trainingMockOptions } from '../../src/mocks/training';
import { confusionCounts, countText } from '../../src/pages/training/metrics';
import { guideText, metricTiles, requirementsOf } from '../../src/pages/models/ModelsPage';
import { pythonCallExample } from '../../src/pages/deployment/DeploymentPage';
import { renderApp } from '../render';

trainingMockOptions.stepMs = 0;

describe('指標計數（F3）', () => {
  it('counts come from the confusion matrix and only show when they match the metric', () => {
    // labels [0, 1]，陽性＝1：TN 6、FP 2、FN 3、TP 7
    const counts = confusionCounts({ labels: ['0', '1'], matrix: [[6, 2], [3, 7]] }, '1');
    expect(counts.sensitivity).toEqual([7, 10]);
    expect(counts.specificity).toEqual([6, 8]);
    expect(counts.accuracy).toEqual([13, 18]);
    expect(countText('sensitivity', 0.7, counts)).toBe('7 / 10');
    // 數字對不上（例如 K 折平均）就不顯示
    expect(countText('sensitivity', 0.65, counts)).toBe('');
    expect(countText('auc', 0.9, counts)).toBe('');
    const tiles = metricTiles([
      { name: 'sensitivity', label: '敏感度', text: '70%', value: 0.7 },
      { name: 'auc', label: 'AUC', text: '0.85', value: 0.85 },
    ], counts);
    expect(tiles.map((t) => t.count)).toEqual(['7 / 10', undefined]);
    expect(tiles[0].plain).toBe('有異常時辨識出的比例');
  });
});

describe('模型下載的依賴清單與範例（B11）', () => {
  const model = { name: 'm', format: 'pkl' as const, filename: 'm.pkl', sha256: 'abc', card: { features: ['age'] } };
  it('uses the versions recorded on the model card, otherwise the platform list', () => {
    expect(requirementsOf({ ...model, card: { libraries: { 'scikit-learn': '1.5.2', numpy: '2.1.0' } } })).toEqual({ text: 'scikit-learn==1.5.2\nnumpy==2.1.0', recorded: true });
    const fallback = requirementsOf(model);
    expect(fallback.recorded).toBe(false);
    expect(fallback.text.split('\n')).toContain('scikit-learn');
    const guide = guideText(model);
    expect(guide).toContain('pip install -r requirements.txt');
    expect(guide).toContain('joblib.load("m.pkl")');
  });

  it('python call example posts rows for tabular and files for images', () => {
    expect(pythonCallExample({ endpoint: '/api/inference/x/predict' })).toContain('json={"rows": rows}');
    expect(pythonCallExample({ endpoint: '/e' }, { kind: 'image_classification', card: {} } as never)).toContain('files=[("files", f)]');
  });
});

describe('訓練設定（B02）', () => {
  it('the selected setting shows its details, split bar and 套用並建立訓練任務 on the right', async () => {
    const { user } = await renderApp('/training/settings', 'ra01');
    await user.click(await screen.findByRole('button', { name: '新增訓練設定' }));
    const form = await screen.findByRole('form', { name: '新增訓練設定' });
    await user.type(within(form).getByLabelText('設定名稱'), '詳情');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    const panel = await screen.findByRole('complementary', { name: '詳情' });
    expect(within(panel).getByText('資料分群')).toBeInTheDocument();
    const id = trainingMock().settings[0].id;
    expect(within(panel).getByRole('link', { name: '套用並建立訓練任務' })).toHaveAttribute('href', `/training/new?setting=${id}`);
    // 表格每列仍有送出、套用、修改、各階段處理程式碼
    const row = screen.getByRole('table', { name: '訓練設定清單' }).querySelector('tbody tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: '送出訓練「詳情」' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '各階段處理程式碼「詳情」' })).toBeInTheDocument();
  });

  it('the wizard can save the setting without starting training', async () => {
    const { user } = await renderApp('/training/new', 'ra01');
    await user.click(await screen.findByRole('radio', { name: /影像分類/ }));
    await user.click(screen.getByRole('button', { name: '下一步：確認資料' }));
    await user.click(await screen.findByRole('button', { name: '下一步：確認並送出' }));
    const form = await screen.findByRole('form', { name: '確認並送出' });
    await user.type(within(form).getByLabelText('設定名稱'), '只存');
    await user.type(within(form).getByLabelText('Label（以逗號分隔）'), 'a, b');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByText('已儲存訓練設定「只存」。')).toBeInTheDocument();
    expect(trainingMock().runs).toHaveLength(0);
  });
});

describe('模型部署與推論服務：模型部署底下的分頁（B11）', () => {
  it('download and call tabs sit under 模型部署', async () => {
    const first = await renderApp('/training/new', 'pi01');
    await first.user.click(await screen.findByRole('radio', { name: /影像分類/ }));
    await first.user.click(screen.getByRole('button', { name: '下一步：確認資料' }));
    await first.user.click(await screen.findByRole('button', { name: '下一步：確認並送出' }));
    const form = await screen.findByRole('form', { name: '確認並送出' });
    await first.user.type(within(form).getByLabelText('設定名稱'), 'D');
    await first.user.type(within(form).getByLabelText('Label（以逗號分隔）'), 'a, b');
    await first.user.click(within(form).getByRole('button', { name: '確認並送出訓練' }));
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('已完成'), { timeout: 10_000 });
    first.unmount();

    const runId = trainingMock().runs[0].id;
    const second = await renderApp(`/models/${runId}/download`, 'pi01');
    const sub = await screen.findByRole('navigation', { name: '模型部署分頁' });
    expect(within(sub).getAllByRole('link').map((a) => a.textContent)).toEqual(['模型部署', '模型下載', '呼叫說明']);
    expect(within(screen.getByRole('navigation', { name: '模型分頁' })).getByRole('link', { name: '模型部署' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByLabelText('requirements.txt')).toHaveTextContent('tensorflow');
    expect(screen.getByRole('button', { name: /^下載模型「/ })).toBeInTheDocument();
    second.unmount();

    await renderApp(`/models/${runId}/call`, 'pi01');
    expect(await screen.findByText(/這個模型還沒有部署/)).toBeInTheDocument();
  }, 30_000);
});
