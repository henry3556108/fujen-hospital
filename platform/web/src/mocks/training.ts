// MSW：建模管理與 AI 模型部署（/api/projects/:pid/training/*、/models/:mid/download、/deployments）。
// 路徑、權限、狀態碼、錯誤訊息照 platform/api/app/training；設定的正規化照 config.py（存檔 → 重新載入逐欄相同）。
// 只在 dev server 與單元測試使用。
//
// 訓練狀態：送出後是「排隊中」；之後查詢（清單或單筆）第 2 次變執行中、第 3 次完成，每個狀態至少停留 trainingMockOptions.stepMs。
// 設定名稱含「失敗」的訓練會以失敗結束，用來示範失敗訊息。
import { http, HttpResponse } from 'msw';
import type { Model } from '../pages/inference/api';
import type {
  Catalogue,
  Deployment,
  ParamSpec,
  RunStatus,
  TrainingConfig,
  TrainingKind,
  TrainingRun,
  TrainingSetting,
} from '../pages/training/api';
import { models as projectModels } from './inference';
import { API, detail, isoNow, json, jsonBody, moduleState, noContent, requireProject } from './support';
import { mockDb } from './handlers';

const P = `${API}/projects/:pid`;

// ---------------------------------------------------------------- 設定的正規化（照 config.py）

const IMAGE_KINDS: TrainingKind[] = ['image_classification', 'image_segmentation', 'image_detection'];
const TABULAR_KINDS: TrainingKind[] = ['tabular_classification', 'tabular_regression'];
const KIND_NAMES: Record<TrainingKind, string> = {
  image_classification: '影像分類', image_segmentation: '影像分割', image_detection: '物件偵測',
  tabular_classification: '結構式分類', tabular_regression: '結構式迴歸',
};
const FORMAT = (kind: TrainingKind) => (kind.startsWith('image_') ? 'h5' : 'pkl');
const SOURCE_TYPES: Record<TrainingKind, string[]> = {
  image_classification: ['dicom'], image_detection: ['dicom'], image_segmentation: ['files', 'dicom'],
  tabular_classification: ['tabular'], tabular_regression: ['tabular'],
};
type Spec = [title: string, type: 'int' | 'float' | 'bool', min: number | null, max: number | null, def: number | boolean | null];
const AUGMENTATION: Record<string, Spec> = {
  rotation_range: ['旋轉角度範圍（度）', 'float', 0, 180, 0],
  width_shift_range: ['寬度位移比例', 'float', 0, 1, 0],
  height_shift_range: ['長度位移比例', 'float', 0, 1, 0],
  shear_range: ['Shear 角度範圍（度）', 'float', 0, 89, 0],
  zoom_range: ['Zoom 比例範圍', 'float', 0, 0.99, 0],
  horizontal_flip: ['水平翻轉', 'bool', null, null, false],
  vertical_flip: ['垂直翻轉', 'bool', null, null, false],
};
const IMAGE_HYPER: Record<string, Spec> = {
  epochs: ['訓練回合數', 'int', 1, 1000, 3],
  batch_size: ['批次大小', 'int', 1, 1024, 8],
  learning_rate: ['學習率', 'float', 1e-7, 1, 0.001],
  filters: ['卷積濾波器數', 'int', 1, 256, 8],
  augmentation_copies: ['每張影像的增強份數', 'int', 0, 10, 1],
};
const FOREST: Record<string, Spec> = {
  n_estimators: ['樹的數量', 'int', 1, 2000, 50],
  max_depth: ['最大深度', 'int', 1, 100, null],
  min_samples_leaf: ['葉節點最少樣本數', 'int', 1, 1000, 1],
};
const BOOSTING: Record<string, Spec> = {
  n_estimators: ['樹的數量', 'int', 1, 2000, 50],
  learning_rate: ['學習率', 'float', 1e-4, 10, 0.1],
  max_depth: ['最大深度', 'int', 1, 32, 3],
};
const ALGORITHMS: Partial<Record<TrainingKind, Record<string, Record<string, Spec>>>> = {
  tabular_classification: {
    logistic_regression: { C: ['正則化強度的倒數', 'float', 1e-6, 1e6, 1], max_iter: ['最大迭代次數', 'int', 10, 100000, 1000] },
    random_forest: FOREST,
    gradient_boosting: BOOSTING,
  },
  tabular_regression: {
    linear_regression: { fit_intercept: ['包含截距', 'bool', null, null, true] },
    random_forest: FOREST,
    gradient_boosting: BOOSTING,
  },
};
const HYPER: Partial<Record<TrainingKind, Record<string, Spec>>> = {
  image_classification: IMAGE_HYPER,
  image_segmentation: IMAGE_HYPER,
  image_detection: { ...IMAGE_HYPER, max_boxes: ['每張影像最多方框數', 'int', 1, 20, 2] },
};
const FAKE_HYPER: Record<string, Spec> = { fake_sleep_seconds: ['fake-trainer 等待秒數', 'float', 0, 600, null] };

class ConfigError extends Error {}
type Obj = Record<string, unknown>;

function dict(value: unknown, title: string): Obj {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`「${title}」格式錯誤，必須是物件`);
  return value as Obj;
}

function number(value: unknown, type: Spec[1], title: string, low: number | null, high: number | null): number | boolean {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new ConfigError(`「${title}」必須是 true 或 false`);
    return value;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) throw new ConfigError(`「${title}」必須是數值`);
  if (type === 'int' && !Number.isInteger(value)) throw new ConfigError(`「${title}」必須是整數`);
  if ((low !== null && value < low) || (high !== null && value > high)) throw new ConfigError(`「${title}」必須介於 ${low} 與 ${high} 之間`);
  return value;
}

function unknownKeys(raw: Obj, allowed: string[]) {
  return Object.keys(raw).filter((k) => !allowed.includes(k)).sort();
}

function augmentation(value: unknown) {
  const raw = dict(value, '資料增強');
  const extra = unknownKeys(raw, Object.keys(AUGMENTATION));
  if (extra.length) throw new ConfigError(`不支援的資料增強設定：${extra.join('、')}`);
  return Object.fromEntries(
    Object.entries(AUGMENTATION).map(([k, [title, type, low, high, def]]) => [k, k in raw ? number(raw[k], type, title, low, high) : def]),
  ) as Record<string, number | boolean>;
}

function split(value: unknown) {
  let raw = dict(value, '資料切分');
  if (Object.keys(raw).length === 0) raw = { train: 0.6, validation: 0.2, test: 0.2 };
  const extra = unknownKeys(raw, ['train', 'validation', 'test']);
  if (extra.length) throw new ConfigError(`資料切分只能有 train、validation、test，多了：${extra.join('、')}`);
  const out = Object.fromEntries(
    (['train', 'validation', 'test'] as const).map((k) => [k, number(raw[k] ?? 0, 'float', `資料切分 ${k}`, 0, 1) as number]),
  ) as { train: number; validation: number; test: number };
  if (out.train <= 0) throw new ConfigError('訓練集比例必須大於 0');
  if (Math.abs(out.train + out.validation + out.test - 1) > 1e-6) throw new ConfigError('訓練、驗證、測試的比例總和必須等於 1');
  return out;
}

function hyperparameters(value: unknown, allowed: Record<string, Spec>) {
  const raw = dict(value, '超參數');
  const all = { ...allowed, ...FAKE_HYPER };
  const extra = unknownKeys(raw, Object.keys(all));
  if (extra.length) throw new ConfigError(`不支援的超參數：${extra.join('、')}（可用：${Object.keys(all).join('、')}）`);
  const out: Record<string, number | boolean> = {};
  for (const [k, [title, type, low, high, def]] of Object.entries(all)) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = number(raw[k], type, title, low, high);
    else if (def !== null && !(k in FAKE_HYPER)) out[k] = def;
  }
  return out;
}

function labels(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) throw new ConfigError('Label 清單必須是非空字串的清單');
  const out = (value as string[]).map((v) => v.trim());
  if (new Set(out).size !== out.length) throw new ConfigError('Label 清單有重複的名稱');
  return out;
}

function image(value: unknown, kind: TrainingKind) {
  const raw = dict(value, '影像設定');
  const extra = unknownKeys(raw, ['resize', 'labels']);
  if (extra.length) throw new ConfigError(`不支援的影像設定：${extra.join('、')}`);
  const resizeRaw = raw.resize ?? [32, 32];
  if (!Array.isArray(resizeRaw) || resizeRaw.length !== 2) throw new ConfigError('Resize 必須是 [高, 寬]');
  const resize = resizeRaw.map((v) => number(v, 'int', 'Resize', 8, 1024) as number);
  if (kind === 'image_segmentation' && (resize[0] % 2 || resize[1] % 2)) throw new ConfigError('影像分割的 Resize 高與寬必須是偶數');
  const names = labels(raw.labels);
  if (kind === 'image_segmentation' && !names?.length) {
    throw new ConfigError('影像分割必須指定前景類別名稱（image.labels，順序對應遮罩值 1、2、…）');
  }
  if (kind === 'image_classification' && names !== null && names.length < 2) throw new ConfigError('影像分類至少需要 2 種 Label');
  return { resize, labels: names };
}

function selection(value: unknown, title: string): 'all' | string[] {
  if (value === undefined || value === null || value === 'all') return 'all';
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === 'string' && v)) {
    throw new ConfigError(`「${title}」必須是 "all" 或非空的清單`);
  }
  if (new Set(value).size !== value.length) throw new ConfigError(`「${title}」有重複的項目`);
  return [...(value as string[])].sort();
}

function source(value: unknown, kind: TrainingKind) {
  const raw = dict(value, '資料來源');
  const type = raw.type as string;
  if (!SOURCE_TYPES[kind].includes(type)) throw new ConfigError(`${KIND_NAMES[kind]}的資料來源 type 必須是：${SOURCE_TYPES[kind].join('、')}`);
  if (type === 'tabular') {
    if (typeof raw.dataset_id !== 'number' || !Number.isInteger(raw.dataset_id)) throw new ConfigError('請指定結構式資料集（source.dataset_id）');
    return { type, dataset_id: raw.dataset_id };
  }
  if (type === 'files') {
    if (raw.format !== 'nifti' && raw.format !== 'itk') throw new ConfigError('資料來源 format 必須是 nifti 或 itk');
    return { type, format: raw.format, cases: selection(raw.cases, '病例清單') };
  }
  const ls = dict(raw.label_source, '標註來源');
  const provider = Object.keys(ls).length ? ls.provider : 'makesense';
  if (typeof provider !== 'string' || !provider) throw new ConfigError('請指定標註來源（label_source.provider）');
  const label_source: Obj = { provider };
  if (provider === 'inline') {
    if (!['study', 'accession', 'sop'].includes(ls.by as string)) throw new ConfigError('inline 標註的 by 必須是 study、accession 或 sop');
    const values = ls.values as Record<string, string>;
    if (!values || typeof values !== 'object' || !Object.keys(values).length) throw new ConfigError('inline 標註的 values 必須是「識別碼 → Label」的對照');
    label_source.by = ls.by;
    label_source.values = Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return { type, studies: selection(raw.studies, '研究清單'), label_source };
}

function tabular(value: unknown, kind: TrainingKind) {
  const raw = dict(value, '結構式設定');
  const extra = unknownKeys(raw, ['target', 'features', 'steps', 'algorithm']);
  if (extra.length) throw new ConfigError(`不支援的結構式設定：${extra.join('、')}`);
  const algorithms = ALGORITHMS[kind]!;
  const algorithm = (raw.algorithm as string) || Object.keys(algorithms)[0];
  if (!(algorithm in algorithms)) throw new ConfigError(`${KIND_NAMES[kind]}可用的演算法：${Object.keys(algorithms).join('、')}`);
  if (typeof raw.target !== 'string' || !raw.target) throw new ConfigError('請指定目標欄位（Target）');
  const features = raw.features;
  if (!Array.isArray(features) || features.length === 0) throw new ConfigError('請至少選擇一個特徵欄位（Feature）');
  if (features.includes(raw.target)) throw new ConfigError(`目標欄位「${raw.target}」不可同時作為特徵欄位`);
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return { value: { target: raw.target, features: [...features], steps, algorithm }, allowed: algorithms[algorithm] };
}

export function normalise(data: unknown): TrainingConfig {
  const raw = dict(data, '訓練設定');
  const extra = unknownKeys(raw, ['version', 'kind', 'source', 'split', 'seed', 'image', 'tabular', 'augmentation', 'hyperparameters']);
  if (extra.length) throw new ConfigError(`不支援的設定欄位：${extra.join('、')}`);
  if ((raw.version ?? 1) !== 1) throw new ConfigError(`不支援的設定版本：${String(raw.version)}`);
  const kind = raw.kind as TrainingKind;
  if (![...IMAGE_KINDS, ...TABULAR_KINDS].includes(kind)) throw new ConfigError(`訓練種類必須是：${[...IMAGE_KINDS, ...TABULAR_KINDS].join('、')}`);
  const out: Obj = { version: 1, kind, source: source(raw.source, kind), split: split(raw.split),
    seed: number(raw.seed ?? 42, 'int', '亂數種子', 0, 2 ** 31 - 1) };
  if (IMAGE_KINDS.includes(kind)) {
    if (raw.tabular) throw new ConfigError('影像訓練不可帶結構式設定（tabular）');
    out.image = image(raw.image, kind);
    out.augmentation = augmentation(raw.augmentation);
    out.hyperparameters = hyperparameters(raw.hyperparameters, HYPER[kind]!);
  } else {
    if (raw.image || raw.augmentation) throw new ConfigError('結構式訓練不可帶影像設定或資料增強');
    const t = tabular(raw.tabular, kind);
    out.tabular = t.value;
    out.hyperparameters = hyperparameters(raw.hyperparameters, t.allowed);
  }
  return out as unknown as TrainingConfig;
}

const describe = (params: Record<string, Spec>): ParamSpec[] =>
  Object.entries(params).map(([name, [title, type, minimum, maximum, def]]) => ({
    name, title, type, minimum, maximum, default: def ?? (type === 'bool' ? false : null),
  }));

export const CATALOGUE: Catalogue = {
  kinds: [...IMAGE_KINDS, ...TABULAR_KINDS].map((kind) => ({
    kind, name: KIND_NAMES[kind], model_format: FORMAT(kind), source_types: SOURCE_TYPES[kind] as ('dicom' | 'files' | 'tabular')[],
    ...(HYPER[kind]
      ? { hyperparameters: describe(HYPER[kind]!) }
      : { algorithms: Object.entries(ALGORITHMS[kind]!).map(([name, p]) => ({ name, hyperparameters: describe(p) })) }),
  })),
  augmentation: describe(AUGMENTATION),
  default_split: { train: 0.6, validation: 0.2, test: 0.2 },
  executors: ['template', 'fake'],
};

// ---------------------------------------------------------------- 狀態

interface StoredRun extends TrainingRun {
  ticks: number;
  fail: boolean;
  /** 上一次狀態改變的時間（毫秒） */
  changedMs: number;
}

interface StoredModel extends Model {
  project_id: number;
}

interface State {
  settings: TrainingSetting[];
  runs: StoredRun[];
  models: StoredModel[];
  deployments: Deployment[];
  nextSetting: number;
  nextRun: number;
  nextModel: number;
  nextDeployment: number;
}

const seed = (): State => ({ settings: [], runs: [], models: [], deployments: [], nextSetting: 1, nextRun: 1, nextModel: 1, nextDeployment: 1 });
const state = () => moduleState('training', seed);

/** 測試用：直接看或改模擬狀態。 */
export function trainingMock(): State {
  return state();
}

/** 在這個模擬裡訓練完成的模型（推論服務管理的模型清單也會列出）。 */
export function trainedModels(projectId: number): Model[] {
  return state().models.filter((m) => m.project_id === projectId).map(({ project_id: _p, ...m }) => m);
}

const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';

function metricsFor(kind: TrainingKind, id: number): Record<string, unknown> {
  const score = Number((0.7 + ((id * 37) % 25) / 100).toFixed(4));
  const samples = { train: 6, validation: 2, test: 2 };
  switch (kind) {
    case 'image_classification':
      return { samples, training_samples: 12, validation: { accuracy: score }, test: { accuracy: score } };
    case 'image_segmentation':
      return { samples, training_samples: 12, test: { pixel_accuracy: score, dice: Number((score - 0.1).toFixed(4)) } };
    case 'image_detection':
      return { samples, training_samples: 12, test: { mean_iou: Number((score - 0.2).toFixed(4)) } };
    case 'tabular_classification':
      return { rows: { train: 60, validation: 20, test: 20 }, test: { accuracy: score, f1_macro: Number((score - 0.05).toFixed(4)) } };
    default:
      return { rows: { train: 60, validation: 20, test: 20 }, test: { r2: Number((score - 0.3).toFixed(4)), rmse: 12.5 } };
  }
}

/** 瀏覽器裡每個狀態至少停留 stepMs，畫面上看得到排隊中與執行中；單元測試設為 0，只看查詢次數。 */
export const trainingMockOptions = { stepMs: 1200 };

/** 查詢時往前推一步：排隊中 → 執行中 → 完成（或失敗）。 */
function advance(run: StoredRun) {
  if (!['queued', 'running'].includes(run.status)) return;
  if (Date.now() - run.changedMs < trainingMockOptions.stepMs) return;
  run.ticks += 1;
  if (run.ticks === 1) return; // 第一次查詢仍在排隊，畫面上看得到「排隊中」
  run.changedMs = Date.now();
  if (run.ticks === 2) {
    run.status = 'running';
    run.started_at = isoNow();
    return;
  }
  run.finished_at = isoNow();
  if (run.fail) {
    run.status = 'failed';
    run.message = '訓練工作失敗：訓練資料不足，驗證集沒有任何資料（模擬）';
    return;
  }
  const s = state();
  const fmt = FORMAT(run.kind);
  run.status = 'succeeded';
  run.metrics = metricsFor(run.kind, run.id);
  const sha = (run.id * 2654435761).toString(16).padStart(8, '0').repeat(8).slice(0, 64);
  run.artifacts = { [`model.${fmt}`]: { sha256: sha, size: 20480 + run.id }, 'metrics.json': { sha256: 'a'.repeat(64), size: 120 } };
  const name = `${run.name}-run${run.id}`.slice(0, 128);
  const model: StoredModel = {
    id: 1000 + s.nextModel++, project_id: run.project_id, name, kind: run.kind, format: fmt, sha256: sha, filename: `${slug(name)}.${fmt}`,
    created_by: run.created_by, created_at: isoNow(),
    card: run.config.image
      ? { label_names: run.config.image.labels ?? ['A', 'B'], input: { resize: [...run.config.image.resize] }, metrics: run.metrics }
      : { target: run.config.tabular?.target, features: run.config.tabular?.features, metrics: run.metrics },
  };
  s.models.push(model);
  run.model_id = model.id;
}

const runOut = ({ ticks: _t, fail: _f, changedMs: _c, ...run }: StoredRun): TrainingRun => run;

function configError(fn: () => Response): Response {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) return detail(422, err.message);
    throw err;
  }
}

function checkName(name: unknown): string | Response {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 128) return detail(422, '請輸入設定名稱（1 到 128 個字）');
  return name.trim();
}

function newRun(ctx: { user: { username: string }; project: { id: number } }, from: { setting_id: number | null; name: string; kind: TrainingKind;
  config: TrainingConfig; executor: string; parent_run_id: number | null }): StoredRun {
  const s = state();
  const id = s.nextRun++;
  const run: StoredRun = {
    id, project_id: ctx.project.id, setting_id: from.setting_id, name: from.name, kind: from.kind, executor: from.executor,
    status: 'queued', message: '', seed: from.config.seed, config: JSON.parse(JSON.stringify(from.config)) as TrainingConfig,
    dataset_version_id: id, job_id: 100 + id, parent_run_id: from.parent_run_id, metrics: {}, artifacts: {},
    created_by: ctx.user.username, created_at: isoNow(), started_at: null, finished_at: null, custom_source: false, model_id: null,
    ticks: 0, fail: from.name.includes('失敗'), changedMs: Date.now(),
  };
  s.runs.push(run);
  return run;
}

function findRun(projectId: number, id: unknown): StoredRun | Response {
  return state().runs.find((r) => r.id === Number(id) && r.project_id === projectId) ?? detail(404, `找不到訓練 ${String(id)}`);
}

function findModel(projectId: number, id: unknown): Model | Response {
  return projectModels(projectId).find((m) => m.id === Number(id)) ?? detail(404, `找不到模型 ${String(id)}`);
}

const DEPLOY_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function users(value: unknown): string[] | Response {
  if (!Array.isArray(value) || !value.every((n) => typeof n === 'string' && n)) return detail(422, 'allowed_users 必須是帳號名稱的清單');
  const names = [...new Set(value as string[])].sort();
  const known = new Set(mockDb().users.map((u) => u.username));
  const missing = names.filter((n) => !known.has(n));
  return missing.length ? detail(422, `帳號不存在：${missing.join('、')}`) : names;
}

function file(body: BodyInit, filename: string, type: string, sha256?: string) {
  return new HttpResponse(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...(sha256 ? { 'X-Content-SHA256': sha256 } : {}),
    },
  });
}

// ---------------------------------------------------------------- handlers

export const trainingHandlers = [
  http.get(`${P}/training/catalogue`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    return ctx instanceof Response ? ctx : json(CATALOGUE);
  }),

  http.get(`${P}/training/settings`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    return json(state().settings.filter((x) => x.project_id === ctx.project.id));
  }),
  http.post(`${P}/training/settings`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const b = await jsonBody(request);
    const name = checkName(b.name);
    if (name instanceof Response) return name;
    return configError(() => {
      const config = normalise(b.config);
      const s = state();
      if (s.settings.some((x) => x.project_id === ctx.project.id && x.name === name)) return detail(409, `訓練設定「${name}」已存在`);
      const now = isoNow();
      const row: TrainingSetting = { id: s.nextSetting++, project_id: ctx.project.id, name, kind: config.kind, config,
        created_by: ctx.user.username, updated_by: ctx.user.username, created_at: now, updated_at: now };
      s.settings.push(row);
      return json(row, 201);
    });
  }),
  http.get(`${P}/training/settings/:sid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const row = state().settings.find((x) => x.id === Number(params.sid) && x.project_id === ctx.project.id);
    return row ? json(row) : detail(404, `找不到訓練設定 ${String(params.sid)}`);
  }),
  http.put(`${P}/training/settings/:sid`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const row = state().settings.find((x) => x.id === Number(params.sid) && x.project_id === ctx.project.id);
    if (!row) return detail(404, `找不到訓練設定 ${String(params.sid)}`);
    const b = await jsonBody(request);
    const name = checkName(b.name);
    if (name instanceof Response) return name;
    return configError(() => {
      const config = normalise(b.config);
      if (state().settings.some((x) => x.project_id === ctx.project.id && x.name === name && x.id !== row.id)) {
        return detail(409, `訓練設定「${name}」已存在`);
      }
      Object.assign(row, { name, kind: config.kind, config, updated_by: ctx.user.username, updated_at: isoNow() });
      return json(row);
    });
  }),
  http.delete(`${P}/training/settings/:sid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const s = state();
    const row = s.settings.find((x) => x.id === Number(params.sid) && x.project_id === ctx.project.id);
    if (!row) return detail(404, `找不到訓練設定 ${String(params.sid)}`);
    s.settings = s.settings.filter((x) => x !== row);
    for (const run of s.runs) if (run.setting_id === row.id) run.setting_id = null;
    return noContent();
  }),

  http.post(`${P}/training/settings/:sid/runs`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const setting = state().settings.find((x) => x.id === Number(params.sid) && x.project_id === ctx.project.id);
    if (!setting) return detail(404, `找不到訓練設定 ${String(params.sid)}`);
    const b = await jsonBody(request);
    const executor = typeof b.executor === 'string' ? b.executor : 'template';
    if (!CATALOGUE.executors.includes(executor)) return detail(422, `執行方式必須是：${CATALOGUE.executors.join('、')}`);
    const run = newRun(ctx, { setting_id: setting.id, name: setting.name, kind: setting.kind, config: setting.config, executor, parent_run_id: null });
    return json(runOut(run), 201);
  }),
  http.get(`${P}/training/runs`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const runs = state().runs.filter((r) => r.project_id === ctx.project.id);
    runs.forEach(advance);
    return json(runs.map(runOut));
  }),
  http.get(`${P}/training/runs/:rid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    advance(run);
    return json(runOut(run));
  }),
  http.post(`${P}/training/runs/:rid/cancel`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    if (!['queued', 'running'].includes(run.status)) return detail(409, `訓練 ${run.id} 已結束（${run.status}），無法取消`);
    Object.assign(run, { status: 'cancelled' as RunStatus, finished_at: isoNow(), message: `由 ${ctx.user.username} 取消` });
    return json(runOut(run));
  }),
  http.post(`${P}/training/runs/:rid/rerun`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    const clone = newRun(ctx, { setting_id: run.setting_id, name: run.name, kind: run.kind, config: run.config, executor: run.executor, parent_run_id: run.id });
    clone.dataset_version_id = run.dataset_version_id;
    return json(runOut(clone), 201);
  }),
  http.get(`${P}/training/runs/:rid/log`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    const log = run.status === 'queued' ? '' : [
      `[runner] 下載資料包：資料版本 ${run.dataset_version_id}`,
      `[template] ${KIND_NAMES[run.kind]}，亂數種子 ${run.seed}`,
      ...(run.status === 'running' ? ['[template] 訓練中…'] : []),
      ...(run.status === 'succeeded' ? [`[template] 完成，輸出 model.${FORMAT(run.kind)}`] : []),
      ...(run.status === 'failed' ? [`[template] ${run.message}`] : []),
    ].join('\n');
    return json({ run_id: run.id, status: run.status, log });
  }),
  http.get(`${P}/training/runs/:rid/source`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'coding');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    const text = `PK\u0003\u0004 模擬的原始碼 zip：${run.kind}.py、runtime.py、config.json\n${JSON.stringify(run.config)}`;
    return file(text, `training-run-${run.id}-source.zip`, 'application/zip');
  }),

  http.get(`${P}/models/:mid/download`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const model = findModel(ctx.project.id, params.mid);
    if (model instanceof Response) return model;
    return file(`模擬的 ${model.format.toUpperCase()} 模型檔 ${model.name}`, model.filename, 'application/octet-stream', model.sha256);
  }),

  http.get(`${P}/deployments`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    return json(state().deployments.filter((d) => d.project_id === ctx.project.id));
  }),
  http.post(`${P}/deployments`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const b = await jsonBody(request);
    const model = findModel(ctx.project.id, b.model_id);
    if (model instanceof Response) return model;
    if (typeof b.name !== 'string' || !DEPLOY_NAME.test(b.name)) {
      return detail(422, '部署名稱只能用小寫英數字與連字號，開頭結尾必須是英數字，最多 63 字');
    }
    const allowed = users(b.allowed_users ?? []);
    if (allowed instanceof Response) return allowed;
    const s = state();
    if (s.deployments.some((d) => d.name === b.name)) return detail(409, `部署名稱「${b.name}」已被使用`);
    const row: Deployment = { id: s.nextDeployment++, project_id: ctx.project.id, model_id: model.id, name: b.name, allowed_users: allowed,
      endpoint: `/api/inference/${b.name}/predict`, created_by: ctx.user.username, created_at: isoNow() };
    s.deployments.push(row);
    return json(row, 201);
  }),
  http.put(`${P}/deployments/:did/access`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const row = state().deployments.find((d) => d.id === Number(params.did) && d.project_id === ctx.project.id);
    if (!row) return detail(404, `找不到部署 ${String(params.did)}`);
    const allowed = users((await jsonBody(request)).allowed_users);
    if (allowed instanceof Response) return allowed;
    row.allowed_users = allowed;
    return json(row);
  }),
  http.delete(`${P}/deployments/:did`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const s = state();
    const row = s.deployments.find((d) => d.id === Number(params.did) && d.project_id === ctx.project.id);
    if (!row) return detail(404, `找不到部署 ${String(params.did)}`);
    s.deployments = s.deployments.filter((d) => d !== row);
    return noContent();
  }),
];
