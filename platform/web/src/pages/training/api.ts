// 建模管理（B-05）與 AI 模型部署（B-06 部署）的 API 呼叫。形狀照 platform/api/app/training（router.py、service.py、config.py）。
// 頁面只透過 useTrainingApi() 取用，不直接組路徑。
import { useMemo } from 'react';
import { ApiError, type ApiClient } from '../../api/client';
import { useSession } from '../../auth/SessionContext';
import type { Study } from '../imaging/types';
import type { Dataset, DatasetDetail, Step, TargetFeature } from '../tabular/types';
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
}

export interface CatalogueKind {
  kind: TrainingKind;
  name: string;
  model_format: 'h5' | 'pkl';
  source_types: ('dicom' | 'files' | 'tabular')[];
  hyperparameters?: ParamSpec[];
  algorithms?: { name: string; hyperparameters: ParamSpec[] }[];
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
  image?: { resize: [number, number] | number[]; labels: string[] | null };
  tabular?: { target: string; features: string[]; steps: Step[]; algorithm: string };
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

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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
  name: string;
  allowed_users: string[];
  endpoint: string;
  created_by: string;
  created_at: string;
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
  run(id: number): Promise<TrainingRun>;
  cancel(id: number): Promise<TrainingRun>;
  rerun(id: number): Promise<TrainingRun>;
  log(id: number): Promise<{ run_id: number; status: RunStatus; log: string }>;
  exportSource(runId: number): Promise<Download>;
  models(): Promise<Model[]>;
  downloadModel(modelId: number): Promise<Download>;
  deployments(): Promise<Deployment[]>;
  deploy(body: { model_id: number; name: string; allowed_users: string[] }): Promise<Deployment>;
  setAccess(id: number, users: string[]): Promise<Deployment>;
  undeploy(id: number): Promise<void>;
  studies(): Promise<Study[]>;
  datasets(): Promise<Dataset[]>;
  dataset(id: number): Promise<DatasetDetail>;
  /** 資料集尚未設定 Target 與 Feature 時回傳 null */
  targetFeature(id: number): Promise<TargetFeature | null>;
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
    run: (id) => api.get(`${root}/training/runs/${id}`),
    cancel: (id) => api.post(`${root}/training/runs/${id}/cancel`),
    rerun: (id) => api.post(`${root}/training/runs/${id}/rerun`),
    log: (id) => api.get(`${root}/training/runs/${id}/log`),
    exportSource: (runId) => download(`${root}/training/runs/${runId}/source`, `training-run-${runId}-source.zip`),
    models: () => api.get(`${root}/models`),
    downloadModel: (modelId) => download(`${root}/models/${modelId}/download`, `model-${modelId}`),
    deployments: () => api.get(`${root}/deployments`),
    deploy: (body) => api.post(`${root}/deployments`, body),
    setAccess: (id, users) => api.put(`${root}/deployments/${id}/access`, { allowed_users: users }),
    undeploy: (id) => api.delete(`${root}/deployments/${id}`),
    studies: () => api.get(`${root}/imaging/studies`),
    datasets: () => api.get(`${root}/tabular/datasets`),
    dataset: (id) => api.get(`${root}/tabular/datasets/${id}`),
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
