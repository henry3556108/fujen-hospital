// 影像標註頁面（元件層級，模擬 API）。畫布上的操作由 Playwright 測（e2e/labeling.spec.ts）。
// 兩區路由直接渲染（area-render），不經過 App 外框；權限守門那一則仍走整個 App。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HOTKEYS } from '../../src/pages/labeling/WorkbenchPage';
import { createTrainingJob, trainingSetting } from '../../src/pages/labeling/api';
import { nextPendingStudy } from '../../src/pages/labeling/pending';
import { hotkeyId } from '../../src/pages/labeling/useHotkeys';
import type { Annotation } from '../../src/pages/labeling/types';
import { MOCK_STUDIES, MOCK_STUDY_COUNT, labelingMock } from '../../src/mocks/labeling';
import { renderApp } from '../render';
import { renderArea } from './area-render';

const STUDY = MOCK_STUDIES[0];
const workbench = `/labeling/studies/${STUDY.study_instance_uid}`;

async function status(text: string | RegExp) {
  await waitFor(() => expect(screen.getByTestId('workbench-status')).toHaveTextContent(text));
}

async function openWorkbench(username = 'md01', path = workbench) {
  const utils = await renderArea(path, username);
  await screen.findByRole('heading', { level: 1, name: '影像標註工作台' });
  await waitFor(() => expect(screen.getByTestId('image-position')).toHaveTextContent('第 1 / 3 張'));
  return utils;
}

function studyLabel(label: string, study = STUDY, extra: Partial<Annotation> = {}) {
  const s = labelingMock();
  s.annotations.push({
    id: s.nextAnnotationId++, project_id: 1, study_instance_uid: study.study_instance_uid, series_instance_uid: null,
    sop_instance_uid: null, kind: 'classification', payload: { label }, source: 'manual', rating: null, version: 1,
    autolabel_run_id: null, created_by: 'ra01', updated_by: 'ra01', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z',
    status: 'confirmed', ...extra,
  });
}

describe('pending list', () => {
  it('lists the studies of the selected project with annotation counts', async () => {
    await renderArea('/labeling', 'md01');
    const table = await screen.findByRole('table', { name: '研究清單' });
    expect(within(table).getAllByRole('row')).toHaveLength(MOCK_STUDY_COUNT + 1);
    expect(within(table).getByRole('row', { name: /ACC0001.*PAT0001.*2024-02-15/ })).toBeInTheDocument();
    expect(screen.getByTestId('label-totals')).toHaveTextContent('共 10 個研究、0 筆標註');
  });

  it('TC-B02-07 vw01 has no labeling permission: the page is refused with a text reason', async () => {
    await renderApp('/labeling', 'vw01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Labeling 權限/)).toBeInTheDocument();
  });

  it('shows confirmed / total, pending count, drafts per study and the classes', async () => {
    studyLabel('abnormal');
    studyLabel('nodule', MOCK_STUDIES[1], { source: 'autolabel', status: 'draft' });
    await renderArea('/labeling', 'ra01');
    const progress = await screen.findByTestId('label-progress');
    expect(progress).toHaveTextContent(`已確認（共 ${MOCK_STUDY_COUNT} 個研究）`);
    expect(within(progress).getByRole('progressbar')).toHaveAttribute('aria-valuetext', `1 / ${MOCK_STUDY_COUNT}`);
    // 9 個沒有已確認標註的研究＋1 筆草稿
    expect(screen.getByTestId('pending-count')).toHaveTextContent('10');
    expect(screen.getAllByTestId('study-classes')[0]).toHaveTextContent('abnormal');
    expect(screen.getByRole('row', { name: /ACC0002/ })).toHaveTextContent('待處理');
    expect(screen.getByRole('row', { name: /ACC0001/ })).toHaveTextContent('已確認');
  });

  it('繼續標註 opens the first pending study', async () => {
    studyLabel('abnormal');
    const { user } = await renderArea('/labeling', 'ra01');
    await user.click(await screen.findByRole('button', { name: '繼續標註' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/labeling/studies/${MOCK_STUDIES[1].study_instance_uid}`));
  });

  it('filters by status and text', async () => {
    studyLabel('abnormal');
    const { user } = await renderArea('/labeling', 'ra01');
    await screen.findByRole('table', { name: '研究清單' });
    await user.selectOptions(screen.getByLabelText('標註狀態'), 'confirmed');
    await waitFor(() => expect(within(screen.getByRole('table', { name: '研究清單' })).getAllByRole('row')).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText('標註狀態'), '');
    await user.type(screen.getByLabelText('搜尋'), 'PAT0003');
    await waitFor(() => expect(within(screen.getByRole('table', { name: '研究清單' })).getAllByRole('row')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: '下一頁' })).toBeNull();
  });

  it('nextPendingStudy goes forward, wraps around and skips the current study', () => {
    const studies = MOCK_STUDIES.slice(0, 3).map((s, i) => ({
      study_instance_uid: s.study_instance_uid, accession_number: s.accession_number, patient_id: s.patient_id, study_date: s.study_date,
      study_description: s.study_description, annotations: i === 1 ? 1 : 0, confirmed: i === 1 ? 1 : 0, drafts: 0,
      by_kind: { classification: 0, segmentation: 0, detection: 0 }, classification_labels: [],
    }));
    expect(nextPendingStudy(studies, studies[0].study_instance_uid)?.study_instance_uid).toBe(studies[2].study_instance_uid);
    expect(nextPendingStudy(studies, studies[2].study_instance_uid)?.study_instance_uid).toBe(studies[0].study_instance_uid);
    expect(nextPendingStudy(studies.slice(1, 2), null)).toBeNull();
  });
});

describe('label datasets', () => {
  it('TC-B02-05 importing diagnoses by patient ID labels 10 studies into a new named dataset', async () => {
    const { user } = await renderArea('/labeling/datasets', 'md01');
    await screen.findByRole('heading', { name: '匯入診斷結果' });
    const rows = MOCK_STUDIES.map((s, i) => `${s.patient_id},${['nodule', 'normal'][i % 2]}`);
    const csv = ['病歷號,診斷結果', ...rows, 'PAT9999,nodule', ',normal'].join('\n');
    await user.upload(screen.getByLabelText(/^CSV 檔/), new File([csv], 'diagnosis.csv', { type: 'text/csv' }));
    const preview = await screen.findByTestId('csv-preview');
    expect(preview).toHaveTextContent('共 12 列，可配對 10 列，找不到研究 1 列');
    expect(preview).toHaveTextContent('目前專案是「');
    expect(preview).toHaveTextContent('這個專案有 10 筆影像');
    expect(screen.getByLabelText('新資料集名稱')).toHaveValue('diagnosis');
    await user.click(screen.getByRole('button', { name: '匯入' }));
    const result = await screen.findByTestId('csv-result');
    expect(result).toHaveTextContent('共 12 列：已標註 10 列（10 個研究；新增 10、更新 0、未變動 0），找不到研究 1 列，診斷衝突 0 列，資料不完整 1 列');
    const problems = within(result).getByRole('table', { name: '未標註的資料列' });
    expect(within(problems).getByRole('row', { name: /12.*PAT9999.*找不到研究/ })).toBeInTheDocument();
    expect(within(problems).getByRole('row', { name: /13.*資料不完整.*缺少鍵值/ })).toBeInTheDocument();
    const saved = labelingMock().annotations;
    expect(saved).toHaveLength(10);
    MOCK_STUDIES.forEach((s, i) => {
      const a = saved.find((x) => x.study_instance_uid === s.study_instance_uid)!;
      expect(a).toMatchObject({ source: 'csv', status: 'confirmed', kind: 'classification', sop_instance_uid: null, payload: { label: ['nodule', 'normal'][i % 2] } });
    });
    const named = labelingMock().datasets.find((d) => d.name === 'diagnosis')!;
    expect(named.classes).toEqual(['nodule', 'normal']);
    expect(within(result).getByRole('link', { name: '查看這份標註資料集' })).toHaveAttribute('href', `/labeling/datasets/${named.id}`);
    // md01 沒有 Training 權限：不給「用這份資料建立模型」
    expect(within(result).queryByRole('link', { name: /用這份資料建立模型/ })).toBeNull();
    // 第一次有分類標註時，系統也自動建了專案的分類資料集
    await waitFor(() => expect(screen.getByRole('table', { name: '標註資料集' })).toHaveTextContent('分類標註'));
  });

  it('after a CSV import, someone with Training gets the next step to build a model', async () => {
    const { user } = await renderArea('/labeling/datasets', 'pi01');
    await screen.findByRole('heading', { name: '匯入診斷結果' });
    const rows = MOCK_STUDIES.map((s, i) => `${s.patient_id},${['nodule', 'normal'][i % 2]}`);
    await user.upload(screen.getByLabelText(/^CSV 檔/), new File([['病歷號,診斷結果', ...rows].join('\n')], 'dx.csv', { type: 'text/csv' }));
    await screen.findByTestId('csv-preview');
    await user.click(screen.getByRole('button', { name: '匯入' }));
    const result = await screen.findByTestId('csv-result');
    const named = labelingMock().datasets.find((d) => d.name === 'dx')!;
    expect(within(result).getByRole('link', { name: '下一步：用這份資料建立模型' })).toHaveAttribute('href', `/training/new?labelDataset=${named.id}`);
  });

  it('CSV without the needed columns shows the server message', async () => {
    const { user } = await renderArea('/labeling/datasets', 'md01');
    await screen.findByRole('heading', { name: '匯入診斷結果' });
    await user.upload(screen.getByLabelText(/^CSV 檔/), new File(['a,b\n1,2\n'], 'x.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '匯入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('CSV 找不到鍵欄位');
    expect(labelingMock().annotations).toHaveLength(0);
  });

  it('creates a dataset and its page shows distribution, drafts and items', async () => {
    studyLabel('abnormal');
    studyLabel('normal', MOCK_STUDIES[1], { source: 'csv' });
    studyLabel('abnormal', MOCK_STUDIES[2], { source: 'autolabel', status: 'draft' });
    const { user } = await renderArea('/labeling/datasets', 'ra01');
    await screen.findByRole('heading', { name: '標註資料集' });
    await user.click(screen.getByText('建立標註資料集'));
    await user.type(screen.getByLabelText('名稱（必填）'), '肺結節研究');
    await user.click(screen.getByRole('button', { name: '建立' }));
    await user.click(await screen.findByRole('link', { name: '開啟這份資料集' }));
    const summary = await screen.findByTestId('dataset-summary');
    expect(summary).toHaveTextContent('影像分類');
    expect(summary).toHaveTextContent('2 筆、2 個研究');
    // 右側資訊欄的類別統計、來源統計（設計稿 A04）
    const byClass = within(summary).getByRole('list', { name: '類別統計' });
    expect(byClass).toHaveTextContent('abnormal1（50.0%）');
    expect(byClass).toHaveTextContent('normal1（50.0%）');
    const bySource = within(summary).getByRole('list', { name: '來源統計' });
    expect(bySource).toHaveTextContent('手動1（50.0%）');
    expect(bySource).toHaveTextContent('CSV 匯入1（50.0%）');
    expect(summary).toHaveTextContent('1 筆（訓練不會用到');
    // 已確認／待確認進度
    expect(screen.getByRole('progressbar', { name: '已確認' })).toHaveAttribute('aria-valuetext', '2 / 3');
    expect(screen.getByRole('progressbar', { name: '待確認' })).toHaveAttribute('aria-valuetext', '1 / 3');
    const items = await screen.findByRole('table', { name: '資料集內的標註' });
    expect(within(items).getAllByRole('row')).toHaveLength(4);
    expect(within(items).getByRole('row', { name: /ACC0003.*自動標註.*abnormal.*待確認/ })).toBeInTheDocument();
    // CSV 匯入的標註是已確認
    expect(within(items).getByRole('row', { name: /ACC0002.*CSV 匯入.*normal.*已確認/ })).toBeInTheDocument();
    // ra01 有 Training 權限
    expect(screen.getByRole('link', { name: '用這份資料建立模型' })).toHaveAttribute('href', expect.stringMatching(/^\/training\/new\?labelDataset=\d+$/));
  });

  it('without Training permission the dataset page has no 建立模型 button', async () => {
    studyLabel('abnormal');
    labelingMock().datasets.push({
      id: 77, project_id: 1, name: 'md 資料集', task: 'classification', scope_id: null, classes: [], created_by: 'md01',
      created_at: '2026-09-29T00:00:00Z', versions: [],
    } as never);
    await renderArea('/labeling/datasets/77', 'md01');
    await screen.findByTestId('dataset-summary');
    expect(screen.queryByRole('link', { name: '用這份資料建立模型' })).toBeNull();
    expect(screen.getByText(/建立模型需要 Training 權限/)).toBeInTheDocument();
  });

  it('F5 the version picker shows an old version summary and says the items are the current content', async () => {
    studyLabel('abnormal');
    studyLabel('normal', MOCK_STUDIES[1]);
    labelingMock().datasets.push({
      id: 78, project_id: 1, name: '胸部標註', task: 'classification', scope_id: null, classes: [], created_by: 'pi01',
      created_at: '2026-09-29T00:00:00Z',
      versions: [{ version: 1, created_at: '2026-10-01T08:00:00Z', created_by: 'pi01', annotations: 1, by_class: { abnormal: 1 }, members: [] }],
    } as never);
    const { user } = await renderArea('/labeling/datasets/78', 'ra01');
    const summary = await screen.findByTestId('dataset-summary');
    expect(summary).toHaveTextContent('胸部標註・目前內容');
    const picker = screen.getByLabelText('版本');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(picker, '1');
    await waitFor(() => expect(screen.getByTestId('dataset-summary')).toHaveTextContent('胸部標註・第 1 版'));
    expect(screen.getByTestId('dataset-summary')).toHaveTextContent('2026-10-01 08:00（pi01）');
    expect(within(screen.getByTestId('dataset-summary')).getByRole('list', { name: '類別統計' })).toHaveTextContent('abnormal1（100.0%）');
    expect(screen.getByText(/下方明細是目前內容/)).toBeInTheDocument();
    // 明細仍是目前內容（2 筆）
    expect(within(screen.getByRole('table', { name: '資料集內的標註' })).getAllByRole('row')).toHaveLength(3);
  });

  it('繼續確認 opens the first draft of the dataset in the workbench', async () => {
    studyLabel('abnormal');
    studyLabel('nodule', MOCK_STUDIES[2], { source: 'autolabel', status: 'draft' });
    labelingMock().datasets.push({
      id: 79, project_id: 1, name: '待確認測試', task: 'classification', scope_id: null, classes: [], created_by: 'pi01',
      created_at: '2026-09-29T00:00:00Z', versions: [],
    } as never);
    const { user } = await renderArea('/labeling/datasets/79', 'ra01');
    await screen.findByRole('table', { name: '資料集內的標註' });
    await user.click(screen.getByRole('button', { name: '繼續確認' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(`/labeling/studies/${MOCK_STUDIES[2].study_instance_uid}?annotation=2`),
    );
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
    // 設計稿 A03 的工具列
    for (const name of ['移動', '放大', '窗位', '圈選', '塗抹', '復原', '更多工具']) {
      expect(within(toolbar).getByRole('button', { name })).toBeInTheDocument();
    }
    // 器官窗與 WW/WL 收在「窗位」選單
    await user.click(within(toolbar).getByRole('button', { name: '窗位' }));
    const presets = within(within(toolbar).getByRole('group', { name: '器官窗' })).getAllByRole('button');
    expect(presets.length).toBeGreaterThanOrEqual(3);

    await user.click(within(toolbar).getByRole('button', { name: '肺窗' }));
    await status('肺窗：窗寬 1500、窗位 -600');
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-window-width', '1500');
    expect(within(toolbar).getByRole('button', { name: '肺窗' })).toHaveAttribute('aria-pressed', 'true');

    // 排列、旋轉收在「更多工具」
    await user.click(within(toolbar).getByRole('button', { name: '更多工具' }));
    expect(within(toolbar).queryByRole('group', { name: '器官窗' })).toBeNull();
    await user.click(within(toolbar).getByRole('button', { name: '向右轉 90°' }));
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-rotation', '90');
    await user.click(within(toolbar).getByRole('button', { name: '向左轉 90°' }));
    await user.click(within(toolbar).getByRole('button', { name: '向左轉 90°' }));
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-rotation', '270');

    await user.click(within(toolbar).getByRole('button', { name: '2×2' }));
    expect(screen.getByTestId('viewport-grid')).toHaveAttribute('data-layout', '2x2');
    expect(screen.getAllByTestId('viewport')).toHaveLength(3); // 這個序列只有 3 張

    await user.click(within(toolbar).getByRole('button', { name: '窗位' }));
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
    await user.click(screen.getByRole('button', { name: '只儲存' }));
    await status('已儲存分類標註 #1：pneumonia');
    // 分類預設是整個研究，並且直接標在影像左上角
    expect(await screen.findByRole('list', { name: '這張影像的分類標註' })).toHaveTextContent('整個研究：pneumonia');

    await user.click(within(screen.getByRole('group', { name: '標註種類' })).getByRole('button', { name: /偵測/ }));
    const form = screen.getByRole('form', { name: '以座標新增框' });
    for (const [name, value] of [['x1', '4'], ['y1', '6'], ['x2', '20'], ['y2', '30']]) {
      await user.type(within(form).getByLabelText(name), value);
    }
    await user.click(within(form).getByRole('button', { name: '新增框' }));
    expect(within(screen.getByRole('list', { name: '草稿中的框' })).getByText('[4, 6, 20, 30]')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '只儲存' }));
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
    await user.click(within(screen.getByRole('group', { name: '標註種類' })).getByRole('button', { name: /偵測/ }));
    const form = screen.getByRole('form', { name: '以座標新增框' });
    for (const [name, value] of [['x1', '4'], ['y1', '6'], ['x2', '70'], ['y2', '30']]) {
      await user.type(within(form).getByLabelText(name), value);
    }
    await user.click(within(form).getByRole('button', { name: '新增框' }));
    await status('0 ≤ x1 < x2 ≤ 64');
    expect(screen.getByRole('button', { name: '只儲存' })).toBeDisabled();
  });

  it('TC-B02-03 rating is saved and shown again after reload; pressing it again clears it', async () => {
    const { user, unmount } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(screen.getByRole('button', { name: '只儲存' }));
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
    expect(screen.getByRole('button', { name: '只儲存' })).toBeDisabled();
    await user.type(screen.getByLabelText('標籤'), 'normal');
    await user.click(screen.getByLabelText('這張影像'));
    await user.click(screen.getByRole('button', { name: '只儲存' }));
    await status('已儲存分類標註 #1：normal');
    expect(await screen.findByRole('list', { name: '這張影像的分類標註' })).toHaveTextContent('這張影像：normal');
    expect(labelingMock().annotations[0].sop_instance_uid).not.toBeNull();
  });

  it('warns before leaving the page with an unsaved box', async () => {
    const { user } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(within(screen.getByRole('group', { name: '標註種類' })).getByRole('button', { name: /偵測/ }));
    const form = screen.getByRole('form', { name: '以座標新增框' });
    for (const [name, value] of [['x1', '4'], ['y1', '6'], ['x2', '20'], ['y2', '30']]) {
      await user.type(within(form).getByLabelText(name), value);
    }
    await user.click(within(form).getByRole('button', { name: '新增框' }));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('link', { name: '← 回待處理清單' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('尚未儲存的標註'));
    expect(screen.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('edits and deletes an annotation', async () => {
    const { user } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(screen.getByRole('button', { name: '只儲存' }));
    await status('已儲存分類標註 #1');
    await user.click(await screen.findByRole('button', { name: '編輯標註 #1' }));
    await user.clear(screen.getByLabelText('標籤'));
    await user.type(screen.getByLabelText('標籤'), 'normal');
    await user.click(screen.getByRole('button', { name: '只儲存' }));
    await status('已更新分類標註 #1：normal（版本 2）');
    await user.click(screen.getByRole('button', { name: '刪除標註 #1' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '刪除' }));
    await status('已刪除標註 #1');
    expect(labelingMock().annotations).toHaveLength(0);
  });

  it('A03 slice strip switches images, undo removes the last box, and the panel shows the state', async () => {
    const { user } = await openWorkbench();
    const strip = screen.getByRole('navigation', { name: '影像序列' });
    expect(within(strip).getAllByRole('button', { name: /^切換到第 \d+ 張$/ })).toHaveLength(3);
    await user.click(within(strip).getByRole('button', { name: '切換到第 2 張' }));
    await waitFor(() => expect(screen.getByTestId('image-position')).toHaveTextContent('第 2 / 3 張'));
    expect(within(strip).getByRole('button', { name: '切換到第 2 張' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('annotation-state')).toHaveTextContent('尚未標註');

    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(within(screen.getByRole('toolbar', { name: '檢視工具列' })).getByRole('button', { name: '圈選' }));
    expect(screen.getByRole('button', { name: '畫框工具' })).toHaveAttribute('aria-pressed', 'true');
    for (const box of [['4', '6', '20', '30'], ['1', '1', '5', '5']]) {
      const form = screen.getByRole('form', { name: '以座標新增框' });
      for (const [i, name] of ['x1', 'y1', 'x2', 'y2'].entries()) {
        await user.clear(within(form).getByLabelText(name));
        await user.type(within(form).getByLabelText(name), box[i]);
      }
      await user.click(within(form).getByRole('button', { name: '新增框' }));
    }
    expect(within(screen.getByRole('list', { name: '草稿中的框' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('annotation-state')).toHaveTextContent('尚未儲存');

    // 有沒存的框時不能換張
    await user.click(within(strip).getByRole('button', { name: '切換到第 1 張' }));
    await status('尚未儲存的標註');
    expect(screen.getByTestId('image-position')).toHaveTextContent('第 2 / 3 張');

    await user.click(screen.getByRole('button', { name: '復原' }));
    await status('已復原上一步');
    expect(within(screen.getByRole('list', { name: '草稿中的框' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('list', { name: '草稿中的框' })).toHaveTextContent('[4, 6, 20, 30]');
  });

  it('zoom from 更多工具 and 重設檢視; 顯示標註範圍 hides the classification badges', async () => {
    const { user } = await openWorkbench();
    await user.type(screen.getByLabelText('標籤'), 'nodule');
    await user.click(screen.getByRole('button', { name: '只儲存' }));
    await status('已儲存分類標註 #1');
    expect(await screen.findByRole('list', { name: '這張影像的分類標註' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: '顯示標註範圍' }));
    expect(screen.queryByRole('list', { name: '這張影像的分類標註' })).toBeNull();

    const toolbar = screen.getByRole('toolbar', { name: '檢視工具列' });
    await user.click(within(toolbar).getByRole('button', { name: '更多工具' }));
    await user.click(within(toolbar).getByRole('button', { name: '放大一級' }));
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-zoom', '1.50');
    await user.click(within(toolbar).getByRole('button', { name: '重設檢視' }));
    expect(screen.getAllByTestId('viewport')[0]).toHaveAttribute('data-zoom', '1.00');
    // 進階檢視保留 OHIF 連結
    expect(screen.getByRole('link', { name: /進階檢視/ })).toHaveAttribute('href', expect.stringContaining('StudyInstanceUIDs='));
  });

  it('a study outside the project shows a clear message', async () => {
    await renderArea('/labeling/studies/1.2.3.404', 'md01');
    expect(await screen.findByText('你沒有權限檢視這個研究，或研究不在本專案的 Accession 清單內')).toBeInTheDocument();
  });
});

describe('auto labeling', () => {
  it('TC-B03-01 / TC-B03-03 submits, stores, and opens the result for editing', async () => {
    const { user, unmount } = await renderArea('/labeling/auto', 'md01');
    await screen.findByRole('heading', { level: 1, name: '影像標註' });
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
    await status('編輯標註 #1（偵測，自動標註，待確認');
    const boxes = within(screen.getByRole('list', { name: '草稿中的框' })).getAllByRole('listitem');
    expect(boxes).toHaveLength(2);
    await opened.user.click(screen.getByRole('button', { name: '刪除第 2 個框' }));
    await opened.user.click(screen.getByRole('button', { name: '只儲存' }));
    await status('已儲存偵測標註 #1（1 個框，版本 2）');
    expect(labelingMock().annotations[0]).toMatchObject({ source: 'autolabel', version: 2, autolabel_run_id: 1, status: 'confirmed', confirmed_by: 'md01' });
  });

  it('TC-B03-05 shows the service error and stores nothing when the service is offline', async () => {
    const { user } = await renderArea('/labeling/auto', 'md01');
    await waitFor(() => expect(screen.getByLabelText('影像')).not.toBeDisabled());
    labelingMock().autolabelOffline = true;
    await user.click(screen.getByRole('button', { name: '送出自動標註' }));
    expect(await screen.findByText('自動標註服務目前無法連線，請稍後再試')).toBeInTheDocument();
    expect(labelingMock().annotations).toHaveLength(0);
    expect(labelingMock().runs).toHaveLength(0);
  });
});

describe('workbench: pending flow', () => {
  it('儲存並開啟下一筆 saves and opens the next pending study', async () => {
    const { user } = await openWorkbench('ra01');
    await user.type(screen.getByLabelText('標籤'), 'normal');
    await user.click(screen.getByRole('button', { name: '儲存並開啟下一筆' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/labeling/studies/${MOCK_STUDIES[1].study_instance_uid}`));
    expect(labelingMock().annotations[0]).toMatchObject({ study_instance_uid: STUDY.study_instance_uid, status: 'confirmed', payload: { label: 'normal' } });
  });

  it('an autolabel draft shows 待確認 and the 確認 button confirms it', async () => {
    studyLabel('nodule', STUDY, { source: 'autolabel', status: 'draft', confirmed_by: null, confirmed_at: null });
    const { user } = await openWorkbench('ra01');
    const table = await screen.findByRole('table', { name: '標註清單' });
    expect(within(table).getByRole('row', { name: /#1.*自動標註.*待確認/ })).toBeInTheDocument();
    expect(screen.getByTestId('annotation-state')).toHaveTextContent('自動標註・待確認');
    await user.click(screen.getByRole('button', { name: '確認標註 #1' }));
    await status('已確認標註 #1');
    await waitFor(() => expect(screen.getByTestId('annotation-state')).toHaveTextContent('自動標註・已確認'));
    expect(labelingMock().annotations[0]).toMatchObject({ status: 'confirmed', confirmed_by: 'ra01' });
    await waitFor(() => expect(screen.queryByRole('button', { name: '確認標註 #1' })).toBeNull());
  });
});
