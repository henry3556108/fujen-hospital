// MSW：推論服務管理（/api/projects/:pid/models、/inference）。路徑、狀態碼、錯誤訊息照 platform/api/app/training。
// 每個專案有一個結構式分類模型與一個影像分類模型、一個物件偵測模型；結果由輸入決定（可重現）。只在 dev server 與測試使用。
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type { Permission } from '../api/types';
import type { ImageResult, InferenceRecord, Model } from '../pages/inference/api';
import { meFor, seedDb, type MockDb } from './data';

let mockDb: () => MockDb = (() => {
  const db = seedDb();
  return () => db;
})();

const API = '*/api/projects/:pid';
const json = (body: unknown, status = 200) => HttpResponse.json(body as JsonBodyType, { status });
const detail = (status: number, message: string) => json({ detail: message }, status);

// 4×4 灰階漸層 PNG
const PREVIEW =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAAAAACMmsGiAAAAFklEQVR4nGNgYGD4z8DAwMDEwMDAAAAe+QMBxZ3a8AAAAABJRU5ErkJggg==';
const FEATURES = ['age', 'bmi', 'glucose', 'sbp'];

function models(projectId: number): Model[] {
  const base = { sha256: 'f'.repeat(64), created_by: 'pi01', created_at: '2026-09-29T01:00:00Z' };
  return [
    { ...base, id: projectId * 100 + 1, name: 'diagnosis-rf-run1', kind: 'tabular_classification', format: 'pkl',
      filename: 'diagnosis-rf-run1.pkl', card: { target: 'diagnosis', features: FEATURES } },
    { ...base, id: projectId * 100 + 2, name: 'modality-cnn-run2', kind: 'image_classification', format: 'h5',
      filename: 'modality-cnn-run2.h5', card: { label_names: ['CT', 'MR'], input: { resize: [32, 32] } } },
    { ...base, id: projectId * 100 + 3, name: 'nodule-det-run3', kind: 'image_detection', format: 'h5',
      filename: 'nodule-det-run3.h5', card: { label_names: ['nodule'], input: { resize: [32, 32] } } },
  ];
}

interface Stored extends InferenceRecord {
  project_id: number;
  download: string;
}
const records: Stored[] = [];

function authorize(request: Request, pid: string | readonly string[] | undefined, permission: Permission) {
  const auth = request.headers.get('authorization') ?? '';
  const m = /^bearer test-token:(.+)$/i.exec(auth);
  if (!auth) return detail(401, '未登入');
  if (!m) return detail(401, '登入已失效，請重新登入');
  const me = meFor(mockDb(), m[1]);
  if (!me) return detail(401, '帳號不存在或已停用');
  const project = me.projects.find((p) => p.id === Number(pid));
  if (!project || !project.permissions.includes(permission)) {
    return json({ detail: { code: 'forbidden', permission, message: `你沒有 ${permission} 權限` } }, 403);
  }
  return { username: me.username, projectId: project.id };
}

function hash(text: string): number {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
  return h;
}

function imageResult(model: Model, name: string): ImageResult {
  const h = hash(name);
  const names = model.card.label_names ?? ['a'];
  if (model.kind === 'image_detection') {
    return { name, slice: 0, preview: PREVIEW, boxes: [{ label: names[0], score: 0.5 + (h % 50) / 100, bbox: [4 + (h % 8), 6, 10, 12] }] };
  }
  const label = names[h % names.length];
  const top = 0.55 + (h % 40) / 100;
  return { name, slice: 0, preview: PREVIEW, label, scores: Object.fromEntries(names.map((n) => [n, n === label ? top : 1 - top])) };
}

function tabular(rows: Record<string, string>[], columns: string[]) {
  const out = rows.map((r) => {
    const missing = FEATURES.some((f) => (r[f] ?? '') === '');
    return [...columns.map((c) => r[c] ?? ''), missing ? '' : String(hash(JSON.stringify(r)) % 2), missing ? '特徵含缺值，無法預測' : ''];
  });
  return { columns: [...columns, 'prediction', 'prediction_note'], rows: out, prediction_column: 'prediction' };
}

function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const columns = lines[0].split(',');
  return { columns, rows: lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [columns[i], v]))) };
}

function store(ctx: { username: string; projectId: number }, model: Model, mode: 'batch' | 'upload', result: Stored['result']): Stored {
  const count = result && 'rows' in result ? result.rows.length : result && 'results' in result ? result.results.length : 0;
  const csv = result && 'rows' in result ? [result.columns, ...result.rows].map((r) => r.join(',')).join('\n') + '\n' : JSON.stringify(result);
  const record: Stored = {
    id: records.length + 1, model_id: model.id, project_id: ctx.projectId, mode, status: 'succeeded', user: ctx.username,
    count, message: '', result_format: result && 'rows' in result ? 'csv' : 'json', has_result: true,
    created_at: new Date().toISOString(), result, download: csv,
  };
  records.push(record);
  return record;
}

const view = ({ download: _d, project_id: _p, ...rest }: Stored): InferenceRecord => rest;

export function createInferenceHandlers(getDb: () => MockDb) {
  mockDb = getDb;
  return inferenceHandlers;
}

const inferenceHandlers = [
  http.get(`${API}/models`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'prediction');
    if (ctx instanceof Response) return ctx;
    return json(models(ctx.projectId));
  }),
  http.get(`${API}/models/:mid/inference`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'prediction');
    if (ctx instanceof Response) return ctx;
    const rows = records.filter((r) => r.project_id === ctx.projectId && r.model_id === Number(params.mid));
    return json(rows.map(({ result: _r, ...r }) => view({ ...r, result: undefined } as Stored)).reverse());
  }),
  http.post(`${API}/models/:mid/inference/batch`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'prediction');
    if (ctx instanceof Response) return ctx;
    const model = models(ctx.projectId).find((m) => m.id === Number(params.mid));
    if (!model) return detail(404, `找不到模型 ${String(params.mid)}`);
    if (model.kind.startsWith('image_')) {
      const results = Array.from({ length: 20 }, (_, i) => imageResult(model, `study_${String(i + 1).padStart(4, '0')}/IM0001.dcm`));
      return json(view(store(ctx, model, 'batch', { results, label_names: model.card.label_names ?? [] })), 201);
    }
    const rows = Array.from({ length: 20 }, (_, i) => ({ patient_id: `P${1000 + i}`, age: String(40 + i), bmi: '24.5', glucose: i === 3 ? '' : '101', sbp: '120' }));
    return json(view(store(ctx, model, 'batch', tabular(rows, ['patient_id', ...FEATURES]))), 201);
  }),
  http.post(`${API}/models/:mid/inference/upload`, async ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'prediction');
    if (ctx instanceof Response) return ctx;
    const model = models(ctx.projectId).find((m) => m.id === Number(params.mid));
    if (!model) return detail(404, `找不到模型 ${String(params.mid)}`);
    const form = await request.formData();
    const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
    if (files.length === 0) return detail(422, '請上傳至少一個檔案');
    if (model.kind.startsWith('image_')) {
      // 掃毒：檔名含 eicar 的檔案模擬被攔下，其餘照常推論
      const blocked = files.filter((f) => /eicar/i.test(f.name)).map((f) => ({ name: f.name, reason: '掃毒攔截：Eicar-Signature' }));
      const clean = files.filter((f) => !/eicar/i.test(f.name));
      if (clean.length === 0) return json({ detail: { code: 'all_files_blocked', message: '所有檔案都未通過掃毒，已拒絕', blocked } }, 422);
      const results = clean.map((f) => imageResult(model, f.name));
      return json(view(store(ctx, model, 'upload', { results, label_names: model.card.label_names ?? [], blocked })), 201);
    }
    const { columns, rows } = parseCsv(await files[0].text());
    const missing = FEATURES.filter((f) => !columns.includes(f));
    if (missing.length) return detail(422, `資料缺少特徵欄位：${missing.join('、')}`);
    return json(view(store(ctx, model, 'upload', tabular(rows, columns))), 201);
  }),
  http.get(`${API}/inference/:iid`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'prediction');
    if (ctx instanceof Response) return ctx;
    const r = records.find((x) => x.id === Number(params.iid) && x.project_id === ctx.projectId);
    return r ? json(view(r)) : detail(404, `找不到推論紀錄 ${String(params.iid)}`);
  }),
  http.get(`${API}/inference/:iid/download`, ({ request, params }) => {
    const ctx = authorize(request, params.pid, 'prediction');
    if (ctx instanceof Response) return ctx;
    const r = records.find((x) => x.id === Number(params.iid) && x.project_id === ctx.projectId);
    if (!r) return detail(404, `找不到推論紀錄 ${String(params.iid)}`);
    return new HttpResponse(r.download, {
      headers: {
        'Content-Type': r.result_format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
        'Content-Disposition': `attachment; filename="inference-${r.id}.${r.result_format}"`,
      },
    });
  }),
];

/** 測試用：清掉推論紀錄 */
export function resetInferenceMock() {
  records.length = 0;
}
