// 影像標註工作台（設計稿 A03）：頂部進度、左側切片條、中間影像與工具列、右側標註面板。
// 工具列：移動、放大、窗位（器官窗、WW/WL）、圈選、塗抹、復原、更多工具（排列、旋轉、反相、重設、快捷鍵）。
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge, Card, ProgressBar, Toggle } from '../../components/ui';
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
import { DEFAULT_LABELS, LabelPicker, Legend, Rating, formatDate } from './parts';
import { nextPendingStudy, progressOf, useScopeStudyUids, workbenchPath } from './pending';
import { SliceStrip } from './SliceStrip';
import { ToolIcon, type ToolIconName } from './ToolIcon';
import type { Badge as ViewportBadge } from './Viewport';
import {
  KIND_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  isDraft,
  isClassification,
  isDetection,
  isSegmentation,
  type Annotation,
  type AnnotationKind,
  type DetectionBox,
} from './types';
import { useHotkeys, type Hotkey } from './useHotkeys';
import { MAX_ZOOM, Viewport, type Overlay, type Tool } from './Viewport';
import './labeling.css';

export const HOTKEYS: Hotkey[] = [
  { keys: 'H Z W', description: '檢視工具：移動、放大、窗位（拖曳影像調整）' },
  { keys: 'Ctrl+Z', description: '復原上一步（畫框、塗抹）' },
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

/** 「復原」用：改動前的框與遮罩草稿 */
interface Snapshot {
  box: BoxDraft | null;
  mask: MaskDraft | null;
}
const UNDO_LIMIT = 20;

type Popover = 'window' | 'more' | null;

/** 右側面板分頁（設計稿：分類／圈位置／塗範圍），名稱後面帶原本的標註種類 */
const KIND_TABS: { kind: AnnotationKind; text: string; name: string }[] = [
  { kind: 'classification', text: '分類', name: '分類' },
  { kind: 'detection', text: '圈位置', name: '圈位置（偵測）' },
  { kind: 'segmentation', text: '塗範圍', name: '塗範圍（分割）' },
];

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
  const scopeId = Number(search.get('scope')) || null;
  return (
    <Workbench key={`${labeling.projectId}/${studyUid}`} labeling={labeling} studyUid={studyUid} openAnnotation={open} scopeId={scopeId} />
  );
}

function Workbench({
  labeling,
  studyUid,
  openAnnotation,
  scopeId,
}: {
  labeling: LabelingApi;
  studyUid: string;
  openAnnotation: number | null;
  /** 從待處理清單帶來的資料範圍；「下一筆」只在範圍內找 */
  scopeId: number | null;
}) {
  const navigate = useNavigate();
  const scopeUids = useScopeStudyUids(scopeId);
  const listPath = scopeId !== null ? `/labeling?scope=${scopeId}` : '/labeling';

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
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [popover, setPopover] = useState<Popover>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // ---------- 標註狀態 ----------
  const [mode, setMode] = useState<AnnotationKind>('classification');
  const [tool, setTool] = useState<Tool>('none');
  const [label, setLabel] = useState('');
  const [brush, setBrush] = useState(3);
  // 預設整個研究：訓練時研究內每張影像都會用到這個類別；只標這張影像的話，其他張會被略過
  const [classDraft, setClassDraft] = useState<ClassDraft>({ editingId: null, scope: 'study' });
  // 剛存好的分類（範圍＋影像＋類別）。內容沒變就不算要存，避免再按一次存出一筆一模一樣的標註
  const [savedClass, setSavedClass] = useState<string | null>(null);
  const [boxDraft, setBoxDraft] = useState<BoxDraft | null>(null);
  const [maskDraft, setMaskDraft] = useState<MaskDraft | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
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
      setHistory([]);
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
    setZoom(1);
    setPan([0, 0]);
    setMessage('已重設檢視');
  }

  function pick(kind: AnnotationKind) {
    setMode(kind);
    setTool(kind === 'detection' ? 'box' : kind === 'segmentation' ? 'brush' : 'none');
    setMessage(`標註工具：${KIND_LABELS[kind]}`);
  }

  const VIEW_TOOL_NAMES: Partial<Record<Tool, string>> = { pan: '移動', zoom: '放大', window: '窗位' };
  function pickViewTool(next: 'pan' | 'zoom' | 'window') {
    setTool(next);
    setMessage(`檢視工具：${VIEW_TOOL_NAMES[next]}（在影像上拖曳）`);
  }

  const changeZoom = useCallback((z: number) => {
    setZoom(z);
    if (z <= 1) setPan([0, 0]);
  }, []);

  const dragWindow = useCallback((w: WindowSetting) => {
    const clean = { center: Math.round(w.center), width: Math.max(1, Math.round(w.width)) };
    setWindowSetting(clean);
    setShownWindow(clean);
  }, []);

  // 點工具列以外的地方就收起窗位／更多工具的選單
  useEffect(() => {
    if (!popover) return;
    const close = (e: MouseEvent) => {
      if (!toolbarRef.current?.contains(e.target as Node)) setPopover(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [popover]);

  // ---------- 復原 ----------
  function remember() {
    setHistory((h) => [...h.slice(-(UNDO_LIMIT - 1)), { box: boxDraft, mask: maskDraft }]);
  }

  function undo() {
    const last = history[history.length - 1];
    if (!last) {
      setMessage('沒有可以復原的步驟。');
      return;
    }
    setHistory(history.slice(0, -1));
    setBoxDraft(last.box);
    setMaskDraft(last.mask);
    setMessage('已復原上一步');
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
    remember();
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

  /** 新的一筆塗抹開始前記下草稿；沒有標籤時這筆不會塗，就不記 */
  function strokeStart() {
    if (tool === 'erase' || label.trim()) remember();
  }

  function removeBox(i: number) {
    remember();
    setBoxDraft((d) => (d ? { ...d, boxes: d.boxes.filter((_, j) => j !== i), dirty: true } : d));
  }

  function discard() {
    setBoxDraft(null);
    setMaskDraft(null);
    setHistory([]);
    setClassDraft({ editingId: null, scope: 'study' });
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
      setHistory([]);
      if (at >= 0) setIndex(at);
      setMode(a.kind);
      if (isClassification(a)) {
        setSavedClass(null);
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
      setMessage(`編輯標註 #${a.id}（${KIND_LABELS[a.kind]}，${SOURCE_LABELS[a.source]}${isDraft(a) ? '，待確認，存檔後即確認' : ''}）`);
    },
    [list, index],
  );

  // 有沒存的框或遮罩時，關閉分頁、重新整理或點其他連結都先提醒，避免草稿直接遺失
  useEffect(() => {
    if (!dirty) return;
    const LEAVE = '目前影像有尚未儲存的標註，離開後會遺失。確定要離開嗎？';
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = LEAVE;
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a || a.getAttribute('target') === '_blank') return;
      if (!window.confirm(LEAVE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);

  // 從自動標註頁帶 ?annotation=<id> 進來時，資料載入後直接開啟編輯
  useEffect(() => {
    if (opened || !openAnnotation || list.length === 0 || !annotations.data) return;
    setOpened(true);
    const target = annotations.data.find((a) => a.id === openAnnotation);
    if (target) edit(target);
    else setMessage(`找不到標註 #${openAnnotation}`);
  }, [opened, openAnnotation, list.length, annotations.data, edit]);

  // ---------- 儲存 ----------
  /** 執行寫入並重新載入；成功回 true。 */
  async function run(action: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const text = await action();
      annotations.reload();
      summary.reload();
      setMessage(text);
      return true;
    } catch (e) {
      setError(e);
      setMessage('');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const target = (scope: 'image' | 'study') =>
    scope === 'image' && current
      ? { study_instance_uid: studyUid, series_instance_uid: current.seriesInstanceUid, sop_instance_uid: current.sopInstanceUid }
      : { study_instance_uid: studyUid };
  const classKey = (text: string) =>
    [classDraft.scope, studyUid, classDraft.scope === 'image' ? (current?.sopInstanceUid ?? '') : '', text].join('|');
  const classUnchanged = savedClass !== null && classDraft.editingId === null && savedClass === classKey(label.trim());

  function saveClassification(): Promise<boolean> {
    const text = label.trim();
    if (!text) {
      setMessage('請先填寫標籤。');
      return Promise.resolve(false);
    }
    if (classUnchanged) {
      setMessage(`分類「${text}」已經儲存過了。`);
      return Promise.resolve(true);
    }
    const key = classKey(text);
    return run(async () => {
      if (classDraft.editingId !== null) {
        const a = await labeling.update(classDraft.editingId, { label: text });
        setClassDraft({ editingId: null, scope: 'study' });
        // 更新後範圍回到整個研究；原本就是整個研究時，畫面上的類別就是剛存的內容
        setSavedClass(classDraft.scope === 'study' ? key : null);
        return `已更新分類標註 #${a.id}：${text}（版本 ${a.version}）`;
      }
      const a = await labeling.create({ ...target(classDraft.scope), kind: 'classification', payload: { label: text } });
      setSavedClass(key);
      return `已儲存分類標註 #${a.id}：${text}`;
    });
  }

  function saveDetection(): Promise<boolean> {
    if (!boxDraft || boxDraft.boxes.length === 0) {
      setMessage('還沒有畫任何框。');
      return Promise.resolve(false);
    }
    const payload = { shape: boxDraft.shape, box_format: 'xyxy' as const, boxes: boxDraft.boxes };
    return run(async () => {
      const a =
        boxDraft.editingId !== null
          ? await labeling.update(boxDraft.editingId, payload)
          : await labeling.create({ ...target('image'), kind: 'detection', payload });
      setBoxDraft(null);
      setHistory([]);
      return `已儲存偵測標註 #${a.id}（${payload.boxes.length} 個框，版本 ${a.version}）`;
    });
  }

  function saveSegmentation(): Promise<boolean> {
    if (!maskDraft || !maskDraft.mask.some((v) => v !== 0)) {
      setMessage('遮罩是空的，請先用筆刷塗抹。');
      return Promise.resolve(false);
    }
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
      setHistory([]);
      return `已儲存分割標註 #${a.id}（${usedLabels(maskDraft.mask, maskDraft.labelNames).join('、')}，版本 ${a.version}）`;
    });
  }

  function saveCurrent(): Promise<boolean> {
    if (busy) return Promise.resolve(false);
    if (mode === 'classification') return saveClassification();
    if (mode === 'detection') return saveDetection();
    return saveSegmentation();
  }

  /** 目前的標註種類有沒有可以存的內容 */
  const canSave =
    mode === 'classification'
      ? Boolean(current && label.trim()) && !classUnchanged
      : mode === 'detection'
        ? Boolean(boxDraft && boxDraft.boxes.length > 0)
        : Boolean(maskDraft);
  /** 有內容就先存，存成功（或沒有要存的）就開清單中下一筆待處理研究 */
  async function saveAndNext() {
    if (busy) return;
    if (canSave && !(await saveCurrent())) return;
    // 存檔後重新抓一次清單，剛存的這筆就不再算待處理
    const fresh = await labeling.summary().catch(() => summary.data);
    const studies = (fresh?.studies ?? []).filter((s) => !scopeUids.data || scopeUids.data.has(s.study_instance_uid));
    const next = nextPendingStudy(studies, studyUid);
    if (next) navigate(workbenchPath(next.study_instance_uid, scopeId));
    else {
      setMessage(`已儲存。${scopeId !== null ? '這個資料範圍' : '這個專案'}已經沒有待處理的影像了。`);
    }
  }

  function confirmDraft(a: Annotation) {
    return run(async () => {
      await labeling.confirm(a.id);
      return `已確認標註 #${a.id}`;
    });
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
    h: () => pickViewTool('pan'),
    z: () => pickViewTool('zoom'),
    w: () => pickViewTool('window'),
    space: resetView,
    escape: () => {
      setTool('none');
      setPopover(null);
      setMessage('已放下標註工具');
    },
    'ctrl+s': () => void saveCurrent(),
    'ctrl+z': undo,
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

  // 分類沒有形狀，改在影像左上角標出：研究層級與這張影像的類別
  const badgesFor = useCallback(
    (instance: InstanceInfo): ViewportBadge[] => {
      if (!showAnnotations) return [];
      const out: ViewportBadge[] = [];
      for (const a of all) {
        if (!isClassification(a)) continue;
        if (a.sop_instance_uid === null) out.push({ id: a.id, text: `整個研究：${a.payload.label}`, color: colorOf[a.payload.label] ?? 1 });
        else if (a.sop_instance_uid === instance.sopInstanceUid) out.push({ id: a.id, text: `這張影像：${a.payload.label}`, color: colorOf[a.payload.label] ?? 1 });
      }
      return out;
    },
    [all, showAnnotations, colorOf],
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

  // 頂部進度：有資料範圍時只算範圍內
  const studies = summary.data?.studies ?? [];
  const inScope = scopeUids.data ? studies.filter((s) => scopeUids.data!.has(s.study_instance_uid)) : studies;
  const progress = scopeId !== null ? progressOf(inScope) : progressOf(inScope, summary.data?.pending, summary.data?.confirmed);
  const study = studies.find((s) => s.study_instance_uid === studyUid);
  const caseName = study?.accession_number || '（無影像編號）';
  const position = `第 ${list.length ? index + 1 : 0} / ${list.length} 張`;

  // 右側面板的狀態與評分：正在編輯的那筆；沒有就用這裡（目前影像或整個研究）最新一筆同種類的標註
  const editingId =
    mode === 'classification' ? classDraft.editingId : mode === 'detection' ? (boxDraft?.editingId ?? null) : (maskDraft?.editingId ?? null);
  const here = (a: Annotation) => (a.sop_instance_uid === null ? mode === 'classification' : a.sop_instance_uid === current?.sopInstanceUid);
  const focus = editingId !== null ? all.find((a) => a.id === editingId) : [...all].reverse().find((a) => a.kind === mode && here(a));
  const state: { tone: 'warning' | 'success' | 'neutral'; text: string } = dirty
    ? { tone: 'warning', text: '尚未儲存' }
    : focus
      ? { tone: isDraft(focus) ? 'warning' : 'success', text: `${SOURCE_LABELS[focus.source]}・${STATUS_LABELS[focus.status ?? 'confirmed']}` }
      : { tone: 'neutral', text: '尚未標註' };

  const rate = (a: Annotation, rating: number | null) =>
    void run(async () => {
      await labeling.rate(a.id, rating);
      return rating === null ? `已清除標註 #${a.id} 的評分` : `標註 #${a.id} 評為 ${rating} 分`;
    });

  const viewTool = (name: 'pan' | 'zoom' | 'window', icon: ToolIconName, text: string) => (
    <button
      type="button"
      className="lb-tool"
      aria-pressed={tool === name}
      aria-expanded={name === 'window' ? popover === 'window' : undefined}
      onClick={() => {
        pickViewTool(name);
        if (name === 'window') setPopover((p) => (p === 'window' ? null : 'window'));
      }}
    >
      <ToolIcon name={icon} />
      {text}
    </button>
  );

  return (
    <>
      {/* 第一個畫面：頂列＋三欄，寬螢幕時剛好一個視窗高（labeling.css） */}
      <div className="lb-wb-screen">
        <div className="lb-topbar">
          <Link to={listPath} className="lb-topbar__back">
            ← 回待處理清單
          </Link>
          <h1 className="lb-topbar__title">影像標註工作台</h1>
          {summary.data ? (
            <div className="lb-topbar__progress">
              <ProgressBar label="已確認" value={progress.confirmed} max={progress.total} />
            </div>
          ) : null}
          <a className="btn btn--secondary btn--small lb-topbar__advanced" href={ohifUrl(labeling.projectId, studyUid)} target="_blank" rel="noreferrer">
            進階檢視（OHIF）<span className="visually-hidden">，在新分頁開啟</span>
          </a>
        </div>
        {loadError ? (
          <Alert tone="error" title="無法載入影像">
            {loadError instanceof Error ? loadError.message : '影像服務沒有回應'}
          </Alert>
        ) : null}
        <ApiErrorAlert error={error ?? annotations.error} />
        <p className="viewer-status" role="status" aria-live="polite" data-testid="workbench-status">
          {message}
        </p>

        <div className="lb-work">
          <SliceStrip
            dicomweb={labeling.dicomweb}
            studyUid={studyUid}
            instances={list}
            index={index}
            onPick={goTo}
            series={series.data ?? []}
            seriesUid={currentSeries}
            seriesLocked={dirty}
            onSeries={(uid) => {
              setSeriesUid(uid);
              setIndex(0);
              setHistory([]);
            }}
          />

          <div className="lb-center">
            <section className="lb-viewer" aria-label="影像檢視">
              <div className="lb-toolbar" role="toolbar" aria-label="檢視工具列" ref={toolbarRef}>
                {viewTool('pan', 'hand', '移動')}
                {viewTool('zoom', 'zoom', '放大')}
                {viewTool('window', 'contrast', '窗位')}
                <span className="lb-toolbar__sep" aria-hidden="true" />
                <button type="button" className="lb-tool" aria-pressed={mode === 'detection' && tool === 'box'} onClick={() => pick('detection')}>
                  <ToolIcon name="select" />
                  圈選
                </button>
                <button
                  type="button"
                  className="lb-tool"
                  aria-pressed={mode === 'segmentation' && (tool === 'brush' || tool === 'erase')}
                  onClick={() => pick('segmentation')}
                >
                  <ToolIcon name="brush" />
                  塗抹
                </button>
                <span className="lb-toolbar__sep" aria-hidden="true" />
                <button type="button" className="lb-tool" disabled={history.length === 0} onClick={undo}>
                  <ToolIcon name="undo" />
                  復原
                </button>
                <button
                  type="button"
                  className="lb-tool lb-tool--end"
                  aria-expanded={popover === 'more'}
                  onClick={() => setPopover((p) => (p === 'more' ? null : 'more'))}
                >
                  更多工具
                  <ToolIcon name="more" />
                </button>

                {popover === 'window' ? (
                  <div className="lb-popover" data-testid="window-menu">
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
                    <form className="viewer-toolbar__group lb-window-form" aria-label="窗寬窗位" onSubmit={submitWindow} key={`${display?.width}/${display?.center}`}>
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
                    <p className="field__hint">選了「窗位」後，也可以在影像上左右拖曳調窗寬、上下拖曳調窗位。</p>
                  </div>
                ) : null}

                {popover === 'more' ? (
                  <div className="lb-popover lb-popover--end" data-testid="more-menu">
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
                      <legend>其他</legend>
                      <button type="button" className="btn btn--small btn--secondary" aria-pressed={invert} onClick={() => setInvert((v) => !v)}>
                        反相
                      </button>
                      <button type="button" className="btn btn--small btn--secondary" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(Math.min(MAX_ZOOM, zoom * 1.5))}>
                        放大一級
                      </button>
                      <button type="button" className="btn btn--small btn--secondary" disabled={zoom <= 1} onClick={() => changeZoom(Math.max(1, zoom / 1.5))}>
                        縮小一級
                      </button>
                      <button type="button" className="btn btn--small btn--secondary" onClick={resetView}>
                        重設檢視
                      </button>
                    </fieldset>
                    <details className="hotkeys">
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
                  </div>
                ) : null}
              </div>

              <div className="lb-viewer__body">
                {instances.loading || series.loading ? (
                  <p role="status" className="loading lb-viewer__note">
                    影像載入中…
                  </p>
                ) : list.length === 0 && !loadError ? (
                  <p className="lb-viewer__note">這個研究沒有可顯示的影像。</p>
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
                        badges={badgesFor(instance)}
                        colorOf={colorOf}
                        active={cell === 0}
                        tool={cell === 0 || tool === 'pan' || tool === 'zoom' || tool === 'window' ? tool : 'none'}
                        draftShape={(mode === 'segmentation' ? maskDraft?.shape : boxDraft?.shape) ?? undefined}
                        onBox={addBox}
                        onPaint={paint}
                        onStrokeStart={strokeStart}
                        onWindow={setShownWindow}
                        zoom={zoom}
                        pan={pan}
                        onZoom={changeZoom}
                        onPan={setPan}
                        onWindowDrag={dragWindow}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="lb-viewer__foot">
                <span className="lb-viewer__meta">
                  <span>{caseName}</span>
                  {study?.study_date ? <span>{formatDate(study.study_date)}</span> : null}
                  {study?.study_description || current?.modality ? <span>{study?.study_description || current?.modality}</span> : null}
                </span>
                <span className="lb-viewer__nav">
                  <button type="button" className="lb-tool lb-tool--small" disabled={index <= 0} onClick={() => goTo(index - 1)}>
                    上一張
                  </button>
                  <span data-testid="image-position">{position}</span>
                  <button type="button" className="lb-tool lb-tool--small" disabled={index >= list.length - 1} onClick={() => goTo(index + 1)}>
                    下一張
                  </button>
                </span>
                <span className="lb-viewer__toggle">
                  <Toggle checked={showAnnotations} onChange={setShowAnnotations} label="顯示標註範圍" />
                </span>
              </div>
              <Legend colorOf={colorOf} />
            </section>
          </div>

          <section aria-label="標註" className="lb-panel">
            <div className="lb-panel__head">
              <h2 className="lb-panel__case">{caseName}</h2>
              <span className="text-muted">目前影像：{position}</span>
            </div>
            <div className="lb-kind-tabs" role="group" aria-label="標註種類">
              {KIND_TABS.map((t) => (
                <button
                  key={t.kind}
                  type="button"
                  className="lb-kind-tab"
                  aria-pressed={mode === t.kind}
                  aria-label={t.name !== t.text ? t.name : undefined}
                  onClick={() => pick(t.kind)}
                >
                  {t.text}
                </button>
              ))}
            </div>

            <div className="lb-panel__body stack">
              <LabelPicker label="標註類別" ariaLabel="標籤" value={label} options={labelOptions} onChange={setLabel} />

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
                  {!label.trim() ? <p className="field__hint">先在「標註類別」輸入類別（例如 normal、abnormal），才能儲存。</p> : null}
                  {classDraft.editingId !== null ? (
                    <div className="row-actions">
                      <button type="button" className="btn btn--secondary btn--small" onClick={discard}>
                        取消編輯
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {mode === 'detection' ? (
                <div className="stack">
                  <div className="row-actions">
                    <button type="button" className="btn btn--small btn--secondary" aria-pressed={tool === 'box'} onClick={() => setTool(tool === 'box' ? 'none' : 'box')}>
                      畫框工具
                    </button>
                  </div>
                  <p className="field__hint">選好類別後，在影像上按住拖曳畫框；也可以在下方輸入座標。</p>
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
                        <button type="button" className="btn btn--small btn--ghost" aria-label={`刪除第 ${i + 1} 個框`} onClick={() => removeBox(i)}>
                          刪除
                        </button>
                      </li>
                    ))}
                  </ul>
                  {boxDraft?.editingId ? <p className="field__hint">正在編輯標註 #{boxDraft.editingId}</p> : null}
                  <div className="row-actions">
                    <button type="button" className="btn btn--secondary btn--small" disabled={!boxDraft} onClick={discard}>
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
                    <label htmlFor="brush">筆刷大小</label>
                    <div className="lb-range">
                      <input
                        id="brush"
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={brush}
                        aria-label="筆刷半徑（像素）"
                        onChange={(e) => setBrush(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                      />
                      <output htmlFor="brush">{brush}</output>
                    </div>
                  </div>
                  <p className="field__hint" data-testid="mask-info">
                    {maskDraft
                      ? `已塗 ${maskDraft.mask.reduce((n, v) => n + (v ? 1 : 0), 0)} 個像素：${usedLabels(maskDraft.mask, maskDraft.labelNames).join('、') || '（無）'}`
                      : '選好類別後，在影像上按住拖曳塗抹。'}
                  </p>
                  {maskDraft?.editingId ? <p className="field__hint">正在編輯標註 #{maskDraft.editingId}</p> : null}
                  <div className="row-actions">
                    <button type="button" className="btn btn--secondary btn--small" disabled={!maskDraft} onClick={discard}>
                      捨棄草稿
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="lb-field">
                <span className="lb-field__label">標註狀態</span>
                <div className="row-actions" data-testid="annotation-state">
                  <Badge tone={state.tone}>{state.text}</Badge>
                  {focus && !dirty ? <span className="text-muted">#{focus.id}</span> : null}
                  {focus && isDraft(focus) && !dirty ? (
                    <button type="button" className="btn btn--small btn--secondary" disabled={busy} onClick={() => void confirmDraft(focus)}>
                      直接確認
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="lb-field">
                <span className="lb-field__label">標註信心</span>
                {focus ? (
                  <Rating
                    name={`標註 #${focus.id}`}
                    label={`標註 #${focus.id} 的標註信心`}
                    value={focus.rating}
                    disabled={busy}
                    onChange={(rating) => rate(focus, rating)}
                  />
                ) : (
                  <p className="field__hint">儲存後可以評分（1–5 分）。</p>
                )}
              </div>
            </div>

            {/* 主要動作：存完直接開下一筆待處理。DOM 先放主要按鈕，畫面上排在右邊 */}
            <div className="lb-panel__actions" data-testid="workbench-actions">
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void saveAndNext()}>
                {canSave ? '儲存並開啟下一筆' : '開啟下一筆'}
              </button>
              <button type="button" className="btn btn--secondary" disabled={busy || !canSave} onClick={() => void saveCurrent()}>
                只儲存
              </button>
            </div>
          </section>
        </div>
      </div>

      <Card
        title={`這個研究的標註（${all.length} 筆）`}
        extra={
          <label className="checkbox-row">
            <input type="checkbox" className="checkbox" checked={onlyCurrent} onChange={(e) => setOnlyCurrent(e.target.checked)} />
            只看目前影像與研究層級
          </label>
        }
        className="section"
        flush
      >
        {annotations.loading && !annotations.data ? (
          <p role="status" className="loading lb-card-note">
            載入中…
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted lb-card-note">還沒有標註。</p>
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
                  <th scope="col">狀態</th>
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
                    <td>
                      <Badge tone={isDraft(a) ? 'warning' : 'success'}>{STATUS_LABELS[a.status ?? 'confirmed']}</Badge>
                    </td>
                    <td>{a.version}</td>
                    <td>
                      <Rating name={`標註 #${a.id}`} value={a.rating} disabled={busy} onChange={(rating) => rate(a, rating)} />
                    </td>
                    <td>
                      <div className="row-actions">
                        {isDraft(a) ? (
                          <button
                            type="button"
                            className="btn btn--small btn--secondary"
                            aria-label={`確認標註 #${a.id}`}
                            disabled={busy}
                            onClick={() => void confirmDraft(a)}
                          >
                            確認
                          </button>
                        ) : null}
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
      </Card>

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
