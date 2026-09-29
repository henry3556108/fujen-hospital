// MSW：影像標註（/api/projects/:pid/labels/*）、合成的專案範圍 DICOMweb、建立訓練任務。
// 路徑、狀態碼、錯誤訊息照 platform/api/app/labeling。只在 dev server 與單元測試使用。
//
// 標註資料存在 sessionStorage：同一個分頁重新載入後仍在（用來驗證「重新載入差異 0」），關閉分頁就消失。
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type { Permission } from '../api/types';
import type {
  Annotation,
  AnnotationKind,
  AutolabelModel,
  AutolabelRun,
  CsvRowResult,
  DetectionPayload,
  LabelSummary,
  SegmentationPayload,
} from '../pages/labeling/types';
import { meFor, seedDb, type MockDb } from './data';

// 帳號與專案資料由 mocks/handlers.ts 持有；以函式注入，避免兩個模組互相 import
let mockDb: () => MockDb = (() => {
  const db = seedDb();
  return () => db;
})();

const STORE_KEY = '__AI_PLATFORM_MOCK_LABELING__';
const ROOT = '1.2.826.0.1.3680043.10.9999.42';
export const MOCK_STUDY_COUNT = 10;
export const MOCK_SLICES = 3;
export const MOCK_SIZE = 64;

export interface MockStudy {
  study_instance_uid: string;
  series_instance_uid: string;
  sop_instance_uids: string[];
  accession_number: string;
  patient_id: string;
  study_date: string;
  study_description: string;
  modality: string;
}

export const MOCK_STUDIES: MockStudy[] = Array.from({ length: MOCK_STUDY_COUNT }, (_, i) => {
  const no = i + 1;
  const ct = no % 2 === 1;
  return {
    study_instance_uid: `${ROOT}.1.${no}`,
    series_instance_uid: `${ROOT}.2.${no}.1`,
    sop_instance_uids: Array.from({ length: MOCK_SLICES }, (_, s) => `${ROOT}.3.${no}.${s + 1}`),
    accession_number: `ACC${String(no).padStart(4, '0')}`,
    patient_id: `PAT${String(no).padStart(4, '0')}`,
    study_date: `2024${String(1 + (no % 12)).padStart(2, '0')}15`,
    study_description: ct ? 'CT CHEST WO CONTRAST' : 'MR BRAIN WWO CONTRAST',
    modality: ct ? 'CT' : 'MR',
  };
});

interface MockJob {
  id: number;
  project_id: number;
  user: string;
  kind: string;
  status: string;
  training_type?: string;
}

interface State {
  annotations: Annotation[];
  runs: AutolabelRun[];
  jobs: MockJob[];
  nextAnnotationId: number;
  nextRunId: number;
  nextJobId: number;
  autolabelOffline: boolean;
}

const fresh = (): State => ({
  annotations: [],
  runs: [],
  jobs: [],
  nextAnnotationId: 1,
  nextRunId: 1,
  nextJobId: 1,
  autolabelOffline: false,
});

let state: State | null = null;
let owner: MockDb | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function load(): State {
  // 單元測試每次 resetMockDb() 都會換一個 db 物件，標註資料跟著重來
  const db = mockDb();
  if (state && owner === db) return state;
  const firstLoad = owner === null;
  owner = db;
  state = fresh();
  if (firstLoad) {
    try {
      const raw = storage()?.getItem(STORE_KEY);
      if (raw) state = { ...fresh(), ...(JSON.parse(raw) as State) };
    } catch {
      state = fresh();
    }
  } else {
    storage()?.removeItem(STORE_KEY);
  }
  return state;
}

function save(): void {
  try {
    if (state) storage()?.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* 儲存空間不可用時只留在記憶體 */
  }
}

/** 測試用：直接看或改模擬狀態。 */
export function labelingMock(): State {
  return load();
}

const json = (body: unknown, status = 200) => HttpResponse.json(body as JsonBodyType, { status });
const detail = (status: number, message: string) => json({ detail: message }, status);

interface Ctx {
  username: string;
  projectId: number;
}

function authorize(request: Request, pid: string | readonly string[] | undefined, permission: Permission): Ctx | Response {
  const auth = request.headers.get('authorization') ?? '';
  const m = /^bearer test-token:(.+)$/i.exec(auth);
  if (!auth) return detail(401, '未登入');
  if (!m) return detail(401, '登入已失效，請重新登入');
  const me = meFor(mockDb(), m[1]);
  if (!me) return detail(401, '帳號不存在或已停用');
  const projectId = Number(pid);
  const project = me.projects.find((p) => p.id === projectId);
  if (!project || !project.permissions.includes(permission)) {
    if (me.account_type === 'admin' && !project) return detail(404, `找不到專案 ${projectId}`);
    return json({ detail: { code: 'forbidden', permission, message: `你沒有 ${permission} 權限` } }, 403);
  }
  return { username: m[1], projectId };
}

/** 模擬資料只有 P1（專案 1）有影像。 */
function studiesOf(projectId: number): MockStudy[] {
  return projectId === 1 ? MOCK_STUDIES : [];
}

function findStudy(projectId: number, uid: string): MockStudy | undefined {
  return studiesOf(projectId).find((s) => s.study_instance_uid === uid);
}

// ---------- 標註內容驗證（精簡版，規則同 app/labeling/payloads.py） ----------

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function validate(kind: AnnotationKind, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return '標註內容必須是物件';
  const p = payload as Record<string, unknown>;
  if (kind === 'classification') {
    return typeof p.label === 'string' && p.label.trim() ? null : '標籤不可空白';
  }
  const shape = p.shape;
  if (!Array.isArray(shape) || shape.length !== 2 || !shape.every((v) => isInt(v) && v >= 1)) {
    return 'shape 必須是 [高, 寬]，各為 1 到 4096 的整數';
  }
  const [height, width] = shape as [number, number];
  if (kind === 'detection') {
    const boxes = p.boxes;
    if (!Array.isArray(boxes) || boxes.length === 0) return 'boxes 至少要有一個框';
    for (const b of boxes as DetectionPayload['boxes']) {
      if (typeof b.label !== 'string' || !b.label.trim()) return '標籤不可空白';
      if (!Array.isArray(b.box) || b.box.length !== 4 || !b.box.every(isInt)) return 'box 必須是 4 個整數 [x1, y1, x2, y2]';
      const [x1, y1, x2, y2] = b.box;
      if (!(0 <= x1 && x1 < x2 && x2 <= width && 0 <= y1 && y1 < y2 && y2 <= height)) {
        return `框 ${JSON.stringify(b.box)} 超出影像範圍或大小為 0`;
      }
    }
    return null;
  }
  const seg = p as unknown as SegmentationPayload;
  if (!seg.label_names || seg.label_names.background !== 0) return 'label_names 必須包含 background＝0';
  if (!Array.isArray(seg.rle)) return 'rle 必須是 [標籤值, 長度] 的清單';
  const allowed = new Set(Object.values(seg.label_names));
  let total = 0;
  for (const pair of seg.rle) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isInt) || pair[1] <= 0) return 'rle 的每一段必須是 [標籤值, 長度]';
    if (!allowed.has(pair[0])) return `rle 出現 label_names 沒有的標籤值 ${pair[0]}`;
    total += pair[1];
  }
  return total === height * width ? null : `rle 長度總和 ${total} 與影像大小 ${height}×${width} 不符`;
}

function normalize(kind: AnnotationKind, payload: unknown): Annotation['payload'] {
  const p = payload as Record<string, unknown>;
  if (kind === 'classification') return { label: String(p.label).trim() };
  return JSON.parse(JSON.stringify(payload)) as Annotation['payload'];
}

function labelsOf(a: Annotation): string[] {
  if (a.kind === 'classification') return [(a.payload as { label: string }).label];
  if (a.kind === 'detection') return [...new Set((a.payload as DetectionPayload).boxes.map((b) => b.label))].sort();
  const seg = a.payload as SegmentationPayload;
  const used = new Set(seg.rle.map(([v]) => v));
  return Object.entries(seg.label_names)
    .filter(([, v]) => v !== 0 && used.has(v))
    .map(([k]) => k)
    .sort();
}

function summary(projectId: number): LabelSummary {
  const rows = load().annotations.filter((a) => a.project_id === projectId);
  const kinds: AnnotationKind[] = ['classification', 'segmentation', 'detection'];
  const count = <K extends string>(keys: readonly K[], of: (a: Annotation) => string) =>
    Object.fromEntries(keys.map((k) => [k, rows.filter((a) => of(a) === k).length])) as Record<K, number>;
  const labels = Object.fromEntries(kinds.map((k) => [k, {} as Record<string, number>])) as LabelSummary['labels'];
  for (const a of rows) for (const l of labelsOf(a)) labels[a.kind][l] = (labels[a.kind][l] ?? 0) + 1;
  return {
    total: rows.length,
    rated: rows.filter((a) => a.rating !== null).length,
    by_kind: count(kinds, (a) => a.kind),
    by_source: count(['manual', 'csv', 'autolabel'] as const, (a) => a.source),
    labels,
    studies: studiesOf(projectId).map((s) => {
      const mine = rows.filter((a) => a.study_instance_uid === s.study_instance_uid);
      return {
        study_instance_uid: s.study_instance_uid,
        accession_number: s.accession_number,
        patient_id: s.patient_id,
        study_date: s.study_date,
        study_description: s.study_description,
        annotations: mine.length,
        by_kind: Object.fromEntries(kinds.map((k) => [k, mine.filter((a) => a.kind === k).length])) as Record<
          AnnotationKind,
          number
        >,
      };
    }),
  };
}

// ---------- 合成影像 ----------

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 64×64、16 bit 的合成切面；存值＝HU + 1024（Rescale Intercept −1024）。 */
export function mockPixels(sop: string): Uint16Array {
  const n = MOCK_SIZE;
  const h = hash(sop);
  const cx = 32 + (h % 5) - 2;
  const cy = 32 + ((h >> 3) % 5) - 2;
  const out = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const body = ((x - cx) / 26) ** 2 + ((y - cy) / 22) ** 2;
      const lungL = ((x - cx + 11) / 8) ** 2 + ((y - cy) / 13) ** 2;
      const lungR = ((x - cx - 11) / 8) ** 2 + ((y - cy) / 13) ** 2;
      const nodule = (x - cx - 11) ** 2 + (y - cy + 3) ** 2;
      let hu = -1000;
      if (body <= 1) hu = 40 + ((x * 7 + y * 3) % 20);
      if (body <= 1 && body > 0.82) hu = 700;
      if (lungL <= 1 || lungR <= 1) hu = -700 + ((x + y) % 30);
      if (nodule <= 9) hu = 60;
      out[y * n + x] = hu + 1024;
    }
  }
  return out;
}

function framesResponse(sop: string): Response {
  const pixels = mockPixels(sop);
  const data = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const boundary = 'mock-frame-boundary';
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head);
  body.set(data, head.length);
  body.set(tail, head.length + data.length);
  return new HttpResponse(body.buffer, {
    status: 200,
    headers: {
      'Content-Type': `multipart/related; type="application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1"; boundary=${boundary}`,
    },
  });
}

const value = (vr: string, ...v: unknown[]) => ({ vr, Value: v });

function instanceJson(s: MockStudy, index: number) {
  return {
    '00080018': value('UI', s.sop_instance_uids[index]),
    '0020000D': value('UI', s.study_instance_uid),
    '0020000E': value('UI', s.series_instance_uid),
    '00200013': value('IS', index + 1),
    '00080060': value('CS', s.modality),
    '00280002': value('US', 1),
    '00280004': value('CS', 'MONOCHROME2'),
    '00280010': value('US', MOCK_SIZE),
    '00280011': value('US', MOCK_SIZE),
    '00280100': value('US', 16),
    '00280103': value('US', 0),
    '00281052': value('DS', '-1024'),
    '00281053': value('DS', '1'),
  };
}

// ---------- 自動標註（結果只由模型與影像決定） ----------

export const MOCK_MODELS: AutolabelModel[] = [
  { name: 'fake_detection', type: 'detection', labels: ['lung', 'nodule'], dimension: 2, description: '模擬偵測模型' },
  { name: 'fake_segmentation', type: 'segmentation', labels: ['lung', 'nodule'], dimension: 2, description: '模擬分割模型' },
];

function autolabelPayload(model: AutolabelModel, sop: string): Annotation['payload'] {
  const h = hash(`${model.name}/${sop}`);
  const n = MOCK_SIZE;
  if (model.type === 'detection') {
    const x = 8 + (h % 20);
    const y = 8 + ((h >> 5) % 20);
    return {
      shape: [n, n],
      box_format: 'xyxy',
      boxes: [
        { label: 'nodule', box: [x, y, x + 8, y + 8], score: 0.87 },
        { label: 'lung', box: [6, 10, 58, 54], score: 0.93 },
      ],
    };
  }
  const mask = new Uint8Array(n * n);
  const cx = 28 + (h % 8);
  const cy = 28 + ((h >> 4) % 8);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= 9) mask[y * n + x] = 2;
      else if (((x - cx) / 14) ** 2 + ((y - cy) / 18) ** 2 <= 1) mask[y * n + x] = 1;
    }
  }
  const rle: [number, number][] = [];
  for (const v of mask) {
    const last = rle[rle.length - 1];
    if (last && last[0] === v) last[1] += 1;
    else rle.push([v, 1]);
  }
  return { shape: [n, n], encoding: 'rle', rle, label_names: { background: 0, lung: 1, nodule: 2 } };
}

// ---------- CSV ----------

function parseCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(',').map((c) => c.trim()));
}

const KEY_ALIASES: Record<string, string[]> = {
  patient_id: ['patient_id', 'patientid', '病歷號', '病歷號碼', 'chart_no', 'mrn'],
  accession_number: ['accession_number', 'accessionnumber', 'accession', '影像編號', '檢查單號'],
};
const LABEL_ALIASES = ['diagnosis', 'label', '診斷', '診斷結果'];

// ---------- handlers ----------

const API = '*/api/projects/:pid';
const LABELS = `${API}/labels`;
const WADO = '*/dicomweb/projects/:pid/studies/:study';
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getAnnotation(ctx: Ctx, id: string | readonly string[] | undefined): Annotation | Response {
  const a = load().annotations.find((x) => x.id === Number(id) && x.project_id === ctx.projectId);
  return a ?? detail(404, `找不到標註 ${String(id)}`);
}

export function createLabelingHandlers(getDb: () => MockDb) {
  mockDb = getDb;
  return labelingHandlers;
}

const labelingHandlers = [
  http.get(`${LABELS}/summary`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    return json(summary(ctx.projectId));
  }),

  http.get(`${LABELS}/annotations`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const q = new URL(request.url).searchParams;
    const rows = load().annotations.filter(
      (a) =>
        a.project_id === ctx.projectId &&
        (!q.get('study_uid') || a.study_instance_uid === q.get('study_uid')) &&
        (!q.get('sop_uid') || a.sop_instance_uid === q.get('sop_uid')) &&
        (!q.get('kind') || a.kind === q.get('kind')) &&
        (!q.get('source') || a.source === q.get('source')),
    );
    return json(rows);
  }),

  http.post(`${LABELS}/annotations`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const b = await bodyOf(request);
    const kind = b.kind as AnnotationKind;
    if (!['classification', 'segmentation', 'detection'].includes(kind)) {
      return json({ detail: [{ type: 'literal_error', loc: ['body', 'kind'], msg: 'Input should be a valid kind' }] }, 422);
    }
    const problem = validate(kind, b.payload);
    if (problem) return detail(422, problem);
    const sop = typeof b.sop_instance_uid === 'string' ? b.sop_instance_uid : null;
    if (kind !== 'classification' && !sop) return detail(422, '分割與偵測標註必須指定影像（sop_instance_uid）');
    const study = findStudy(ctx.projectId, String(b.study_instance_uid));
    if (!study) return detail(404, '找不到研究，或不在本專案的 Accession 清單內');
    if (sop && !study.sop_instance_uids.includes(sop)) return detail(404, '找不到影像，或影像不屬於這個研究與序列');
    const s = load();
    const a: Annotation = {
      id: s.nextAnnotationId++,
      project_id: ctx.projectId,
      study_instance_uid: study.study_instance_uid,
      series_instance_uid: sop ? study.series_instance_uid : null,
      sop_instance_uid: sop,
      kind,
      payload: normalize(kind, b.payload),
      source: 'manual',
      rating: null,
      version: 1,
      autolabel_run_id: null,
      created_by: ctx.username,
      updated_by: ctx.username,
      created_at: now(),
      updated_at: now(),
    };
    s.annotations.push(a);
    save();
    return json(a, 201);
  }),

  http.get(`${LABELS}/annotations/:id`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const a = getAnnotation(ctx, params.id);
    return a instanceof Response ? a : json(a);
  }),

  http.put(`${LABELS}/annotations/:id`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const a = getAnnotation(ctx, params.id);
    if (a instanceof Response) return a;
    const b = await bodyOf(request);
    const problem = validate(a.kind, b.payload);
    if (problem) return detail(422, problem);
    a.payload = normalize(a.kind, b.payload);
    a.version += 1;
    a.updated_by = ctx.username;
    a.updated_at = now();
    save();
    return json(a);
  }),

  http.put(`${LABELS}/annotations/:id/rating`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const a = getAnnotation(ctx, params.id);
    if (a instanceof Response) return a;
    const { rating } = await bodyOf(request);
    if (rating !== null && !(isInt(rating) && rating >= 1 && rating <= 5)) {
      return json({ detail: [{ type: 'int_type', loc: ['body', 'rating'], msg: '評分必須是 1 到 5 的整數' }] }, 422);
    }
    a.rating = rating as number | null;
    a.updated_by = ctx.username;
    a.updated_at = now();
    save();
    return json(a);
  }),

  http.delete(`${LABELS}/annotations/:id`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const a = getAnnotation(ctx, params.id);
    if (a instanceof Response) return a;
    const s = load();
    s.annotations = s.annotations.filter((x) => x !== a);
    save();
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${LABELS}/classification-csv`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const form = await request.formData();
    const key = String(form.get('key') ?? '');
    if (!(key in KEY_ALIASES)) return detail(422, 'key 必須是 patient_id（病歷號）或 accession_number（影像編號）');
    const file = form.get('file');
    // 不用 instanceof：測試環境裡 fetch 產生的 File 與全域的 Blob 來自不同實作
    const text = file && typeof file === 'object' && 'text' in file ? await (file as Blob).text() : '';
    const lines = parseCsv(text);
    if (lines.length === 0) return detail(422, 'CSV 是空的');
    const header = lines[0].map((h) => h.toLowerCase());
    const keyAt = header.findIndex((h) => KEY_ALIASES[key].includes(h));
    const labelAt = header.findIndex((h) => LABEL_ALIASES.includes(h));
    if (keyAt < 0) return detail(422, `CSV 找不到鍵欄位（${KEY_ALIASES[key].join('、')}）；目前的欄位：${lines[0].join('、')}`);
    if (labelAt < 0) return detail(422, `CSV 找不到診斷欄位（${LABEL_ALIASES.join('、')}）；目前的欄位：${lines[0].join('、')}`);
    if (lines.length === 1) return detail(422, 'CSV 沒有資料列');
    const rows = lines.slice(1).map((l, i) => ({ row: i + 2, key: l[keyAt] ?? '', label: l[labelAt] ?? '' }));
    const perKey = new Map<string, Set<string>>();
    for (const r of rows) if (r.key && r.label) perKey.set(r.key, (perKey.get(r.key) ?? new Set()).add(r.label));
    const s = load();
    const counts = { created: 0, updated: 0, unchanged: 0 };
    const written = new Map<string, number[]>();
    const results: CsvRowResult[] = rows.map((r) => {
      const item: CsvRowResult = { ...r, status: 'matched', reason: '', study_instance_uids: [], annotation_ids: [] };
      const matches = studiesOf(ctx.projectId).filter((st) => (key === 'patient_id' ? st.patient_id : st.accession_number) === r.key);
      if (!r.key || !r.label) return { ...item, status: 'invalid', reason: r.key ? '缺少診斷結果' : '缺少鍵值' };
      if ((perKey.get(r.key)?.size ?? 0) > 1) {
        return { ...item, status: 'conflict', reason: `同一個鍵有不同的診斷結果：${[...perKey.get(r.key)!].sort().join('、')}` };
      }
      if (matches.length === 0) return { ...item, status: 'unmatched', reason: '專案內找不到對應的研究（或不在 Accession 清單內）' };
      if (!written.has(r.key)) {
        written.set(
          r.key,
          matches.map((st) => {
            let a = s.annotations.find(
              (x) =>
                x.project_id === ctx.projectId &&
                x.study_instance_uid === st.study_instance_uid &&
                x.source === 'csv' &&
                x.kind === 'classification' &&
                x.sop_instance_uid === null,
            );
            if (!a) {
              a = {
                id: s.nextAnnotationId++,
                project_id: ctx.projectId,
                study_instance_uid: st.study_instance_uid,
                series_instance_uid: null,
                sop_instance_uid: null,
                kind: 'classification',
                payload: { label: r.label },
                source: 'csv',
                rating: null,
                version: 1,
                autolabel_run_id: null,
                created_by: ctx.username,
                updated_by: ctx.username,
                created_at: now(),
                updated_at: now(),
              };
              s.annotations.push(a);
              counts.created++;
            } else if ((a.payload as { label: string }).label !== r.label) {
              a.payload = { label: r.label };
              a.version += 1;
              a.updated_by = ctx.username;
              a.updated_at = now();
              counts.updated++;
            } else counts.unchanged++;
            return a.id;
          }),
        );
      }
      return { ...item, study_instance_uids: matches.map((m) => m.study_instance_uid), annotation_ids: written.get(r.key)! };
    });
    save();
    const tally = (st: string) => results.filter((r) => r.status === st).length;
    return json(
      {
        key,
        rows: rows.length,
        matched: tally('matched'),
        unmatched: tally('unmatched'),
        conflict: tally('conflict'),
        invalid: tally('invalid'),
        ...counts,
        annotated_studies: new Set([...written.values()].flat()).size,
        results,
      },
      201,
    );
  }),

  http.get(`${LABELS}/autolabel/models`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    if (load().autolabelOffline) return detail(503, '自動標註服務目前無法連線，請稍後再試');
    return json(MOCK_MODELS);
  }),

  http.get(`${LABELS}/autolabel/runs`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    return json([...load().runs].filter((r) => r.project_id === ctx.projectId).reverse());
  }),

  http.post(`${LABELS}/autolabel`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const b = await bodyOf(request);
    const study = findStudy(ctx.projectId, String(b.study_instance_uid));
    if (!study) return detail(404, '找不到研究，或不在本專案的 Accession 清單內');
    const sop = String(b.sop_instance_uid ?? '');
    if (!study.sop_instance_uids.includes(sop)) return detail(404, '找不到影像，或影像不屬於這個研究與序列');
    const s = load();
    if (s.autolabelOffline) return detail(503, '自動標註服務目前無法連線，請稍後再試');
    const model = MOCK_MODELS.find((m) => m.name === b.model);
    if (!model) return detail(404, `自動標註服務沒有模型 ${String(b.model)}`);
    const run: AutolabelRun = {
      id: s.nextRunId++,
      project_id: ctx.projectId,
      model: model.name,
      model_type: model.type,
      study_instance_uid: study.study_instance_uid,
      sop_instance_uid: sop,
      annotation_id: s.nextAnnotationId,
      duration_ms: 12,
      created_by: ctx.username,
      created_at: now(),
    };
    const annotation: Annotation = {
      id: s.nextAnnotationId++,
      project_id: ctx.projectId,
      study_instance_uid: study.study_instance_uid,
      series_instance_uid: study.series_instance_uid,
      sop_instance_uid: sop,
      kind: model.type,
      payload: autolabelPayload(model, sop),
      source: 'autolabel',
      rating: null,
      version: 1,
      autolabel_run_id: run.id,
      created_by: ctx.username,
      updated_by: ctx.username,
      created_at: now(),
      updated_at: now(),
    };
    s.runs.push(run);
    s.annotations.push(annotation);
    save();
    return json({ run, annotation }, 201);
  }),

  // ---- 標註後直接訓練：沿用排程的工作 API（WP4）；訓練型態與參數由 WP5b 擴充 ----
  http.post(`${API}/jobs`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const b = await bodyOf(request);
    const s = load();
    const job: MockJob = {
      id: s.nextJobId++,
      project_id: ctx.projectId,
      user: ctx.username,
      kind: typeof b.kind === 'string' ? b.kind : 'training',
      status: 'queued',
      training_type: typeof b.training_type === 'string' ? b.training_type : undefined,
    };
    s.jobs.push(job);
    save();
    return json({ ...job, gpu_group: 'gpu-exclusive', queue: 'gpu-exclusive', k8s_name: `job-${job.id}-mock`, message: '' }, 201);
  }),

  // ---- 合成的專案範圍 DICOMweb ----
  http.get(`${WADO}/series`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const s = findStudy(ctx.projectId, String(params.study));
    if (!s) return detail(403, '研究不在本專案，或不在 Accession 清單內');
    return json([
      {
        '0020000D': value('UI', s.study_instance_uid),
        '0020000E': value('UI', s.series_instance_uid),
        '00080060': value('CS', s.modality),
        '0008103E': value('LO', s.modality === 'CT' ? 'AXIAL 5MM SOFT TISSUE' : 'AX T1'),
      },
    ]);
  }),
  http.get(`${WADO}/series/:series/metadata`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const s = findStudy(ctx.projectId, String(params.study));
    if (!s || s.series_instance_uid !== params.series) return detail(403, '研究不在本專案，或不在 Accession 清單內');
    return json(s.sop_instance_uids.map((_, i) => instanceJson(s, i)));
  }),
  http.get(`${WADO}/series/:series/instances/:sop/frames/1`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const s = findStudy(ctx.projectId, String(params.study));
    if (!s || !s.sop_instance_uids.includes(String(params.sop))) return detail(403, '研究不在本專案，或不在 Accession 清單內');
    return framesResponse(String(params.sop));
  }),
];
