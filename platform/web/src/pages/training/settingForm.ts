// 訓練設定表單的狀態與 API 設定（config）的雙向轉換。表單數值一律存成字串，送出時才轉型；
// 從 API 讀回的設定轉成表單、再轉回 config，必須逐欄相同（TC-B05-02）。
import type { MissingChoice, Step } from '../tabular/types';
import {
  isImageKind,
  type Catalogue,
  type LabelSource,
  type ParamSpec,
  type TrainingConfig,
  type TrainingKind,
  type TrainingSetting,
} from './api';

export interface FormState {
  name: string;
  kind: TrainingKind;
  // 影像
  sourceType: 'dicom' | 'files';
  studiesMode: 'all' | 'selected';
  studies: string[];
  labelProvider: string;
  /** inline 標註（由 API 建立的設定）原樣保留 */
  inlineSource: LabelSource | null;
  filesFormat: 'nifti' | 'itk';
  cases: string;
  resizeH: string;
  resizeW: string;
  labels: string;
  augmentation: Record<string, string | boolean>;
  /** 影像：使用的標註資料集（空字串＝不指定，沿用標註來源） */
  labelDatasetId: string;
  // 結構式
  datasetId: string;
  target: string;
  features: string[];
  steps: Step[];
  algorithm: string;
  /** 有缺值的病人：補值或不使用（新設定預設補值；舊設定沒有＝不使用） */
  missing: MissingChoice;
  /** 結構式的驗證方式（舊設定沒有＝固定比例切分） */
  validationMethod: 'holdout' | 'kfold';
  folds: string;
  // 共用
  train: string;
  validation: string;
  test: string;
  seed: string;
  hyper: Record<string, string | boolean>;
}

/** 比例（0–1）↔ 百分比字串；保留到 0.1%。 */
const pct = (v: number) => String(Math.round(v * 1000) / 10);
const ratio = (v: string) => Math.round(Number(v) * 10) / 1000;

function paramValue(spec: ParamSpec, value: unknown): string | boolean {
  if (spec.type === 'bool') return typeof value === 'boolean' ? value : Boolean(spec.default);
  if (typeof value === 'number') return String(value);
  return spec.default === null || spec.default === undefined ? '' : String(spec.default);
}

function paramOut(spec: ParamSpec, value: string | boolean | undefined): number | boolean | undefined {
  if (spec.type === 'bool') return Boolean(value);
  if (value === undefined || value === '' || typeof value === 'boolean') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? (value as unknown as number) : n;
}

export function hyperSpecs(catalogue: Catalogue, kind: TrainingKind, algorithm: string): ParamSpec[] {
  const entry = catalogue.kinds.find((k) => k.kind === kind);
  if (!entry) return [];
  if (entry.hyperparameters) return entry.hyperparameters;
  return entry.algorithms?.find((a) => a.name === algorithm)?.hyperparameters ?? entry.algorithms?.[0]?.hyperparameters ?? [];
}

export function defaultAlgorithm(catalogue: Catalogue, kind: TrainingKind): string {
  return catalogue.kinds.find((k) => k.kind === kind)?.algorithms?.[0]?.name ?? '';
}

export function emptyForm(catalogue: Catalogue, kind: TrainingKind = 'image_classification'): FormState {
  const algorithm = defaultAlgorithm(catalogue, kind);
  return {
    name: '',
    kind,
    sourceType: 'dicom',
    studiesMode: 'all',
    studies: [],
    labelProvider: 'annotations',
    inlineSource: null,
    filesFormat: 'nifti',
    cases: '',
    resizeH: '32',
    resizeW: '32',
    labels: '',
    augmentation: Object.fromEntries(catalogue.augmentation.map((a) => [a.name, paramValue(a, undefined)])),
    labelDatasetId: '',
    datasetId: '',
    target: '',
    features: [],
    steps: [],
    algorithm,
    missing: 'impute',
    validationMethod: 'holdout',
    folds: '5',
    train: pct(catalogue.default_split.train),
    validation: pct(catalogue.default_split.validation),
    test: pct(catalogue.default_split.test),
    seed: '42',
    hyper: Object.fromEntries(hyperSpecs(catalogue, kind, algorithm).map((p) => [p.name, paramValue(p, undefined)])),
  };
}

/** 資料少於這麼多列時，新設定預選 K 折交叉驗證（只切一次時測試集太小，分數容易受分組影響）。 */
export const KFOLD_BELOW_ROWS = 1000;

/** 依資料列數建議驗證方式：少於 1,000 列用 K 折，否則固定比例切分。只用在新設定；既有設定照存的設定。 */
export function suggestedValidation(rows: number): FormState['validationMethod'] {
  return rows < KFOLD_BELOW_ROWS ? 'kfold' : 'holdout';
}

/** 換訓練種類時：共用欄位保留，種類相關的欄位回到預設值。 */
export function changeKind(catalogue: Catalogue, form: FormState, kind: TrainingKind): FormState {
  const fresh = emptyForm(catalogue, kind);
  return { ...fresh, name: form.name, train: form.train, validation: form.validation, test: form.test, seed: form.seed,
    datasetId: form.datasetId, target: form.target, features: form.features, steps: form.steps, missing: form.missing,
    validationMethod: form.validationMethod, folds: form.folds };
}

export function changeAlgorithm(catalogue: Catalogue, form: FormState, algorithm: string): FormState {
  const hyper = Object.fromEntries(hyperSpecs(catalogue, form.kind, algorithm).map((p) => [p.name, paramValue(p, undefined)]));
  return { ...form, algorithm, hyper };
}

export function formFromSetting(catalogue: Catalogue, setting: TrainingSetting): FormState {
  const c = setting.config;
  const form = emptyForm(catalogue, c.kind);
  form.name = setting.name;
  form.train = pct(c.split.train);
  form.validation = pct(c.split.validation);
  form.test = pct(c.split.test);
  form.seed = String(c.seed);
  if (c.source.type === 'dicom') {
    form.sourceType = 'dicom';
    form.studiesMode = c.source.studies === 'all' ? 'all' : 'selected';
    form.studies = c.source.studies === 'all' ? [] : [...c.source.studies];
    form.labelProvider = c.source.label_source.provider;
    form.inlineSource = c.source.label_source.provider === 'inline' ? c.source.label_source : null;
  } else if (c.source.type === 'files') {
    form.sourceType = 'files';
    form.filesFormat = c.source.format;
    form.cases = c.source.cases === 'all' ? '' : c.source.cases.join('\n');
  } else {
    form.datasetId = String(c.source.dataset_id);
  }
  if (c.image) {
    form.resizeH = String(c.image.resize[0]);
    form.resizeW = String(c.image.resize[1]);
    form.labels = (c.image.labels ?? []).join(', ');
  }
  if (c.label_dataset_id) form.labelDatasetId = String(c.label_dataset_id);
  if (c.augmentation) {
    form.augmentation = Object.fromEntries(catalogue.augmentation.map((a) => [a.name, paramValue(a, c.augmentation![a.name])]));
  }
  if (c.tabular) {
    form.target = c.tabular.target;
    form.features = [...c.tabular.features];
    form.steps = c.tabular.steps;
    form.algorithm = c.tabular.algorithm;
    form.missing = c.tabular.missing ?? 'drop';
    if (c.validation?.method === 'kfold') {
      form.validationMethod = 'kfold';
      form.folds = String(c.validation.folds);
    }
  }
  const specs = hyperSpecs(catalogue, c.kind, form.algorithm);
  form.hyper = Object.fromEntries(specs.map((p) => [p.name, paramValue(p, c.hyperparameters[p.name])]));
  return form;
}

/** 依 Target 欄位預選種類：類別、文字、是否 → 分類；數字且不同值不超過 10 個 → 分類；其他數字 → 迴歸。 */
export function suggestKind(kind: string | undefined, distinct: number | null): TrainingKind {
  if (kind === 'numeric' && (distinct === null || distinct > 10)) return 'tabular_regression';
  return 'tabular_classification';
}

const list = (text: string) => text.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean);

export function configFromForm(catalogue: Catalogue, form: FormState): TrainingConfig {
  const kfold = !isImageKind(form.kind) && form.validationMethod === 'kfold';
  // K 折：測試集照比例保留，其餘全部做交叉驗證（不另切驗證集）
  const split = kfold
    ? { train: Math.round((1 - ratio(form.test)) * 1000) / 1000, validation: 0, test: ratio(form.test) }
    : { train: ratio(form.train), validation: ratio(form.validation), test: ratio(form.test) };
  const hyperparameters: Record<string, number | boolean> = {};
  for (const spec of hyperSpecs(catalogue, form.kind, form.algorithm)) {
    const v = paramOut(spec, form.hyper[spec.name]);
    if (v !== undefined) hyperparameters[spec.name] = v;
  }
  const base = { version: 1, kind: form.kind, split, seed: Number(form.seed), hyperparameters };
  if (!isImageKind(form.kind)) {
    return {
      ...base,
      source: { type: 'tabular', dataset_id: Number(form.datasetId) },
      validation: kfold ? { method: 'kfold', folds: Number(form.folds) } : { method: 'holdout' },
      tabular: { target: form.target, features: form.features, steps: form.steps, algorithm: form.algorithm, missing: form.missing },
    };
  }
  const labels = list(form.labels);
  const augmentation: Record<string, number | boolean> = {};
  for (const spec of catalogue.augmentation) augmentation[spec.name] = paramOut(spec, form.augmentation[spec.name]) ?? 0;
  const source: TrainingConfig['source'] =
    form.sourceType === 'files'
      ? { type: 'files', format: form.filesFormat, cases: list(form.cases).length ? list(form.cases) : 'all' }
      : {
          type: 'dicom',
          studies: form.studiesMode === 'all' ? 'all' : [...form.studies].sort(),
          label_source: form.labelProvider === 'inline' && form.inlineSource ? form.inlineSource : { provider: form.labelProvider },
        };
  return {
    ...base,
    source,
    image: { resize: [Number(form.resizeH), Number(form.resizeW)], labels: labels.length ? labels : null },
    ...(form.labelDatasetId ? { label_dataset_id: Number(form.labelDatasetId) } : {}),
    augmentation,
  };
}

/** 訓練表單的一個 Feature 選項：原始欄位一項；One-Hot 過的欄位也只有一項，勾選時列入它產生的全部欄位。 */
export interface FeatureChoice {
  /** 畫面上的名稱（原始欄位名，或前處理產生、不屬於任何 One-Hot 的新欄位） */
  name: string;
  /** 勾選時列入 features 的欄位（前處理後的欄位名稱） */
  columns: string[];
  /** 是否為 One-Hot 轉換過的原始欄位 */
  encoded: boolean;
}

function onehotSources(steps: Step[]): Set<string> {
  return new Set(steps.filter((s) => s.id === 'onehot').flatMap((s) => s.columns ?? []));
}

/**
 * 由原始欄位與前處理後的欄位組出 Feature 選項。processed 為 null（還不知道前處理結果）時每個原始欄位一項。
 * One-Hot 產生的欄位以「原始欄位名_」開頭；多個來源都符合時歸給名稱最長的來源（例如 smoker 與 smoker_x）。
 */
export function featureChoices(original: string[], processed: string[] | null, steps: Step[], target: string): FeatureChoice[] {
  if (!processed) return original.filter((c) => c !== target).map((c) => ({ name: c, columns: [c], encoded: false }));
  const originals = new Set(original);
  const sources = [...onehotSources(steps)].filter((c) => originals.has(c) && !processed.includes(c));
  const owner = (col: string) =>
    sources.filter((s) => col.startsWith(`${s}_`)).sort((a, b) => b.length - a.length)[0] ?? null;
  const children = new Map<string, string[]>();
  const extra: string[] = [];
  for (const col of processed) {
    if (originals.has(col) || col === target) continue;
    const src = owner(col);
    if (src) children.set(src, [...(children.get(src) ?? []), col]);
    else extra.push(col);
  }
  const out: FeatureChoice[] = [];
  for (const col of original) {
    if (col === target) continue;
    if (processed.includes(col)) out.push({ name: col, columns: [col], encoded: false });
    else if (children.get(col)?.length) out.push({ name: col, columns: children.get(col)!, encoded: true });
  }
  return [...out, ...extra.map((c) => ({ name: c, columns: [c], encoded: false }))];
}

/** 把 features 裡 One-Hot 過的原始欄位換成它產生的欄位（舊設定可能同時存原始欄位與 One-Hot 步驟）；不重複、保留順序。 */
export function normaliseFeatures(features: string[], choices: FeatureChoice[]): string[] {
  const encoded = new Map(choices.filter((c) => c.encoded).map((c) => [c.name, c.columns]));
  return [...new Set(features.flatMap((f) => encoded.get(f) ?? [f]))];
}

/** 前處理後不存在的 Feature（送出前在畫面上檢查）。 */
export function unknownFeatures(features: string[], processed: string[] | null): string[] {
  return processed ? features.filter((f) => !processed.includes(f)) : [];
}

export const choiceChecked = (choice: FeatureChoice, features: string[]) => choice.columns.every((c) => features.includes(c));

export function toggleChoice(choice: FeatureChoice, features: string[]): string[] {
  return choiceChecked(choice, features)
    ? features.filter((f) => !choice.columns.includes(f))
    : [...features, ...choice.columns.filter((c) => !features.includes(c))];
}

export function choiceLabel(choice: FeatureChoice): string {
  return choice.encoded ? `${choice.name}（已轉成 ${choice.columns.join('、')}）` : choice.name;
}

/** 遞迴排序物件的鍵，空的 params 與沒有 params 視為相同（比較前處理步驟用）。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

const stepKey = (steps: Step[]) => JSON.stringify(canonical(steps.map((s) => ({ id: s.id, columns: s.columns ?? [], params: s.params ?? {} }))));

const MISSING_NAMES: Record<MissingChoice, string> = { impute: '補上缺值', drop: '不使用有缺值的病人' };

/**
 * 訓練設定與資料集目前的 Target／Feature／前處理／缺值處理的差異，一句話；相同時回傳 null。
 * Feature 不看順序；前處理以正規化後的內容比較；資料集沒有選缺值處理時不比較缺值處理。
 */
export function settingDifference(
  setting: { target: string; features: string[]; steps: Step[]; missing?: MissingChoice },
  dataset: { target: string; features: string[]; steps: Step[]; missing?: MissingChoice },
): string | null {
  const parts: string[] = [];
  if (setting.target !== dataset.target) parts.push(`要預測的結果是「${setting.target}」，資料集是「${dataset.target}」`);
  const more = setting.features.filter((f) => !dataset.features.includes(f));
  const fewer = dataset.features.filter((f) => !setting.features.includes(f));
  if (more.length || fewer.length) {
    const bits = [more.length ? `多了 ${more.join('、')}` : '', fewer.length ? `少了 ${fewer.join('、')}` : ''].filter(Boolean);
    parts.push(`Feature ${bits.join('，')}`);
  }
  if (stepKey(setting.steps) !== stepKey(dataset.steps)) {
    parts.push(`前處理步驟不同（這裡 ${setting.steps.length} 個，資料集 ${dataset.steps.length} 個）`);
  }
  if (dataset.missing && (setting.missing ?? 'drop') !== dataset.missing) {
    parts.push(`缺值處理是「${MISSING_NAMES[setting.missing ?? 'drop']}」，資料集是「${MISSING_NAMES[dataset.missing]}」`);
  }
  return parts.length ? `與資料集目前的設定不同：${parts.join('；')}。` : null;
}
