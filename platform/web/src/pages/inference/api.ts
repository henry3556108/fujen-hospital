// 推論服務管理（B-06）的 API 呼叫：模型清單、批次與上傳推論、歷史與下載。
// 批次推論是背景工作：POST .../inference/batch 回 202 與推論紀錄（status: queued），之後以 record(id) 輪詢
// 到 succeeded／failed／cancelled；waitForRecord() 做這件事。上傳推論仍是同步，回 201 與結果。
import { useMemo } from 'react';
import { ApiError, type ApiClient } from '../../api/client';
import { useSession } from '../../auth/SessionContext';
import { platformEnv } from '../../runtimeConfig';

export type ModelKind =
  | 'image_classification'
  | 'image_segmentation'
  | 'image_detection'
  | 'tabular_classification'
  | 'tabular_regression';

export const KIND_NAMES: Record<ModelKind, string> = {
  image_classification: '影像分類',
  image_segmentation: '影像分割',
  image_detection: '物件偵測',
  tabular_classification: '結構式資料分類',
  tabular_regression: '結構式資料迴歸',
};

export interface Model {
  id: number;
  name: string;
  kind: ModelKind;
  format: 'h5' | 'pkl';
  sha256: string;
  filename: string;
  /** 產生這個模型的訓練（模型部署與推論服務頁的網址用訓練編號）；舊版 mock 可能沒有 */
  run_id?: number | null;
  created_by: string;
  created_at: string;
  /** 有人把這個模型授權給目前的使用者（部署的授權帳號包含他）；舊版 API 沒有 */
  shared_with_me?: boolean;
  shared_by?: string | null;
  /** 顯示名稱（部署時取的名稱）；沒有部署過為 null。部署多次時伺服器選一個（見 service.model_titles） */
  title?: string | null;
  card: {
    label_names?: string[];
    input?: { resize?: number[] };
    target?: string;
    features?: string[];
    metrics?: Record<string, unknown>;
    /** 推論時要填的原始欄位（2026-10 起的結構式模型；舊模型沒有，改用 features） */
    inputs?: ModelInput[];
    classes?: string[];
    /** 缺值處理：impute＝特徵可留白（以訓練集的中位數或最常見的值補上）；drop 或沒有＝含缺值的列不預測 */
    missing?: 'impute' | 'drop';
    /** 平台訓練時實際的套件版本（名稱→版本；舊模型沒有） */
    libraries?: Record<string, string>;
  };
}

export type ModelInput =
  | { name: string; type: 'number'; min: number | null; max: number | null }
  | { name: string; type: 'category'; values: string[] };

export interface ImageResult {
  name: string;
  slice: number;
  preview: string;
  label?: string;
  scores?: Record<string, number>;
  boxes?: { label: string; score: number; bbox: [number, number, number, number] }[];
  mask?: Record<string, number>;
  note?: string;
}

export type InferenceStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'held';

export const STATUS_NAMES: Record<InferenceStatus, string> = {
  queued: '等待中',
  running: '執行中',
  succeeded: '成功',
  failed: '失敗',
  cancelled: '已取消',
  held: '已暫存',
};

// 已暫存（排程工作移出佇列，稍後恢復排隊）也還沒結束
export const isFinished = (status: InferenceStatus) => status !== 'queued' && status !== 'running' && status !== 'held';

export interface InferenceRecord {
  id: number;
  model_id: number;
  mode: 'batch' | 'upload' | 'online';
  status: InferenceStatus;
  user: string;
  /** 批次推論在完成前是輸入筆數，完成後是結果筆數 */
  count: number;
  message: string;
  result_format: 'csv' | 'json' | '';
  has_result: boolean;
  created_at: string;
  /** 送出時的資訊；source: 'try' 是網頁的即時推論 */
  input?: { source?: string } & Record<string, unknown>;
  /** 批次推論的排程工作與時間；其他方式為 null */
  job_id?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  result?:
    /** positive_label：二元分類的陽性類別（結果多一欄 `{prediction}_positive_probability`）；舊紀錄與多類別沒有 */
    | { columns: string[]; rows: string[][]; prediction_column: string; positive_label?: string | null }
    | { results: ImageResult[]; label_names: string[]; blocked?: { name: string; reason: string }[] }
    | null;
}

/** 給人看的模型名稱：有顯示名稱用顯示名稱，否則用模型名稱。 */
export const displayName = (m: Pick<Model, 'name' | 'title'>) => m.title || m.name;
/** 顯示名稱和模型名稱不同時，模型名稱（技術名稱）以小字附在後面。 */
export const technicalName = (m: Pick<Model, 'name' | 'title'>) => (m.title && m.title !== m.name ? m.name : null);

export const isImageModel = (kind: ModelKind) => kind.startsWith('image_');

export interface InferenceApi {
  projectId: number;
  models(): Promise<Model[]>;
  history(modelId: number): Promise<InferenceRecord[]>;
  record(id: number): Promise<InferenceRecord>;
  /** 送出批次推論，立即回傳（status: queued）；結果要以 record() 或 waitForRecord() 取得 */
  batch(modelId: number, subset: string): Promise<InferenceRecord>;
  cancel(id: number): Promise<InferenceRecord>;
  /** source: 'try' 表示網頁的即時推論（推論服務歷史紀錄顯示「即時推論」） */
  upload(modelId: number, files: File[], source?: 'try'): Promise<InferenceRecord>;
  download(id: number): Promise<{ blob: Blob; filename: string }>;
}

/** 多個檔案的 multipart/form-data；內容是位元組陣列，瀏覽器與測試環境的 fetch 都能送。 */
export async function multipartFiles(files: File[], fields: Record<string, string> = {}): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
  const boundary = `----ai-platform-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const safe = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safe(file.name)}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      new Uint8Array(await file.arrayBuffer()),
      enc.encode('\r\n'),
    );
  }
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function errorOf(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const d = data?.detail;
  const message =
    typeof d === 'string'
      ? d
      : d && typeof d === 'object' && 'message' in d
        ? String((d as { message: unknown }).message)
        : `伺服器錯誤（HTTP ${res.status}）`;
  return new ApiError(res.status, message);
}

export function createInferenceApi(
  api: ApiClient,
  projectId: number,
  getToken: () => Promise<string | null>,
  base: string,
): InferenceApi {
  const root = `/api/projects/${projectId}`;
  async function raw(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    let res: Response;
    try {
      res = await fetch(new URL(path, base || window.location.origin), {
        ...init,
        headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch {
      throw new ApiError(0, '無法連線到伺服器，請確認網路或稍後再試');
    }
    if (!res.ok) throw await errorOf(res);
    return res;
  }
  return {
    projectId,
    models: () => api.get(`${root}/models`),
    history: (modelId) => api.get(`${root}/models/${modelId}/inference`),
    record: (id) => api.get(`${root}/inference/${id}`),
    batch: (modelId, subset) => api.post(`${root}/models/${modelId}/inference/batch`, { subset }),
    cancel: (id) => api.post(`${root}/inference/${id}/cancel`),
    async upload(modelId, files, source) {
      const { body, contentType } = await multipartFiles(files, source ? { source } : {});
      const res = await raw(`${root}/models/${modelId}/inference/upload`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': contentType },
        body,
      });
      return (await res.json()) as InferenceRecord;
    },
    async download(id) {
      const res = await raw(`${root}/inference/${id}/download`);
      const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
      return { blob: await res.blob(), filename: match?.[1] ?? `inference-${id}` };
    },
  };
}

/** 輪詢間隔：第一次 firstMs，之後每次加倍到 maxMs。測試可以調小。 */
export const inferencePolling = { firstMs: 1000, maxMs: 5000 };

/** 輪詢一筆推論到結束（成功、失敗、取消）。每次讀到新狀態都呼叫 onUpdate；signal 中止時回傳 null。 */
export async function waitForRecord(
  inference: Pick<InferenceApi, 'record'>,
  id: number,
  { onUpdate, signal }: { onUpdate?: (r: InferenceRecord) => void; signal?: AbortSignal } = {},
): Promise<InferenceRecord | null> {
  let delay = inferencePolling.firstMs;
  for (;;) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (signal?.aborted) return null;
    const record = await inference.record(id);
    if (signal?.aborted) return null;
    onUpdate?.(record);
    if (isFinished(record.status)) return record;
    delay = Math.min(delay * 2, inferencePolling.maxMs);
  }
}

const API_BASE: string = platformEnv().VITE_API_BASE ?? '';

export function useInferenceApi(): InferenceApi | null {
  const { api, auth, project } = useSession();
  const projectId = project?.id ?? null;
  return useMemo(
    () =>
      projectId === null
        ? null
        : createInferenceApi(api, projectId, async () => (await auth.getUser())?.accessToken ?? null, API_BASE),
    [api, auth, projectId],
  );
}
