// 影像標註頁面（元件層級，模擬 API）。畫布上的操作由 Playwright 測（e2e/labeling.spec.ts）。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HOTKEYS } from '../../src/pages/labeling/WorkbenchPage';
import { createTrainingJob, trainingSetting } from '../../src/pages/labeling/api';
import { hotkeyId } from '../../src/pages/labeling/useHotkeys';
import { MOCK_STUDIES, MOCK_STUDY_COUNT, labelingMock } from '../../src/mocks/labeling';
import { trainingMock } from '../../src/mocks/training';
import { renderApp } from '../render';

const STUDY = MOCK_STUDIES[0];
const workbench = `/labeling/studies/${STUDY.study_instance_uid}`;

async function status(text: string | RegExp) {
  await waitFor(() => expect(screen.getByTestId('workbench-status')).toHaveTextContent(text));
}

async function openWorkbench(username = 'md01', path = workbench) {
  const utils = await renderApp(path, username);
  await screen.findByRole('heading', { level: 1, name: '影像標註工作台' });
  await waitFor(() => expect(screen.getByTestId('image-position')).toHaveTextContent('第 1 / 3 張'));
  return utils;
}

describe('labeling index', () => {
  it('lists the studies of the selected project with annotation counts', async () => {
    await renderApp('/labeling', 'md01');
    const table = await screen.findByRole('table', { name: '研究清單' });
    expect(within(table).getAllByRole('row')).toHaveLength(MOCK_STUDY_COUNT + 1);
    expect(within(table).getByRole('row', { name: /ACC0001.*PAT0001.*2024-02-15/ })).toBeInTheDocument();
    expect(screen.getByTestId('label-totals')).toHaveTextContent('共 10 個研究、0 筆標註');
  });

  it('TC-B02-07 vw01 has no labeling permission: the page is refused with a text reason', async () => {
    await renderApp('/labeling', 'vw01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Labeling 權限/)).toBeInTheDocument();
    await renderApp(workbench, 'vw01');
    expect((await screen.findAllByRole('heading', { name: '無法存取此功能' })).length).toBeGreaterThan(0);
  });

  it('TC-B02-05 CSV by patient ID labels 10 studies and reports rows that did not match', async () => {
    const { user } = await renderApp('/labeling', 'md01');
    await screen.findByRole('table', { name: '研究清單' });
    const rows = MOCK_STUDIES.map((s, i) => `${s.patient_id},${['nodule', 'normal'][i % 2]}`);
    const csv = ['病歷號,診斷結果', ...rows, 'PAT9999,nodule', ',normal'].join('\n');
    await user.upload(screen.getByLabelText(/^CSV 檔/), new File([csv], 'diagnosis.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '上傳並標註' }));
    const result = await screen.findByTestId('csv-result');
    expect(result).toHaveTextContent('共 12 列：已標註 10 列（10 個研究；新增 10、更新 0、未變動 0），找不到研究 1 列，診斷衝突 0 列，資料不完整 1 列');
    const problems = within(result).getByRole('table', { name: '未標註的資料列' });
    expect(within(problems).getByRole('row', { name: /12.*PAT9999.*找不到研究/ })).toBeInTheDocument();
    expect(within(problems).getByRole('row', { name: /13.*資料不完整.*缺少鍵值/ })).toBeInTheDocument();
    const saved = labelingMock().annotations;
    expect(saved).toHaveLength(10);
    MOCK_STUDIES.forEach((s, i) => {
      const a = saved.find((x) => x.study_instance_uid === s.study_instance_uid)!;
      expect(a).toMatchObject({ source: 'csv', kind: 'classification', sop_instance_uid: null, payload: { label: ['nodule', 'normal'][i % 2] } });
    });
    await waitFor(() => expect(screen.getByTestId('label-totals')).toHaveTextContent('10 筆標註（分類 10'));
  });

  it('CSV without the needed columns shows the server message', async () => {
    const { user } = await renderApp('/labeling', 'md01');
    await screen.findByRole('table', { name: '研究清單' });
    await user.upload(screen.getByLabelText(/^CSV 檔/), new File(['a,b\n1,2\n'], 'x.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '上傳並標註' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('CSV 找不到鍵欄位');
    expect(labelingMock().annotations).toHaveLength(0);
  });

  it('TC-B02-06 training panel needs Training permission', async () => {
    await renderApp('/labeling', 'md01');
    await screen.findByRole('table', { name: '研究清單' });
    expect(screen.getByText(/建立訓練任務需要 Training 權限/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建立訓練任務' })).toBeNull();
  });

  function studyLabel(label: string) {
    const s = labelingMock();
    s.annotations.push({
      id: s.nextAnnotationId++, project_id: 1, study_instance_uid: STUDY.study_instance_uid, series_instance_uid: null,
      sop_instance_uid: null, kind: 'classification', payload: { label }, source: 'manual', rating: null, version: 1,
      autolabel_run_id: null, created_by: 'ra01', updated_by: 'ra01', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z',
    });
  }

  it('TC-B02-06 one classification label is not enough: the page says so before submitting', async () => {
    studyLabel('nodule');
    await renderApp('/labeling', 'ra01');
    const form = await screen.findByRole('form', { name: '建立訓練任務' });
    await within(form).findByLabelText(/nodule/);
    expect(within(form).getByText(/目前只有 1 種分類標籤（nodule）/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '建立訓練任務' })).toBeDisabled();
    expect(trainingMock().runs).toHaveLength(0);
  });

  it('two classification labels but only one ticked is stopped before it reaches the server', async () => {
    studyLabel('nodule');
    studyLabel('normal');
    const { user } = await renderApp('/labeling', 'ra01');
    const form = await screen.findByRole('form', { name: '建立訓練任務' });
    await user.click(await within(form).findByLabelText(/normal/));
    await user.click(within(form).getByRole('button', { name: '建立訓練任務' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('影像分類至少要 2 種 Label');
    expect(trainingMock().runs).toHaveLength(0);
  });

  it('study list shows the classification labels and how many studies are labelled', async () => {
    studyLabel('abnormal');
    await renderApp('/labeling', 'ra01');
    expect(await screen.findByTestId('label-progress')).toHaveTextContent(`已標註 1／共 ${MOCK_STUDY_COUNT} 個研究`);
    expect(screen.getAllByTestId('study-classes')[0]).toHaveTextContent('abnormal');
  });

  it('TC-B02-06 creates a training task from the labeling page with type and parameters', async () => {
    studyLabel('nodule');
    studyLabel('normal');
    const { user } = await renderApp('/labeling', 'ra01');
    const form = await screen.findByRole('form', { name: '建立訓練任務' });
    await within(form).findByLabelText(/nodule/);
    await user.clear(within(form).getByLabelText('隨機種子'));
    await user.type(within(form).getByLabelText('隨機種子'), '7');
    await user.click(within(form).getByRole('button', { name: '建立訓練任務' }));
    const table = await screen.findByRole('table', { name: '已建立的訓練任務' });
    expect(within(table).getByRole('row', { name: /#1.*排隊中/ })).toBeInTheDocument();
    expect(trainingMock().runs).toEqual([expect.objectContaining({ kind: 'image_classification', created_by: 'ra01', project_id: 1, status: 'queued' })]);
    expect(trainingMock().runs[0].config).toMatchObject({ seed: 7, source: { label_source: { provider: 'annotations' } } });
  });

  it('createTrainingJob saves a training setting from the labels and submits a training run (WP5b)', async () => {
    const calls: [string, unknown][] = [];
    const replies = [{ id: 9 }, { id: 21, project_id: 3, status: 'queued', kind: 'image_detection' }];
    const api = { post: async (path: string, body: unknown) => (calls.push([path, body]), replies.shift()) } as never;
    const run = await createTrainingJob(api, 3, {
      trainingType: 'detection', labels: ['nodule', 'organ'], resize: 128, validationSplit: 0.2, testSplit: 0.1, seed: 1,
    });
    expect(calls.map((c) => c[0])).toEqual(['/api/projects/3/training/settings', '/api/projects/3/training/settings/9/runs']);
    const setting = calls[0][1] as { name: string; config: unknown };
    expect(setting.name).toMatch(/^標註頁訓練 /);
    expect(setting.config).toEqual({
      kind: 'image_detection',
      source: { type: 'dicom', studies: 'all', label_source: { provider: 'annotations' } },
      image: { resize: [128, 128], labels: ['nodule', 'organ'] },
      split: { train: 0.7, validation: 0.2, test: 0.1 },
      seed: 1,
    });
    expect(calls[1][1]).toEqual({ executor: 'template' });
    expect(run).toMatchObject({ id: 21, status: 'queued', kind: 'image_detection' });
  });

  it('training split adds up to exactly 1 for every whole-percent choice', () => {
    for (let v = 0; v <= 90; v += 1) {
      for (const t of [0, 5, 10, 15, 30]) {
        if (v + t >= 100) continue;
        const { split } = trainingSetting({ trainingType: 'classification', labels: ['a', 'b'], resize: 32,
          validationSplit: v / 100, testSplit: t / 100, seed: 0 }, 'x').config;
        expect(Math.abs(split.train + split.validation + split.test - 1)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('workbench', () => {
  it('TC-B02-01 toolbar has layout, rotation, WW/WC and at least 3 organ presets', async () => {
    const { user } = await openWorkbench();
    const toolbar = screen.getByRole('toolbar', { name: '檢視工具列' });
    const presets = within(within(toolbar).getByRole('group', { name: '器官窗' })).getAllByRole('button');
    expect(presets.length).toBeGreaterThanOrEqual(3);

    await user.click(within(toolbar).getByRole('button', { name: '肺窗' }));
    await status('肺窗：窗寬 1500、窗位 -600');
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-window-width', '1500');
    expect(within(toolbar).getByRole('button', { name: '肺窗' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(toolbar).getByRole('button', { name: '向右轉 90°' }));
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-rotation', '90');
    await user.click(within(toolbar).getByRole('button', { name: '向左轉 90°' }));
    await user.click(within(toolbar).getByRole('button', { name: '向左轉 90°' }));
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-rotation', '270');

    await user.click(within(toolbar).getByRole('button', { name: '2×2' }));
    expect(screen.getByTestId('viewport-grid')).toHaveAttribute('data-layout', '2x2');
    expect(screen.getAllByTestId('viewport')).toHaveLength(3); // 這個序列只有 3 張

    await user.clear(within(toolbar).getByLabelText('窗寬 WW'));
    await user.type(within(toolbar).getByLabelText('窗寬 WW'), '350');
    await user.clear(within(toolbar).getByLabelText('窗位 WL'));
    await user.type(within(toolbar).getByLabelText('窗位 WL'), '50');
    await user.click(within(toolbar).getByRole('button', { name: '套用' }));
    await status('窗寬 350、窗位 50');
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-window-center', '50');
  });

  it('TC-B02-02 five hotkey groups are documented and each one acts', async () => {
    await openWorkbench();
    expect(HOTKEYS.length).toBeGreaterThanOrEqual(5);
    const press = (key: string) => fireEvent.keyDown(document.body, { key });
    const viewport = () => screen.getAllByTestId('viewport')[0];

    press('2'); // 器官窗
    await status('肺窗');
    expect(viewport()).toHaveAttribute('data-window-center', '-600');
    press('r'); // 旋轉
    await waitFor(() => expect(viewport()).toHaveAttribute('data-rotation', '90'));
    press('ArrowDown'); // 換張
    await waitFor(() => expect(screen.getByTestId('image-position')).toHaveTextContent('第 2 / 3 張'));
    press('g'); // 排列
    await waitFor(() => expect(screen.getByTestId('viewport-grid')).toHaveAttribute('data-layout', '1x2'));
    press('d'); // 標註工具
    await waitFor(() => expect(screen.getByRole('button', { name: '畫框工具' })).toHaveAttribute('aria-pressed', 'true'));
    press('b');
    await waitFor(() => expect(screen.getByRole('button', { name: '筆刷' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('hotkeys do not fire while typing in a field', async () => {
    const { user } = await openWorkbench();
    const input = screen.getByLabelText('標籤');
    await user.clear(input);
    await user.type(input, 'r2d');
    expect(input).toHaveValue('r2d');
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-rotation', '0');
    expect(hotkeyId({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe('ctrl+s');
    expect(hotkeyId({ key: ' ', ctrlKey: false, metaKey: false, altKey: false })).toBe('space');
  });

  it('TC-B02-04 saves classification and detection, then shows them after reload', async () => {
    const { user, unmount } = await openWorkbench();
    await user.clear(screen.getByLabelText('標籤'));
    await user.type(screen.getByLabelText('標籤'), 'pneumonia');
    await user.click(screen.getByRole('button', { name: '儲存分類標註' }));
    await status('已儲存分類標註 #1：pneumonia');
    // 分類預設是整個研究，並且直接標在影像左上角
    expect(await screen.findByRole('list', { name: '這張影像的分類標註' })).toHaveTextContent('整個研究：pneumonia');

    await user.click(within(screen.getByRole('group', { name: '標註種類' })).getByRole('button', { name: '偵測' }));
    const form = screen.getByRole('form', { name: '以座標新增框' });
    for (const [name, value] of [['x1', '4'], ['y1', '6'], ['x2', '20'], ['y2', '30']]) {
      await user.type(within(form).getByLabelText(name), value);
    }
    await user.click(within(form).getByRole('button', { name: '新增框' }));
    expect(within(screen.getByRole('list', { name: '草稿中的框' })).getByText('[4, 6, 20, 30]')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '儲存偵測標註' }));
    await status('已儲存偵測標註 #2（1 個框，版本 1）');

    unmount();
    await openWorkbench();
    const table = await screen.findByRole('table', { name: '標註清單' });
    expect(within(table).getByRole('row', { name: /#1.*分類.*整個研究.*pneumonia.*手動/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /#2.*偵測.*第 1 張.*pneumonia.*手動/ })).toBeInTheDocument();
    expect(labelingMock().annotations[1].payload).toEqual({
      shape: [64, 64], box_format: 'xyxy', boxes: [{ label: 'pneumonia', box: [4, 6, 20, 30] }],
    });
  });

  it('rejects a box outside the image before it reaches the server', async () => {
    const { user } = await openWorkbench();
    await user.click(within(screen.getByRole('group', { name: '標註種類' })).getByRole('button', { name: '偵測' }));
    const form = screen.getByRole('form', { name: '以座標新增框' });
    for (const [name, value] of [['x1', '4'], ['y1', '6'], ['x2', '70'], ['y2', '30']]) {
      await user.type(within(form).getByLabelText(name), value);
    }
    await user.click(within(form).getByRole('button', { name: '新增框' }));
    await status('0 ≤ x1 < x2 ≤ 64');
    expect(screen.getByRole('button', { name: '儲存偵測標註' })).toBeDisabled();
  });

  it('TC-B02-03 rating is saved and shown again after reload; pressing it again clears it', async () => {
    const { user, unmount } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(screen.getByRole('button', { name: '儲存分類標註' }));
    await status('已儲存分類標註 #1');
    const rating = await screen.findByRole('group', { name: '標註 #1 的評分' });
    await user.click(within(rating).getByRole('button', { name: '4 分' }));
    await status('標註 #1 評為 4 分');
    unmount();
    await openWorkbench();
    const again = await screen.findByRole('group', { name: '標註 #1 的評分' });
    expect(within(again).getByRole('button', { name: '4 分' })).toHaveAttribute('aria-pressed', 'true');
    expect(labelingMock().annotations[0].rating).toBe(4);
    await user.click(within(again).getByRole('button', { name: '4 分' }));
    await status('已清除標註 #1 的評分');
    expect(labelingMock().annotations[0].rating).toBeNull();
  });

  it('classification needs a label typed first; no label is filled in for the user', async () => {
    const { user } = await openWorkbench();
    expect(screen.getByLabelText('標籤')).toHaveValue('');
    expect(screen.getByRole('button', { name: '儲存分類標註' })).toBeDisabled();
    await user.type(screen.getByLabelText('標籤'), 'normal');
    await user.click(screen.getByLabelText('這張影像'));
    await user.click(screen.getByRole('button', { name: '儲存分類標註' }));
    await status('已儲存分類標註 #1：normal');
    expect(await screen.findByRole('list', { name: '這張影像的分類標註' })).toHaveTextContent('這張影像：normal');
    expect(labelingMock().annotations[0].sop_instance_uid).not.toBeNull();
  });

  it('warns before leaving the page with an unsaved box', async () => {
    const { user } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(within(screen.getByRole('group', { name: '標註種類' })).getByRole('button', { name: '偵測' }));
    const form = screen.getByRole('form', { name: '以座標新增框' });
    for (const [name, value] of [['x1', '4'], ['y1', '6'], ['x2', '20'], ['y2', '30']]) {
      await user.type(within(form).getByLabelText(name), value);
    }
    await user.click(within(form).getByRole('button', { name: '新增框' }));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('link', { name: '← 回研究清單' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('尚未儲存的標註'));
    expect(screen.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('edits and deletes an annotation', async () => {
    const { user } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(screen.getByRole('button', { name: '儲存分類標註' }));
    await status('已儲存分類標註 #1');
    await user.click(await screen.findByRole('button', { name: '編輯標註 #1' }));
    await user.clear(screen.getByLabelText('標籤'));
    await user.type(screen.getByLabelText('標籤'), 'normal');
    await user.click(screen.getByRole('button', { name: '儲存分類標註' }));
    await status('已更新分類標註 #1：normal（版本 2）');
    await user.click(screen.getByRole('button', { name: '刪除標註 #1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '刪除' }));
    await status('已刪除標註 #1');
    expect(labelingMock().annotations).toHaveLength(0);
  });

  it('a study outside the project shows a clear message', async () => {
    await renderApp('/labeling/studies/1.2.3.404', 'md01');
    expect(await screen.findByText('你沒有權限檢視這個研究，或研究不在本專案的 Accession 清單內')).toBeInTheDocument();
  });
});

describe('auto labeling', () => {
  it('TC-B03-01 / TC-B03-03 submits, stores, and opens the result for editing', async () => {
    const { user, unmount } = await renderApp('/auto-labeling', 'md01');
    await screen.findByRole('heading', { level: 1, name: '自動影像分類標註' });
    await waitFor(() => expect(screen.getByLabelText('影像')).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText('模型'), 'fake_detection');
    await user.click(screen.getByRole('button', { name: '送出自動標註' }));
    const result = await screen.findByTestId('autolabel-result');
    expect(result).toHaveTextContent('已存為偵測標註 #1');
    const runs = await screen.findByRole('table', { name: '自動標註執行紀錄' });
    expect(within(runs).getByRole('row', { name: /#1.*fake_detection.*偵測.*md01/ })).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: '在標註工作台開啟編輯' })).toHaveAttribute(
      'href', `/labeling/studies/${STUDY.study_instance_uid}?annotation=1`);

    unmount();
    const opened = await openWorkbench('md01', `${workbench}?annotation=1`);
    await status('編輯標註 #1（偵測，自動標註）');
    const boxes = within(screen.getByRole('list', { name: '草稿中的框' })).getAllByRole('listitem');
    expect(boxes).toHaveLength(2);
    await opened.user.click(screen.getByRole('button', { name: '刪除第 2 個框' }));
    await opened.user.click(screen.getByRole('button', { name: '儲存偵測標註' }));
    await status('已儲存偵測標註 #1（1 個框，版本 2）');
    expect(labelingMock().annotations[0]).toMatchObject({ source: 'autolabel', version: 2, autolabel_run_id: 1 });
  });

  it('TC-B03-05 shows the service error and stores nothing when the service is offline', async () => {
    const { user } = await renderApp('/auto-labeling', 'md01');
    await waitFor(() => expect(screen.getByLabelText('影像')).not.toBeDisabled());
    labelingMock().autolabelOffline = true;
    await user.click(screen.getByRole('button', { name: '送出自動標註' }));
    expect(await screen.findByText('自動標註服務目前無法連線，請稍後再試')).toBeInTheDocument();
    expect(labelingMock().annotations).toHaveLength(0);
    expect(labelingMock().runs).toHaveLength(0);
  });
});
