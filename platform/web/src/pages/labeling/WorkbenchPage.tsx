// 影像標註工作台：檢視工具列（排列、旋轉、WW/WC、器官窗）、快捷鍵、三種標註、評分。
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ohifUrl, useLabelingApi, type LabelingApi } from './api';
import { colorIndexes } from './colors';
import type { InstanceInfo } from './dicomweb';
import {
  LAYOUTS,
  LAYOUT_LABELS,
  WINDOW_PRESETS,
  labelValue,
  layoutCells,
  nextLayout,
  paintDisc,
  rleDecode,
  rleEncode,
  rotate,
  usedLabels,
  type Layout,
  type Rotation,
  type WindowSetting,
} from './imaging';
import { DEFAULT_LABELS, LabelPicker, Legend, Rating } from './parts';
import {
  KIND_LABELS,
  SOURCE_LABELS,
  isClassification,
  isDetection,
  isSegmentation,
  type Annotation,
  type AnnotationKind,
  type DetectionBox,
} from './types';
import { useHotkeys, type Hotkey } from './useHotkeys';
import { Viewport, type Overlay, type Tool } from './Viewport';
import './labeling.css';

export const HOTKEYS: Hotkey[] = [
  { keys: '1 2 3 4 5', description: '套用器官窗（軟組織、肺、骨、腦、腹部）' },
  { keys: 'R L', description: '向右、向左旋轉 90 度' },
  { keys: '↑ ↓', description: '上一張、下一張' },
  { keys: 'G', description: '切換排列（1×1 → 1×2 → 2×2）' },
  { keys: 'C B D', description: '標註工具：分類、分割筆刷、偵測畫框' },
  { keys: 'I', description: '反相' },
  { keys: '空白鍵', description: '重設檢視' },
  { keys: 'Esc', description: '放下標註工具' },
  { keys: 'Ctrl+S', description: '儲存目前的標註' },
];

interface BoxDraft {
  editingId: number | null;
  shape: [number, number];
  boxes: DetectionBox[];
  dirty: boolean;
}

interface MaskDraft {
  editingId: number | null;
  shape: [number, number];
  mask: Uint8Array;
  labelNames: Record<string, number>;
  revision: number;
  dirty: boolean;
}

interface ClassDraft {
  editingId: number | null;
  scope: 'image' | 'study';
}

function labelsText(a: Annotation): string {
  if (isClassification(a)) return a.payload.label;
  if (isDetection(a)) return a.payload.boxes.map((b) => b.label).join('、');
  if (isSegmentation(a)) {
    const used = new Set(a.payload.rle.map(([v]) => v));
    return Object.entries(a.payload.label_names)
      .filter(([, v]) => v !== 0 && used.has(v))
      .map(([k]) => k)
      .join('、');
  }
  return '';
}

export function WorkbenchPage() {
  const { studyUid = '' } = useParams();
  const [search] = useSearchParams();
  const labeling = useLabelingApi();
  if (!labeling) return <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>;
  const open = Number(search.get('annotation')) || null;
  return <Workbench key={`${labeling.projectId}/${studyUid}`} labeling={labeling} studyUid={studyUid} openAnnotation={open} />;
}

function Workbench({ labeling, studyUid, openAnnotation }: { labeling: LabelingApi; studyUid: string; openAnnotation: number | null }) {
  const { project } = useSession();
  const canTrain = project?.permissions.includes('training') ?? false;

  // ---------- 資料 ----------
  const series = useResource(() => labeling.dicomweb.series(studyUid), [labeling, studyUid]);
  const [seriesUid, setSeriesUid] = useState<string | null>(null);
  const currentSeries = seriesUid ?? series.data?.[0]?.seriesInstanceUid ?? null;
  const instances = useResource<InstanceInfo[]>(
    () => (currentSeries ? labeling.dicomweb.instances(studyUid, currentSeries) : Promise.resolve([])),
    [labeling, studyUid, currentSeries],
  );
  const annotations = useResource(() => labeling.list({ studyUid }), [labeling, studyUid]);
  const summary = useResource(() => labeling.summary(), [labeling]);

  // ---------- 檢視狀態 ----------
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<Layout>('1x1');
  const [rotation, setRotation] = useState<Rotation>(0);
  const [windowSetting, setWindowSetting] = useState<WindowSetting | null>(null);
  const [shownWindow, setShownWindow] = useState<WindowSetting | null>(null);
  const [invert, setInvert] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);

  // ---------- 標註狀態 ----------
  const [mode, setMode] = useState<AnnotationKind>('classification');
  const [tool, setTool] = useState<Tool>('none');
  const [label, setLabel] = useState(DEFAULT_LABELS[0]);
  const [brush, setBrush] = useState(3);
  const [classDraft, setClassDraft] = useState<ClassDraft>({ editingId: null, scope: 'image' });
  const [boxDraft, setBoxDraft] = useState<BoxDraft | null>(null);
  const [maskDraft, setMaskDraft] = useState<MaskDraft | null>(null);
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const [deleting, setDeleting] = useState<Annotation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [opened, setOpened] = useState(false);

  const list = instances.data ?? [];
  const current: InstanceInfo | undefined = list[Math.min(index, Math.max(0, list.length - 1))];
  const dirty = Boolean(boxDraft?.dirty || maskDraft?.dirty);
  const all = annotations.data ?? [];

  const ok = (text: string) => {
    setError(null);
    setMessage(text);
  };

  const goTo = useCallback(
    (next: number) => {
      if (list.length === 0) return;
      const target = Math.min(list.length - 1, Math.max(0, next));
      if (target === index) return;
      if (dirty) {
        setMessage('目前影像有尚未儲存的標註，請先儲存或捨棄草稿再換張。');
        return;
      }
      setBoxDraft(null);
      setMaskDraft(null);
      setIndex(target);
      setMessage(`第 ${target + 1} / ${list.length} 張`);
    },
    [list.length, index, dirty],
  );

  function applyWindow(w: WindowSetting, name?: string) {
    const clean = { center: Math.round(w.center), width: Math.max(1, Math.round(w.width)) };
    setWindowSetting(clean);
    setShownWindow(clean);
    setMessage(`${name ? `${name}：` : ''}窗寬 ${clean.width}、窗位 ${clean.center}`);
  }

  function turn(direction: 'cw' | 'ccw') {
    setRotation((r) => {
      const next = rotate(r, direction);
      setMessage(`旋轉 ${next} 度`);
      return next;
    });
  }

  function changeLayout(next: Layout) {
    setLayout(next);
    setMessage(`排列 ${LAYOUT_LABELS[next]}`);
  }

  function resetView() {
    setRotation(0);
    setInvert(false);
    setWindowSetting(null);
    setShownWindow(null);
    setLayout('1x1');
    setMessage('已重設檢視');
  }

  function pick(kind: AnnotationKind) {
    setMode(kind);
    setTool(kind === 'detection' ? 'box' : kind === 'segmentation' ? 'brush' : 'none');
    setMessage(`標註工具：${KIND_LABELS[kind]}`);
  }

  // ---------- 草稿 ----------
  function ensureBoxDraft(): BoxDraft | null {
    if (!current) return null;
    return boxDraft ?? { editingId: null, shape: [current.rows, current.columns], boxes: [], dirty: false };
  }

  function addBox(box: [number, number, number, number]) {
    const text = label.trim();
    if (!text) {
      setMessage('請先填寫標籤再畫框。');
      return;
    }
    const draft = ensureBoxDraft();
    if (!draft) return;
    setBoxDraft({ ...draft, boxes: [...draft.boxes, { label: text, box }], dirty: true });
    setMessage(`新增框 ${text} [${box.join(', ')}]`);
  }

  function paint(x: number, y: number) {
    if (!current) return;
    const erase = tool === 'erase';
    const text = label.trim();
    if (!erase && !text) {
      setMessage('請先填寫標籤再塗抹。');
      return;
    }
    setMaskDraft((draft) => {
      const base: MaskDraft = draft ?? {
        editingId: null,
        shape: [current.rows, current.columns],
        mask: new Uint8Array(current.rows * current.columns),
        labelNames: { background: 0 },
        revision: 0,
        dirty: false,
      };
      const [names, value] = erase ? [base.labelNames, 0] : labelValue(base.labelNames, text);
      // 這個函式在開發模式會被 React 呼叫兩次，所以不能改到原本的遮罩，要複製一份再塗
      const mask = base.mask.slice();
      if (!paintDisc(mask, base.shape[1], base.shape[0], x, y, brush, value)) return draft;
      return { ...base, mask, labelNames: names, revision: base.revision + 1, dirty: true };
    });
  }

  function discard() {
    setBoxDraft(null);
    setMaskDraft(null);
    setClassDraft({ editingId: null, scope: 'image' });
    setTool('none');
    ok('已捨棄草稿');
  }

  const edit = useCallback(
    (a: Annotation) => {
      const at = a.sop_instance_uid ? list.findIndex((i) => i.sopInstanceUid === a.sop_instance_uid) : index;
      if (a.sop_instance_uid && at < 0) {
        setMessage('這筆標註的影像不在目前的序列。');
        return;
      }
      setBoxDraft(null);
      setMaskDraft(null);
      if (at >= 0) setIndex(at);
      setMode(a.kind);
      if (isClassification(a)) {
        setLabel(a.payload.label);
        setClassDraft({ editingId: a.id, scope: a.sop_instance_uid ? 'image' : 'study' });
        setTool('none');
      } else if (isDetection(a)) {
        setBoxDraft({ editingId: a.id, shape: a.payload.shape, boxes: a.payload.boxes.map((b) => ({ ...b })), dirty: false });
        setTool('box');
      } else if (isSegmentation(a)) {
        const [h, w] = a.payload.shape;
        setMaskDraft({
          editingId: a.id,
          shape: a.payload.shape,
          mask: rleDecode(a.payload.rle, h * w),
          labelNames: { ...a.payload.label_names },
          revision: 0,
          dirty: false,
        });
        setTool('brush');
      }
      setError(null);
      setMessage(`編輯標註 #${a.id}（${KIND_LABELS[a.kind]}，${SOURCE_LABELS[a.source]}）`);
    },
    [list, index],
  );

  // 從自動標註頁帶 ?annotation=<id> 進來時，資料載入後直接開啟編輯
  useEffect(() => {
    if (opened || !openAnnotation || list.length === 0 || !annotations.data) return;
    setOpened(true);
    const target = annotations.data.find((a) => a.id === openAnnotation);
    if (target) edit(target);
    else setMessage(`找不到標註 #${openAnnotation}`);
  }, [opened, openAnnotation, list.length, annotations.data, edit]);

  // ---------- 儲存 ----------
  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      const text = await action();
      annotations.reload();
      summary.reload();
      setMessage(text);
    } catch (e) {
      setError(e);
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  const target = (scope: 'image' | 'study') =>
    scope === 'image' && current
      ? { study_instance_uid: studyUid, series_instance_uid: current.seriesInstanceUid, sop_instance_uid: current.sopInstanceUid }
      : { study_instance_uid: studyUid };

  function saveClassification() {
    const text = label.trim();
    if (!text) return setMessage('請先填寫標籤。');
    return run(async () => {
      if (classDraft.editingId !== null) {
        const a = await labeling.update(classDraft.editingId, { label: text });
        setClassDraft({ editingId: null, scope: 'image' });
        return `已更新分類標註 #${a.id}：${text}（版本 ${a.version}）`;
      }
      const a = await labeling.create({ ...target(classDraft.scope), kind: 'classification', payload: { label: text } });
      return `已儲存分類標註 #${a.id}：${text}`;
    });
  }

  function saveDetection() {
    if (!boxDraft || boxDraft.boxes.length === 0) return setMessage('還沒有畫任何框。');
    const payload = { shape: boxDraft.shape, box_format: 'xyxy' as const, boxes: boxDraft.boxes };
    return run(async () => {
      const a =
        boxDraft.editingId !== null
          ? await labeling.update(boxDraft.editingId, payload)
          : await labeling.create({ ...target('image'), kind: 'detection', payload });
      setBoxDraft(null);
      return `已儲存偵測標註 #${a.id}（${payload.boxes.length} 個框，版本 ${a.version}）`;
    });
  }

  function saveSegmentation() {
    if (!maskDraft || !maskDraft.mask.some((v) => v !== 0)) return setMessage('遮罩是空的，請先用筆刷塗抹。');
    const payload = {
      shape: maskDraft.shape,
      encoding: 'rle' as const,
      rle: rleEncode(maskDraft.mask),
      label_names: maskDraft.labelNames,
    };
    return run(async () => {
      const a =
        maskDraft.editingId !== null
          ? await labeling.update(maskDraft.editingId, payload)
          : await labeling.create({ ...target('image'), kind: 'segmentation', payload });
      setMaskDraft(null);
      return `已儲存分割標註 #${a.id}（${usedLabels(maskDraft.mask, maskDraft.labelNames).join('、')}，版本 ${a.version}）`;
    });
  }

  function saveCurrent() {
    if (busy) return;
    if (mode === 'classification') void saveClassification();
    else if (mode === 'detection') void saveDetection();
    else void saveSegmentation();
  }

  useHotkeys({
    ...Object.fromEntries(WINDOW_PRESETS.map((p) => [p.hotkey, () => applyWindow(p, p.label)])),
    r: () => turn('cw'),
    l: () => turn('ccw'),
    arrowup: () => goTo(index - 1),
    arrowdown: () => goTo(index + 1),
    g: () => changeLayout(nextLayout(layout)),
    c: () => pick('classification'),
    b: () => pick('segmentation'),
    d: () => pick('detection'),
    i: () => {
      setInvert((v) => !v);
      setMessage(invert ? '取消反相' : '反相');
    },
    space: resetView,
    escape: () => {
      setTool('none');
      setMessage('已放下標註工具');
    },
    'ctrl+s': saveCurrent,
  });

  // ---------- 顯示 ----------
  const labelOptions = useMemo(() => {
    const fromProject = Object.values(summary.data?.labels ?? {}).flatMap((m) => Object.keys(m));
    const fromStudy = all.flatMap((a) => labelsText(a).split('、').filter(Boolean));
    const fromDraft = [...(boxDraft?.boxes.map((b) => b.label) ?? []), ...Object.keys(maskDraft?.labelNames ?? {})];
    return [...new Set([...DEFAULT_LABELS, ...fromProject, ...fromStudy, ...fromDraft])].filter((l) => l !== 'background').sort();
  }, [summary.data, all, boxDraft, maskDraft]);
  const colorOf = useMemo(() => colorIndexes(labelOptions), [labelOptions]);

  const overlaysFor = useCallback(
    (instance: InstanceInfo, cell: number): Overlay[] => {
      const editing = new Set([boxDraft?.editingId, maskDraft?.editingId].filter((v): v is number => typeof v === 'number'));
      const out: Overlay[] = [];
      if (showAnnotations) {
        for (const a of all) {
          if (a.sop_instance_uid !== instance.sopInstanceUid || editing.has(a.id)) continue;
          if (isDetection(a)) out.push({ id: `a${a.id}v${a.version}`, shape: a.payload.shape, boxes: a.payload.boxes });
          if (isSegmentation(a)) {
            const [h, w] = a.payload.shape;
            out.push({ id: `a${a.id}v${a.version}`, shape: a.payload.shape, mask: rleDecode(a.payload.rle, h * w), labelNames: a.payload.label_names });
          }
        }
      }
      if (cell === 0) {
        if (maskDraft) out.push({ id: 'mask-draft', shape: maskDraft.shape, mask: maskDraft.mask, labelNames: maskDraft.labelNames, revision: maskDraft.revision, draft: true });
        if (boxDraft) out.push({ id: 'box-draft', shape: boxDraft.shape, boxes: boxDraft.boxes, draft: true });
      }
      return out;
    },
    [all, showAnnotations, boxDraft, maskDraft],
  );

  const cells = list.slice(index, index + layoutCells(layout));
  const shown = onlyCurrent && current ? all.filter((a) => a.sop_instance_uid === current.sopInstanceUid || a.sop_instance_uid === null) : all;
  const imageNo = (a: Annotation) => {
    if (!a.sop_instance_uid) return '整個研究';
    const at = list.findIndex((i) => i.sopInstanceUid === a.sop_instance_uid);
    return at >= 0 ? `第 ${at + 1} 張` : '其他序列';
  };

  function submitWindow(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const width = Number(form.get('ww'));
    const center = Number(form.get('wl'));
    if (!Number.isFinite(width) || !Number.isFinite(center) || width < 1) {
      setMessage('窗寬必須是大於 0 的數字，窗位必須是數字。');
      return;
    }
    applyWindow({ center, width });
  }

  function submitBox(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const draft = ensureBoxDraft();
    if (!draft) return;
    const form = new FormData(e.currentTarget);
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(form.get(k)));
    const [h, w] = draft.shape;
    if (![x1, y1, x2, y2].every(Number.isInteger) || !(0 <= x1 && x1 < x2 && x2 <= w && 0 <= y1 && y1 < y2 && y2 <= h)) {
      setMessage(`框的座標必須是整數，且 0 ≤ x1 < x2 ≤ ${w}、0 ≤ y1 < y2 ≤ ${h}。`);
      return;
    }
    addBox([x1, y1, x2, y2]);
    e.currentTarget.reset();
  }

  const loadError = series.error ?? instances.error;
  const display = windowSetting ?? shownWindow;

  return (
    <>
      <h1>影像標註工作台</h1>
      <p className="text-muted">
        <Link to="/labeling">← 回研究清單</Link>　研究 <span className="mono">{studyUid}</span>
        　
        <a href={ohifUrl(labeling.projectId, studyUid)} target="_blank" rel="noreferrer">
          在 OHIF 檢視器開啟（新分頁）
        </a>
      </p>
      {loadError ? (
        <Alert tone="error" title="無法載入影像">
          {loadError instanceof Error ? loadError.message : '影像服務沒有回應'}
        </Alert>
      ) : null}
      <ApiErrorAlert error={error ?? annotations.error} />
      <p className="viewer-status" role="status" aria-live="polite" data-testid="workbench-status">
        {message}
      </p>

      <div className="workbench">
        <section aria-label="影像檢視">
          <div className="viewer-toolbar card" role="toolbar" aria-label="檢視工具列">
            <fieldset className="viewer-toolbar__group">
              <legend>排列</legend>
              {LAYOUTS.map((l) => (
                <button key={l} type="button" className="btn btn--small btn--secondary" aria-pressed={layout === l} onClick={() => changeLayout(l)}>
                  {LAYOUT_LABELS[l]}
                </button>
              ))}
            </fieldset>
            <fieldset className="viewer-toolbar__group">
              <legend>旋轉</legend>
              <button type="button" className="btn btn--small btn--secondary" onClick={() => turn('ccw')}>
                向左轉 90°
              </button>
              <button type="button" className="btn btn--small btn--secondary" onClick={() => turn('cw')}>
                向右轉 90°
              </button>
            </fieldset>
            <fieldset className="viewer-toolbar__group">
              <legend>器官窗</legend>
              {WINDOW_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="btn btn--small btn--secondary"
                  aria-pressed={windowSetting?.center === p.center && windowSetting?.width === p.width}
                  onClick={() => applyWindow(p, p.label)}
                >
                  {p.label}
                </button>
              ))}
            </fieldset>
            <form className="viewer-toolbar__group" aria-label="窗寬窗位" onSubmit={submitWindow} key={`${display?.width}/${display?.center}`}>
              <div className="field">
                <label htmlFor="ww">窗寬 WW</label>
                <input id="ww" name="ww" className="input" type="number" min={1} step={1} defaultValue={display?.width ?? ''} />
              </div>
              <div className="field">
                <label htmlFor="wl">窗位 WL</label>
                <input id="wl" name="wl" className="input" type="number" step={1} defaultValue={display?.center ?? ''} />
              </div>
              <button type="submit" className="btn btn--small btn--secondary">
                套用
              </button>
            </form>
            <fieldset className="viewer-toolbar__group">
              <legend>其他</legend>
              <button type="button" className="btn btn--small btn--secondary" aria-pressed={invert} onClick={() => setInvert((v) => !v)}>
                反相
              </button>
              <button type="button" className="btn btn--small btn--secondary" aria-pressed={showAnnotations} onClick={() => setShowAnnotations((v) => !v)}>
                顯示標註
              </button>
              <button type="button" className="btn btn--small btn--secondary" onClick={resetView}>
                重設
              </button>
            </fieldset>
            <fieldset className="viewer-toolbar__group">
              <legend>換張</legend>
              <button type="button" className="btn btn--small btn--secondary" disabled={index <= 0} onClick={() => goTo(index - 1)}>
                上一張
              </button>
              <span data-testid="image-position">
                第 {list.length ? index + 1 : 0} / {list.length} 張
              </span>
              <button type="button" className="btn btn--small btn--secondary" disabled={index >= list.length - 1} onClick={() => goTo(index + 1)}>
                下一張
              </button>
            </fieldset>
            {(series.data?.length ?? 0) > 1 ? (
              <div className="field">
                <label htmlFor="series">序列</label>
                <select
                  id="series"
                  className="select"
                  value={currentSeries ?? ''}
                  disabled={dirty}
                  onChange={(e) => {
                    setSeriesUid(e.target.value);
                    setIndex(0);
                  }}
                >
                  {series.data!.map((s) => (
                    <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>
                      {s.modality} {s.description}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          {instances.loading || series.loading ? (
            <p role="status" className="loading">
              影像載入中…
            </p>
          ) : list.length === 0 && !loadError ? (
            <Alert tone="info">這個研究沒有可顯示的影像。</Alert>
          ) : (
            <div className={`viewport-grid viewport-grid--${layout}`} data-testid="viewport-grid" data-layout={layout}>
              {cells.map((instance, cell) => (
                <Viewport
                  key={instance.sopInstanceUid}
                  dicomweb={labeling.dicomweb}
                  studyUid={studyUid}
                  instance={instance}
                  position={`${index + cell + 1} / ${list.length}`}
                  window={windowSetting}
                  rotation={rotation}
                  invert={invert}
                  overlays={overlaysFor(instance, cell)}
                  colorOf={colorOf}
                  active={cell === 0}
                  tool={cell === 0 ? tool : 'none'}
                  draftShape={(mode === 'segmentation' ? maskDraft?.shape : boxDraft?.shape) ?? undefined}
                  onBox={addBox}
                  onPaint={paint}
                  onWindow={setShownWindow}
                />
              ))}
            </div>
          )}
          <Legend colorOf={colorOf} />

          <details className="section hotkeys">
            <summary>快捷鍵</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">按鍵</th>
                    <th scope="col">動作</th>
                  </tr>
                </thead>
                <tbody>
                  {HOTKEYS.map((h) => (
                    <tr key={h.keys}>
                      <td>
                        {h.keys.split(' ').map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                      </td>
                      <td>{h.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>

        <section aria-label="標註" className="stack">
          <div className="card section">
            <h2>標註（目前影像：第 {list.length ? index + 1 : 0} 張）</h2>
            <div className="tool-tabs" role="group" aria-label="標註種類">
              {(['classification', 'segmentation', 'detection'] as const).map((k) => (
                <button key={k} type="button" className="btn btn--small btn--secondary" aria-pressed={mode === k} onClick={() => pick(k)}>
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <LabelPicker value={label} options={labelOptions} onChange={setLabel} />

            {mode === 'classification' ? (
              <div className="stack">
                <fieldset className="field" disabled={classDraft.editingId !== null}>
                  <legend>標註對象</legend>
                  <label className="checkbox-row">
                    <input type="radio" name="scope" checked={classDraft.scope === 'image'} onChange={() => setClassDraft((d) => ({ ...d, scope: 'image' }))} />
                    這張影像
                  </label>
                  <label className="checkbox-row">
                    <input type="radio" name="scope" checked={classDraft.scope === 'study'} onChange={() => setClassDraft((d) => ({ ...d, scope: 'study' }))} />
                    整個研究
                  </label>
                </fieldset>
                {classDraft.editingId !== null ? <p className="field__hint">正在編輯標註 #{classDraft.editingId}</p> : null}
                <div className="row-actions">
                  <button type="button" className="btn btn--primary" disabled={busy || !current} onClick={() => void saveClassification()}>
                    儲存分類標註
                  </button>
                  {classDraft.editingId !== null ? (
                    <button type="button" className="btn btn--secondary" onClick={discard}>
                      取消編輯
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {mode === 'detection' ? (
              <div className="stack">
                <div className="row-actions">
                  <button type="button" className="btn btn--small btn--secondary" aria-pressed={tool === 'box'} onClick={() => setTool(tool === 'box' ? 'none' : 'box')}>
                    畫框工具
                  </button>
                </div>
                <p className="field__hint">選好標籤後，在影像上按住拖曳畫框；也可以在下方輸入座標。</p>
                <form aria-label="以座標新增框" onSubmit={submitBox}>
                  <div className="box-form">
                    {(['x1', 'y1', 'x2', 'y2'] as const).map((k) => (
                      <div className="field" key={k}>
                        <label htmlFor={`box-${k}`}>{k}</label>
                        <input id={`box-${k}`} name={k} className="input" type="number" step={1} min={0} required />
                      </div>
                    ))}
                  </div>
                  <button type="submit" className="btn btn--small btn--secondary" disabled={!current}>
                    新增框
                  </button>
                </form>
                <ul className="draft-list" aria-label="草稿中的框">
                  {(boxDraft?.boxes ?? []).map((b, i) => (
                    <li key={`${i}-${b.box.join('-')}`}>
                      <span>
                        {b.label} <span className="mono">[{b.box.join(', ')}]</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn--small btn--ghost"
                        aria-label={`刪除第 ${i + 1} 個框`}
                        onClick={() => setBoxDraft((d) => (d ? { ...d, boxes: d.boxes.filter((_, j) => j !== i), dirty: true } : d))}
                      >
                        刪除
                      </button>
                    </li>
                  ))}
                </ul>
                {boxDraft?.editingId ? <p className="field__hint">正在編輯標註 #{boxDraft.editingId}</p> : null}
                <div className="row-actions">
                  <button type="button" className="btn btn--primary" disabled={busy || !boxDraft || boxDraft.boxes.length === 0} onClick={() => void saveDetection()}>
                    儲存偵測標註
                  </button>
                  <button type="button" className="btn btn--secondary" disabled={!boxDraft} onClick={discard}>
                    捨棄草稿
                  </button>
                </div>
              </div>
            ) : null}

            {mode === 'segmentation' ? (
              <div className="stack">
                <div className="row-actions">
                  <button type="button" className="btn btn--small btn--secondary" aria-pressed={tool === 'brush'} onClick={() => setTool(tool === 'brush' ? 'none' : 'brush')}>
                    筆刷
                  </button>
                  <button type="button" className="btn btn--small btn--secondary" aria-pressed={tool === 'erase'} onClick={() => setTool(tool === 'erase' ? 'none' : 'erase')}>
                    橡皮擦
                  </button>
                </div>
                <div className="field">
                  <label htmlFor="brush">筆刷半徑（像素）</label>
                  <input id="brush" className="input" type="number" min={1} max={20} step={1} value={brush} onChange={(e) => setBrush(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
                </div>
                <p className="field__hint" data-testid="mask-info">
                  {maskDraft
                    ? `已塗 ${maskDraft.mask.reduce((n, v) => n + (v ? 1 : 0), 0)} 個像素：${usedLabels(maskDraft.mask, maskDraft.labelNames).join('、') || '（無）'}`
                    : '選好標籤後，在影像上按住拖曳塗抹。'}
                </p>
                {maskDraft?.editingId ? <p className="field__hint">正在編輯標註 #{maskDraft.editingId}</p> : null}
                <div className="row-actions">
                  <button type="button" className="btn btn--primary" disabled={busy || !maskDraft} onClick={() => void saveSegmentation()}>
                    儲存分割標註
                  </button>
                  <button type="button" className="btn btn--secondary" disabled={!maskDraft} onClick={discard}>
                    捨棄草稿
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="card section">
            <h2>這個研究的標註（{all.length} 筆）</h2>
            <label className="checkbox-row">
              <input type="checkbox" className="checkbox" checked={onlyCurrent} onChange={(e) => setOnlyCurrent(e.target.checked)} />
              只看目前影像與研究層級
            </label>
            {annotations.loading && !annotations.data ? (
              <p role="status" className="loading">
                載入中…
              </p>
            ) : shown.length === 0 ? (
              <p className="text-muted">還沒有標註。</p>
            ) : (
              <div className="table-wrap">
                <table aria-label="標註清單">
                  <thead>
                    <tr>
                      <th scope="col">編號</th>
                      <th scope="col">種類</th>
                      <th scope="col">對象</th>
                      <th scope="col">標籤</th>
                      <th scope="col">來源</th>
                      <th scope="col">版本</th>
                      <th scope="col">評分</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((a) => (
                      <tr key={a.id} data-annotation={a.id} data-kind={a.kind} data-source={a.source}>
                        <th scope="row">#{a.id}</th>
                        <td>{KIND_LABELS[a.kind]}</td>
                        <td>{imageNo(a)}</td>
                        <td>{labelsText(a)}</td>
                        <td>{SOURCE_LABELS[a.source]}</td>
                        <td>{a.version}</td>
                        <td>
                          <Rating
                            name={`標註 #${a.id}`}
                            value={a.rating}
                            disabled={busy}
                            onChange={(rating) =>
                              void run(async () => {
                                await labeling.rate(a.id, rating);
                                return rating === null ? `已清除標註 #${a.id} 的評分` : `標註 #${a.id} 評為 ${rating} 分`;
                              })
                            }
                          />
                        </td>
                        <td>
                          <div className="row-actions">
                            <button type="button" className="btn btn--small btn--secondary" aria-label={`編輯標註 #${a.id}`} disabled={dirty} onClick={() => edit(a)}>
                              編輯
                            </button>
                            <button type="button" className="btn btn--small btn--danger" aria-label={`刪除標註 #${a.id}`} onClick={() => setDeleting(a)}>
                              刪除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card section">
            <h2>下一步</h2>
            {canTrain ? (
              <p>
                <Link to="/labeling#training">以這個專案的標註建立訓練任務</Link>
              </p>
            ) : (
              <p className="text-muted">建立訓練任務需要 Training 權限；如需使用，請聯絡專案負責人。</p>
            )}
          </div>
        </section>
      </div>

      {deleting ? (
        <ConfirmDialog
          title={`刪除標註 #${deleting.id}`}
          confirmLabel="刪除"
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            void run(async () => {
              await labeling.remove(deleting.id);
              setDeleting(null);
              return `已刪除標註 #${deleting.id}`;
            })
          }
        >
          確定要刪除這筆{KIND_LABELS[deleting.kind]}標註嗎？刪除後無法復原。
        </ConfirmDialog>
      ) : null}
    </>
  );
}
