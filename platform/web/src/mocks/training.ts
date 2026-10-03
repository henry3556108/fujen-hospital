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
  Charts,
  Deployment,
  ParamSpec,
  RunStatus,
  TrainingConfig,
  TrainingKind,
  TrainingRun,
  TrainingSetting,
  ValidationMethod,
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
// 白話說明與是否收在進階設定（照 config.py 的 PARAM_HELP）
const PARAM_HELP: Record<string, [help: string, advanced: boolean]> = {
  epochs: ['模型把全部訓練影像看過幾遍。太少學不會，太多可能只記住訓練資料；先用預設值試跑，再視結果調整（常見 10～50）。', false],
  batch_size: ['一次交給模型幾張影像。電腦記憶體不足時調小；一般用預設值即可。', true],
  learning_rate: ['每一步修正模型的幅度。太大學得不穩，太小學得很慢；一般用預設值即可。', true],
  filters: ['模型的大小（每一層找幾種影像特徵）。越大越能學複雜的影像，但需要更多資料與時間；一般用預設值。', true],
  augmentation_copies: ['每張原始影像另外產生幾份「資料增強」後的影像。資料少時可設 1～3；設 0 代表不增強。', false],
  max_boxes: ['每張影像最多找出幾個方框。請設成一張影像中病灶可能出現的最多數量。', false],
  C: ['數值越小，模型越保守、越不容易只記住訓練資料；一般用預設值 1。', true],
  max_iter: ['模型最多計算幾輪來找答案。訓練輸出出現「未收斂」時再調大；一般用預設值。', true],
  n_estimators: ['用幾棵決策樹一起判斷。越多通常越穩定但訓練越久；建議 50～300。', false],
  max_depth: ['每棵樹最多連續問幾個問題。越深越能抓細節，但容易只記住訓練資料；留白代表不限制，梯度提升建議 2～5。', true],
  min_samples_leaf: ['每個最後分組至少要有幾筆資料。調大可避免被少數特殊個案帶偏；資料多時可設 5～20。', true],
  fit_intercept: ['一般保持勾選。只有確定所有特徵都是 0 時結果也應該是 0，才取消。', true],
  rotation_range: ['隨機旋轉影像的最大角度，模擬擺位不同；建議 0～15 度。', false],
  width_shift_range: ['隨機左右移動影像的最大比例（0.1 = 寬度的 10%）；建議 0～0.1。', false],
  height_shift_range: ['隨機上下移動影像的最大比例（0.1 = 高度的 10%）；建議 0～0.1。', false],
  shear_range: ['隨機把影像斜向拉扯的最大角度；一般用 0，最多 10 度。', false],
  zoom_range: ['隨機放大縮小的比例（0.1 = 90%～110%）；建議 0～0.2。', false],
  horizontal_flip: ['隨機左右翻轉。左右對稱、左右不影響判讀的影像才勾選。', false],
  vertical_flip: ['隨機上下翻轉。多數醫學影像不適合，一般不勾選。', false],
};
const VALIDATION_METHODS: ValidationMethod[] = [
  { method: 'holdout', name: '固定比例切分', help: '依上面的比例把資料分成訓練、驗證、測試三份，訓練一次。速度快，資料多（數千筆以上）時建議使用。' },
  {
    method: 'kfold', name: 'K 折交叉驗證',
    help: '先保留測試集，其餘資料平均分成 K 份，輪流拿一份檢查、其他份訓練，共訓練 K 次再取平均。結果比較穩定，資料少（幾百筆）時建議使用；K 通常用 5。',
    folds: { minimum: 2, maximum: 10, default: 5 },
  },
];
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

function validation(value: unknown) {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new ConfigError('「驗證方式」格式錯誤，必須是物件');
  const raw = (value ?? { method: 'holdout' }) as Obj;
  const extra = unknownKeys(raw, ['method', 'folds']);
  if (extra.length) throw new ConfigError(`不支援的驗證方式設定：${extra.join('、')}`);
  const method = raw.method ?? 'holdout';
  if (method === 'holdout') {
    if ('folds' in raw) throw new ConfigError('固定比例切分不需要折數（folds），要用 K 折請把 method 設為 kfold');
    return { method: 'holdout' as const };
  }
  if (method === 'kfold') return { method: 'kfold' as const, folds: number(raw.folds ?? 5, 'int', '交叉驗證折數（K）', 2, 10) as number };
  throw new ConfigError('驗證方式 method 必須是 holdout（固定比例切分）或 kfold（K 折交叉驗證）');
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
  const extra = unknownKeys(raw, ['target', 'features', 'steps', 'algorithm', 'missing']);
  if (extra.length) throw new ConfigError(`不支援的結構式設定：${extra.join('、')}`);
  const algorithms = ALGORITHMS[kind]!;
  const algorithm = (raw.algorithm as string) || Object.keys(algorithms)[0];
  if (!(algorithm in algorithms)) throw new ConfigError(`${KIND_NAMES[kind]}可用的演算法：${Object.keys(algorithms).join('、')}`);
  if (typeof raw.target !== 'string' || !raw.target) throw new ConfigError('請指定目標欄位（Target）');
  const features = raw.features;
  if (!Array.isArray(features) || features.length === 0) throw new ConfigError('請至少選擇一個特徵欄位（Feature）');
  if (features.includes(raw.target)) throw new ConfigError(`目標欄位「${raw.target}」不可同時作為特徵欄位`);
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const missing = raw.missing;
  if (missing !== undefined && missing !== 'impute' && missing !== 'drop') throw new ConfigError('缺值處理必須是 impute（補上缺值）或 drop（不使用有缺值的病人）');
  return { value: { target: raw.target, features: [...features], steps, algorithm, ...(missing ? { missing } : {}) }, allowed: algorithms[algorithm] };
}

export function normalise(data: unknown): TrainingConfig {
  const raw = dict(data, '訓練設定');
  const extra = unknownKeys(raw, ['version', 'kind', 'source', 'split', 'seed', 'validation', 'image', 'tabular', 'augmentation', 'hyperparameters']);
  if (extra.length) throw new ConfigError(`不支援的設定欄位：${extra.join('、')}`);
  if ((raw.version ?? 1) !== 1) throw new ConfigError(`不支援的設定版本：${String(raw.version)}`);
  const kind = raw.kind as TrainingKind;
  if (![...IMAGE_KINDS, ...TABULAR_KINDS].includes(kind)) throw new ConfigError(`訓練種類必須是：${[...IMAGE_KINDS, ...TABULAR_KINDS].join('、')}`);
  const out: Obj = { version: 1, kind, source: source(raw.source, kind), split: split(raw.split),
    seed: number(raw.seed ?? 42, 'int', '亂數種子', 0, 2 ** 31 - 1) };
  if (IMAGE_KINDS.includes(kind)) {
    if (raw.tabular) throw new ConfigError('影像訓練不可帶結構式設定（tabular）');
    if (raw.validation !== undefined && raw.validation !== null) throw new ConfigError('影像訓練目前只支援固定比例切分，不可設定驗證方式（validation）');
    out.image = image(raw.image, kind);
    out.augmentation = augmentation(raw.augmentation);
    out.hyperparameters = hyperparameters(raw.hyperparameters, HYPER[kind]!);
  } else {
    if (raw.image || raw.augmentation) throw new ConfigError('結構式訓練不可帶影像設定或資料增強');
    out.validation = validation(raw.validation);
    const t = tabular(raw.tabular, kind);
    out.tabular = t.value;
    out.hyperparameters = hyperparameters(raw.hyperparameters, t.allowed);
  }
  return out as unknown as TrainingConfig;
}

const describe = (params: Record<string, Spec>): ParamSpec[] =>
  Object.entries(params).map(([name, [title, type, minimum, maximum, def]]) => ({
    name, title, type, minimum, maximum, default: def ?? (type === 'bool' ? false : null),
    help: PARAM_HELP[name]?.[0] ?? '', advanced: PARAM_HELP[name]?.[1] ?? false,
  }));

export const CATALOGUE: Catalogue = {
  kinds: [...IMAGE_KINDS, ...TABULAR_KINDS].map((kind) => ({
    kind, name: KIND_NAMES[kind], model_format: FORMAT(kind), source_types: SOURCE_TYPES[kind] as ('dicom' | 'files' | 'tabular')[],
    ...(HYPER[kind]
      ? { hyperparameters: describe(HYPER[kind]!) }
      : {
          algorithms: Object.entries(ALGORITHMS[kind]!).map(([name, p]) => ({ name, hyperparameters: describe(p) })),
          validation_methods: VALIDATION_METHODS,
        }),
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

const r4 = (v: number) => Number(v.toFixed(4));

function metricsFor(run: StoredRun): Record<string, unknown> {
  const { kind, id } = run;
  const score = r4(0.7 + ((id * 37) % 25) / 100);
  const samples = { train: 6, validation: 2, test: 2 };
  const kfold = run.config.validation?.method === 'kfold' ? run.config.validation.folds : 0;
  const cv = (names: [string, number][]) => ({
    method: 'kfold', folds: kfold, stratified: kind === 'tabular_classification', rows: 80,
    ...Object.fromEntries(names.map(([n, base]) => {
      const values = Array.from({ length: kfold }, (_, i) => r4(base + ((i % 3) - 1) * 0.03));
      const mean = values.reduce((a, b) => a + b, 0) / kfold;
      const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / kfold);
      return [n, { mean: r4(mean), std: r4(std), values }];
    })),
  });
  const full = kfold ? { train: 80, validation: 0, test: 20 } : { train: 60, validation: 20, test: 20 };
  // 模擬資料的 glucose 有 5 位缺值（訓練 3、驗證 1、測試 1；K 折時訓練 4、測試 1）
  const gaps = (run.config.tabular?.features ?? []).includes('glucose')
    ? (kfold ? { train: 4, validation: 0, test: 1 } : { train: 3, validation: 1, test: 1 })
    : { train: 0, validation: 0, test: 0 };
  const impute = run.config.tabular?.missing === 'impute';
  const splitNames = ['train', 'validation', 'test'] as const;
  const rows = impute ? full : Object.fromEntries(splitNames.map((k) => [k, full[k] - gaps[k]])) as typeof full;
  const data = {
    missing: impute ? 'impute' : 'drop', total: 100, used: rows,
    left_out: Object.fromEntries(splitNames.map((k) => [k, { missing_target: 0, missing_feature: impute ? 0 : gaps[k] }])),
    filled: Object.fromEntries(splitNames.map((k) => [k, impute ? gaps[k] : 0])),
    missing_columns: gaps.train + gaps.test ? { glucose: 5 } : {},
  };
  switch (kind) {
    case 'image_classification':
      return { samples, training_samples: 12, validation: { accuracy: score }, test: { accuracy: score } };
    case 'image_segmentation':
      return { samples, training_samples: 12, test: { pixel_accuracy: score, dice: r4(score - 0.1) } };
    case 'image_detection':
      return { samples, training_samples: 12, test: { mean_iou: r4(score - 0.2) } };
    case 'tabular_classification': {
      const test = { accuracy: score, f1_macro: r4(score - 0.05), auc: r4(Math.min(0.99, score + 0.05)), sensitivity: 0.7, specificity: 0.75, baseline_accuracy: 0.55 };
      const train = { ...test, accuracy: r4(Math.min(1, score + 0.05)) };
      return {
        rows, data, train, ...(kfold ? {} : { validation: test }), test,
        labels: { majority: '0', positive: '1', majority_train: { count: Math.round(rows.train * 0.6), rows: rows.train } },
        ...(kfold ? { cv: cv([['accuracy', score], ['f1_macro', score - 0.05], ['auc', Math.min(0.96, score + 0.05)], ['sensitivity', 0.72], ['specificity', 0.8], ['baseline_accuracy', 0.6]]) } : {}),
      };
    }
    default: {
      const test = { r2: r4(score - 0.3), mae: 9.8, rmse: 12.5, baseline_rmse: 16.2 };
      return { rows, data, test, ...(kfold ? { cv: cv([['r2', score - 0.3], ['mae', 9.8], ['rmse', 12.5]]) } : {}) };
    }
  }
}

/** 模擬的 charts.json：形狀照 tabularkit.charts()；只有結構式且非快速測試的訓練才有。 */
export function chartsFor(run: TrainingRun): Charts | null {
  if (run.kind.startsWith('image_') || run.executor === 'fake' || run.status !== 'succeeded') return null;
  const features = run.config.tabular?.features ?? [];
  const importance = {
    method: 'permutation', metric: run.kind === 'tabular_classification' ? 'accuracy' : 'r2', repeats: 5,
    items: features.map((feature, i) => ({ feature, mean: r4(0.12 / (i + 1)), std: r4(0.01 / (i + 1)) })),
  };
  const base = { version: 1, kind: run.kind, subset: 'test' as const, rows: 20, feature_importance: importance };
  if (run.kind === 'tabular_classification') {
    return {
      ...base, regression: null,
      confusion_matrix: { labels: ['0', '1'], matrix: [[9, 2], [3, 6]] },
      roc: { positive: '1', auc: (run.metrics.test as { auc: number }).auc,
        points: [[0, 0], [0, 0.4], [0.1, 0.55], [0.2, 0.7], [0.35, 0.85], [0.6, 0.95], [1, 1]] },
    };
  }
  const points: [number, number][] = Array.from({ length: 20 }, (_, i) => [110 + i * 3, r4(112 + i * 2.7 + ((i * 7) % 5) - 2)]);
  return {
    ...base, confusion_matrix: null, roc: null,
    regression: {
      points, total: 20, sampled: false,
      residuals: [{ start: -6, end: -3, count: 3 }, { start: -3, end: 0, count: 7 }, { start: 0, end: 3, count: 7 }, { start: 3, end: 6, count: 3 }],
    },
  };
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
    run.message = '訓練資料不足，驗證集沒有任何資料（模擬）\n---\n訓練程式以 1 結束：\nTraceback (most recent call last):\n  File "/work/template/runtime.py", line 131, in main\nValueError: 訓練資料不足，驗證集沒有任何資料（模擬）';
    return;
  }
  const s = state();
  const fmt = FORMAT(run.kind);
  run.status = 'succeeded';
  run.metrics = metricsFor(run);
  const sha = (run.id * 2654435761).toString(16).padStart(8, '0').repeat(8).slice(0, 64);
  run.artifacts = { [`model.${fmt}`]: { sha256: sha, size: 20480 + run.id }, 'metrics.json': { sha256: 'a'.repeat(64), size: 120 } };
  if (chartsFor(run)) run.artifacts['charts.json'] = { sha256: 'c'.repeat(64), size: 2048 };
  const name = `${run.name}-run${run.id}`.slice(0, 128);
  const model: StoredModel = {
    id: 1000 + s.nextModel++, project_id: run.project_id, name, kind: run.kind, format: fmt, sha256: sha, filename: `${slug(name)}.${fmt}`,
    created_by: run.created_by, created_at: isoNow(),
    card: run.config.image
      ? { label_names: run.config.image.labels ?? ['A', 'B'], input: { resize: [...run.config.image.resize] }, metrics: run.metrics }
      : {
          target: run.config.tabular?.target, features: run.config.tabular?.features, metrics: run.metrics,
          missing: run.config.tabular?.missing ?? 'drop',
          ...(run.kind === 'tabular_classification' ? { classes: ['0', '1'] } : {}),
          // 推論時給原始欄位：One-Hot 產生的 sex_F、smoker_never… 對回 sex、smoker
          inputs: [...new Set((run.config.tabular?.features ?? []).map((f) => f.replace(/^(sex|smoker)_.*$/, '$1')))].map((name) =>
            ['sex', 'smoker'].includes(name)
              ? { name, type: 'category' as const, values: name === 'sex' ? ['F', 'M'] : ['current', 'former', 'never'] }
              : { name, type: 'number' as const, min: 0, max: 200 }),
        },
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

/** 授權帳號中不是專案成員或沒有 Prediction 權限的人（照 service.without_platform_access）。 */
function deploymentOut(row: Deployment): Deployment {
  const db = mockDb();
  const able = new Set(db.memberships.filter((m) => m.project_id === row.project_id && m.permissions.includes('prediction'))
    .map((m) => db.users.find((u) => u.id === m.user_id)?.username));
  return { ...row, cannot_use_in_platform: row.allowed_users.filter((u) => !able.has(u)) };
}

/** 模型的顯示名稱（照 service.model_titles）：優先用分享給這位使用者的最新一次，否則用最新一次分享。 */
export function modelTitles(projectId: number, username: string): Map<number, string> {
  const newest = new Map<number, string>();
  const mine = new Map<number, string>();
  for (const d of [...state().deployments].sort((a, b) => a.id - b.id)) {
    if (d.project_id !== projectId || !d.title) continue;
    newest.set(d.model_id, d.title);
    if (d.allowed_users.includes(username)) mine.set(d.model_id, d.title);
  }
  return new Map([...newest, ...mine]);
}

/** 分享給這位使用者的模型（模型編號 → 分享者），照 service.shared_with。 */
export function sharedWith(projectId: number, username: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const d of state().deployments) {
    if (d.project_id === projectId && d.allowed_users.includes(username) && d.created_by !== username && !out.has(d.model_id)) out.set(d.model_id, d.created_by);
  }
  return out;
}

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
  http.get(`${P}/training/runs/:rid/charts`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    return json({ run_id: run.id, kind: run.kind, charts: chartsFor(run) });
  }),
  http.get(`${P}/training/runs/:rid/report`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const run = findRun(ctx.project.id, params.rid);
    if (run instanceof Response) return run;
    if (run.status === 'queued' || run.status === 'running') return detail(409, `訓練 ${run.id} 尚未完成，完成後才能下載報表`);
    if (run.status !== 'succeeded') return detail(409, `訓練 ${run.id} 沒有成功完成（${run.status}），沒有可下載的報表`);
    const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>訓練報表：${run.name}（訓練 #${run.id}）</title>` +
      `<h1>訓練報表：${run.name}（訓練 #${run.id}）</h1><pre>${JSON.stringify(run.metrics, null, 2)}</pre></html>`;
    return file(html, `training-run-${run.id}-report.html`, 'text/html; charset=utf-8');
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
    return json(state().deployments.filter((d) => d.project_id === ctx.project.id).map(deploymentOut));
  }),
  http.post(`${P}/deployments`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const b = await jsonBody(request);
    const model = findModel(ctx.project.id, b.model_id);
    if (model instanceof Response) return model;
    const s = state();
    let name = b.name as unknown;
    if (name === undefined || name === null || name === '') {
      const base = `model-${model.id}`;
      name = base;
      for (let n = 2; s.deployments.some((d) => d.name === name); n++) name = `${base}-${n}`;
    }
    if (typeof name !== 'string' || !DEPLOY_NAME.test(name)) {
      return detail(422, '部署名稱只能用小寫英數字與連字號，開頭結尾必須是英數字，最多 63 字');
    }
    if (b.title !== undefined && b.title !== null && (typeof b.title !== 'string' || b.title.trim().length > 128)) return detail(422, '顯示名稱最多 128 字');
    const allowed = users(b.allowed_users ?? []);
    if (allowed instanceof Response) return allowed;
    if (s.deployments.some((d) => d.name === name)) return detail(409, `部署名稱「${name}」已被使用`);
    const row: Deployment = { id: s.nextDeployment++, project_id: ctx.project.id, model_id: model.id, name, allowed_users: allowed,
      title: (typeof b.title === 'string' && b.title.trim()) || model.name,
      endpoint: `/api/inference/${name}/predict`, created_by: ctx.user.username, created_at: isoNow() };
    s.deployments.push(row);
    return json(deploymentOut(row), 201);
  }),
  http.put(`${P}/deployments/:did/access`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const row = state().deployments.find((d) => d.id === Number(params.did) && d.project_id === ctx.project.id);
    if (!row) return detail(404, `找不到部署 ${String(params.did)}`);
    const allowed = users((await jsonBody(request)).allowed_users);
    if (allowed instanceof Response) return allowed;
    row.allowed_users = allowed;
    return json(deploymentOut(row));
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
