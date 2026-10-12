// 建模管理（B-05）與 AI 模型部署（B-06 部署）的 API 呼叫。形狀照 platform/api/app/training（router.py、service.py、config.py）。
// 頁面只透過 useTrainingApi() 取用，不直接組路徑。
import { useMemo } from 'react';
import { ApiError, withQuery, type ApiClient } from '../../api/client';
import { useSession } from '../../auth/SessionContext';
import type { Study } from '../imaging/types';
import type { ColumnInfo, Dataset, DatasetDetail, MissingChoice, Step, TargetFeature } from '../tabular/types';
import type { Model, ModelKind } from '../inference/api';
import { platformEnv } from '../../runtimeConfig';

export type TrainingKind = ModelKind;
export const IMAGE_KINDS: readonly TrainingKind[] = ['image_classification', 'image_segmentation', 'image_detection'];
export const isImageKind = (kind: TrainingKind) => IMAGE_KINDS.includes(kind);

export interface ParamSpec {
  name: string;
  title: string;
  type: 'int' | 'float' | 'bool';
  minimum: number | null;
  maximum: number | null;
  default: number | boolean | null;
  /** 白話說明與建議值 */
  help?: string;
  /** 不常調整：網頁收在「進階設定」 */
  advanced?: boolean;
}

export interface ValidationMethod {
  method: 'holdout' | 'kfold';
  name: string;
  help: string;
  folds?: { minimum: number; maximum: number; default: number };
}

export type Validation = { method: 'holdout' } | { method: 'kfold'; folds: number };

export interface CatalogueKind {
  kind: TrainingKind;
  name: string;
  model_format: 'h5' | 'pkl';
  source_types: ('dicom' | 'files' | 'tabular')[];
  hyperparameters?: ParamSpec[];
  algorithms?: { name: string; hyperparameters: ParamSpec[] }[];
  /** 結構式才有：固定比例切分、K 折交叉驗證 */
  validation_methods?: ValidationMethod[];
}

export interface Catalogue {
  kinds: CatalogueKind[];
  augmentation: ParamSpec[];
  default_split: Split;
  executors: string[];
}

export interface Split {
  train: number;
  validation: number;
  test: number;
}

export interface LabelSource {
  provider: string;
  by?: string;
  values?: Record<string, string>;
}

export type TrainingSource =
  | { type: 'dicom'; studies: 'all' | string[]; label_source: LabelSource }
  | { type: 'files'; format: 'nifti' | 'itk'; cases: 'all' | string[] }
  | { type: 'tabular'; dataset_id: number };

export type Augmentation = Record<string, number | boolean>;
export type Hyperparameters = Record<string, number | boolean>;

export interface TrainingConfig {
  version?: number;
  kind: TrainingKind;
  source: TrainingSource;
  split: Split;
  seed: number;
  /** 結構式的驗證方式；舊設定沒有這個欄位＝固定比例切分 */
  validation?: Validation;
  image?: { resize: [number, number] | number[]; labels: string[] | null };
  /** missing：缺值處理（impute 補值、drop 不使用有缺值的病人）；沒有＝drop */
  tabular?: { target: string; features: string[]; steps: Step[]; algorithm: string; missing?: MissingChoice };
  augmentation?: Augmentation;
  hyperparameters: Hyperparameters;
}

export interface TrainingSetting {
  id: number;
  project_id: number;
  name: string;
  kind: TrainingKind;
  config: TrainingConfig;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'held';

export interface TrainingRun {
  id: number;
  project_id: number;
  setting_id: number | null;
  name: string;
  kind: TrainingKind;
  executor: string;
  status: RunStatus;
  message: string;
  seed: number;
  config: TrainingConfig;
  dataset_version_id: number;
  job_id: number | null;
  parent_run_id: number | null;
  metrics: Record<string, unknown>;
  artifacts: Record<string, { sha256: string; size: number }>;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  custom_source: boolean;
  model_id: number | null;
}

export interface Deployment {
  id: number;
  project_id: number;
  model_id: number;
  /** 技術名稱（網址上的，小寫英數字與 -） */
  name: string;
  /** 顯示名稱（可用中文） */
  title?: string;
  /** 授權帳號中不是本專案成員或沒有推論權限的人：在「推論服務管理」看不到這個模型 */
  cannot_use_in_platform?: string[];
  allowed_users: string[];
  endpoint: string;
  /** 部署的模型名稱與種類（模型已刪除時為 null） */
  model_name?: string | null;
  model_kind?: TrainingKind | null;
  created_by: string;
  created_at: string;
}

/** 試呼叫線上推論的回應（照 service.online_predict）：結構式回 predictions，影像回 results。 */
export interface OnlinePrediction {
  inference_id: number;
  deployment: string;
  model_id: number;
  predictions?: (string | null)[];
  notes?: (string | null)[];
  probabilities?: (number | null)[];
  positive_label?: string;
  positive_probabilities?: (number | null)[];
  results?: { name: string; label?: string; scores?: Record<string, number> }[];
  blocked?: { name: string; reason: string }[];
}

/** 訓練紀錄的一頁（GET /training/runs?limit=…）。 */
export interface RunPage {
  items: TrainingRun[];
  total: number;
  offset: number;
  limit: number;
}

/** charts.json（platform/training/trainer/templates/tabularkit.py 的 charts()）。 */
export interface Charts {
  version: number;
  kind: TrainingKind;
  subset: 'test' | 'validation' | 'train';
  rows: number;
  confusion_matrix: { labels: string[]; matrix: number[][] } | null;
  roc: { positive: string; auc: number; points: [number, number][] } | null;
  feature_importance: { method: string; metric: string; repeats: number; items: { feature: string; mean: number; std: number }[] } | null;
  regression: {
    points: [number, number][];
    total: number;
    sampled: boolean;
    residuals: { start: number; end: number; count: number }[];
  } | null;
}

export interface RunCharts {
  run_id: number;
  kind: TrainingKind;
  charts: Charts | null;
}

export interface Download {
  blob: Blob;
  filename: string;
  sha256: string | null;
}

export interface TrainingApi {
  projectId: number;
  catalogue(): Promise<Catalogue>;
  settings(): Promise<TrainingSetting[]>;
  setting(id: number): Promise<TrainingSetting>;
  createSetting(name: string, config: TrainingConfig): Promise<TrainingSetting>;
  updateSetting(id: number, name: string, config: TrainingConfig): Promise<TrainingSetting>;
  deleteSetting(id: number): Promise<void>;
  submit(settingId: number, executor: string): Promise<TrainingRun>;
  runs(): Promise<TrainingRun[]>;
  /** 訓練紀錄分頁：由新到舊；mine 只列自己送出的 */
  runPage(params: { limit: number; offset: number; mine: boolean }): Promise<RunPage>;
  run(id: number): Promise<TrainingRun>;
  cancel(id: number): Promise<TrainingRun>;
  rerun(id: number): Promise<TrainingRun>;
  /** 暫存排隊中的訓練（移出佇列，稍後恢復排隊） */
  hold(id: number): Promise<TrainingRun>;
  /** 恢復排隊：排到佇列最後 */
  resume(id: number): Promise<TrainingRun>;
  /** 把這次訓練用的設定另存成新的訓練設定 */
  saveAsSetting(runId: number, name: string): Promise<TrainingSetting>;
  log(id: number): Promise<{ run_id: number; status: RunStatus; log: string }>;
  exportSource(runId: number): Promise<Download>;
  charts(runId: number): Promise<RunCharts>;
  report(runId: number): Promise<Download>;
  models(): Promise<Model[]>;
  downloadModel(modelId: number): Promise<Download>;
  deployments(): Promise<Deployment[]>;
  /** name 省略時伺服器自動產生技術名稱；title 是顯示名稱 */
  deploy(body: { model_id: number; name?: string; title?: string; allowed_users: string[] }): Promise<Deployment>;
  setAccess(id: number, users: string[]): Promise<Deployment>;
  undeploy(id: number): Promise<void>;
  /** 以目前登入的帳號試呼叫部署的線上端點：結構式送 JSON rows，影像上傳檔案 */
  callDeployment(endpoint: string, input: { rows: Record<string, unknown>[] } | File[]): Promise<OnlinePrediction>;
  studies(): Promise<Study[]>;
  datasets(): Promise<Dataset[]>;
  dataset(id: number): Promise<DatasetDetail>;
  /** 資料集尚未設定 Target 與 Feature 時回傳 null */
  targetFeature(id: number): Promise<TargetFeature | null>;
  /** 欄位的不同值數（用來判斷 Target 是分類還是迴歸） */
  distinct(datasetId: number, column: string): Promise<number>;
  /** 套用前處理步驟後的欄位（名稱、型態、缺值數）；不改動資料集 */
  processedColumns(datasetId: number, steps: Step[]): Promise<ColumnInfo[]>;
}

async function errorOf(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const d = data?.detail;
  if (d && typeof d === 'object' && 'message' in d) {
    const x = d as { message: unknown; code?: string; permission?: string };
    return new ApiError(res.status, String(x.message), [], x.code, x.permission);
  }
  return new ApiError(res.status, typeof d === 'string' ? d : `伺服器錯誤（HTTP ${res.status}）`);
}

export function createTrainingApi(
  api: ApiClient,
  projectId: number,
  getToken: () => Promise<string | null>,
  base: string,
): TrainingApi {
  const root = `/api/projects/${projectId}`;
  async function download(path: string, fallback: string): Promise<Download> {
    const token = await getToken();
    let res: Response;
    try {
      res = await fetch(new URL(path, base || window.location.origin), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new ApiError(0, '無法連線到伺服器，請確認網路或稍後再試');
    }
    if (!res.ok) throw await errorOf(res);
    const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
    return { blob: await res.blob(), filename: match?.[1] ?? fallback, sha256: res.headers.get('x-content-sha256') };
  }
  return {
    projectId,
    catalogue: () => api.get(`${root}/training/catalogue`),
    settings: () => api.get(`${root}/training/settings`),
    setting: (id) => api.get(`${root}/training/settings/${id}`),
    createSetting: (name, config) => api.post(`${root}/training/settings`, { name, config }),
    updateSetting: (id, name, config) => api.put(`${root}/training/settings/${id}`, { name, config }),
    deleteSetting: (id) => api.delete(`${root}/training/settings/${id}`),
    submit: (settingId, executor) => api.post(`${root}/training/settings/${settingId}/runs`, { executor }),
    runs: () => api.get(`${root}/training/runs`),
    runPage: ({ limit, offset, mine }) =>
      api.get(withQuery(`${root}/training/runs`, { limit, offset, mine: mine ? 'true' : undefined })),
    run: (id) => api.get(`${root}/training/runs/${id}`),
    cancel: (id) => api.post(`${root}/training/runs/${id}/cancel`),
    rerun: (id) => api.post(`${root}/training/runs/${id}/rerun`),
    hold: (id) => api.post(`${root}/training/runs/${id}/hold`),
    resume: (id) => api.post(`${root}/training/runs/${id}/resume`),
    saveAsSetting: (runId, name) => api.post(`${root}/training/runs/${runId}/save-setting`, { name }),
    log: (id) => api.get(`${root}/training/runs/${id}/log`),
    exportSource: (runId) => download(`${root}/training/runs/${runId}/source`, `training-run-${runId}-source.zip`),
    charts: (runId) => api.get(`${root}/training/runs/${runId}/charts`),
    report: (runId) => download(`${root}/training/runs/${runId}/report`, `training-run-${runId}-report.html`),
    models: () => api.get(`${root}/models`),
    downloadModel: (modelId) => download(`${root}/models/${modelId}/download`, `model-${modelId}`),
    deployments: () => api.get(`${root}/deployments`),
    deploy: (body) => api.post(`${root}/deployments`, body),
    setAccess: (id, users) => api.put(`${root}/deployments/${id}/access`, { allowed_users: users }),
    undeploy: (id) => api.delete(`${root}/deployments/${id}`),
    callDeployment(endpoint, input) {
      if (!Array.isArray(input)) return api.post(endpoint, input);
      const form = new FormData();
      input.forEach((f) => form.append('files', f));
      return api.postForm(endpoint, form);
    },
    studies: () => api.get(`${root}/imaging/studies`),
    datasets: () => api.get(`${root}/tabular/datasets`),
    dataset: (id) => api.get(`${root}/tabular/datasets/${id}`),
    async distinct(datasetId, column) {
      const out = await api.get<{ distinct: number }>(
        `${root}/tabular/datasets/${datasetId}/value-counts?column=${encodeURIComponent(column)}&limit=1`,
      );
      return out.distinct;
    },
    async processedColumns(datasetId, steps) {
      const out = await api.post<{ columns: ColumnInfo[] }>(`${root}/tabular/datasets/${datasetId}/preprocess/preview`, { steps, limit: 1 });
      return out.columns;
    },
    async targetFeature(id) {
      try {
        return await api.get<TargetFeature>(`${root}/tabular/datasets/${id}/target-feature`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

/** 讓瀏覽器把下載內容存成檔案。 */
export function saveFile({ blob, filename }: Download) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 以逗號、頓號或空白分隔的帳號清單。 */
export function parseUsers(text: string): string[] {
  return [...new Set(text.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean))];
}

const API_BASE: string = platformEnv().VITE_API_BASE ?? '';

export function useTrainingApi(): TrainingApi | null {
  const { api, auth, project } = useSession();
  const projectId = project?.id ?? null;
  return useMemo(
    () =>
      projectId === null
        ? null
        : createTrainingApi(api, projectId, async () => (await auth.getUser())?.accessToken ?? null, API_BASE),
    [api, auth, projectId],
  );
}
