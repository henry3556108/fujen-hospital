// 訓練設定表單的狀態與 API 設定（config）的雙向轉換。表單數值一律存成字串，送出時才轉型；
// 從 API 讀回的設定轉成表單、再轉回 config，必須逐欄相同（TC-B05-02）。
import type { Step } from '../tabular/types';
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
  // 結構式
  datasetId: string;
  target: string;
  features: string[];
  steps: Step[];
  algorithm: string;
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
    datasetId: '',
    target: '',
    features: [],
    steps: [],
    algorithm,
    train: pct(catalogue.default_split.train),
    validation: pct(catalogue.default_split.validation),
    test: pct(catalogue.default_split.test),
    seed: '42',
    hyper: Object.fromEntries(hyperSpecs(catalogue, kind, algorithm).map((p) => [p.name, paramValue(p, undefined)])),
  };
}

/** 換訓練種類時：共用欄位保留，種類相關的欄位回到預設值。 */
export function changeKind(catalogue: Catalogue, form: FormState, kind: TrainingKind): FormState {
  const fresh = emptyForm(catalogue, kind);
  return { ...fresh, name: form.name, train: form.train, validation: form.validation, test: form.test, seed: form.seed };
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
  if (c.augmentation) {
    form.augmentation = Object.fromEntries(catalogue.augmentation.map((a) => [a.name, paramValue(a, c.augmentation![a.name])]));
  }
  if (c.tabular) {
    form.target = c.tabular.target;
    form.features = [...c.tabular.features];
    form.steps = c.tabular.steps;
    form.algorithm = c.tabular.algorithm;
  }
  const specs = hyperSpecs(catalogue, c.kind, form.algorithm);
  form.hyper = Object.fromEntries(specs.map((p) => [p.name, paramValue(p, c.hyperparameters[p.name])]));
  return form;
}

const list = (text: string) => text.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean);

export function configFromForm(catalogue: Catalogue, form: FormState): TrainingConfig {
  const split = { train: ratio(form.train), validation: ratio(form.validation), test: ratio(form.test) };
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
      tabular: { target: form.target, features: form.features, steps: form.steps, algorithm: form.algorithm },
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
    augmentation,
  };
}
