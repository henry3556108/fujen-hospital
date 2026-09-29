// 推論服務管理（B-06）的 API 呼叫：模型清單、批次與上傳推論、歷史與下載。
import { useMemo } from 'react';
import { ApiError, type ApiClient } from '../../api/client';
import { useSession } from '../../auth/SessionContext';

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
  tabular_classification: '結構式分類',
  tabular_regression: '結構式迴歸',
};

export interface Model {
  id: number;
  name: string;
  kind: ModelKind;
  format: 'h5' | 'pkl';
  sha256: string;
  filename: string;
  created_by: string;
  created_at: string;
  card: { label_names?: string[]; input?: { resize?: number[] }; target?: string; features?: string[]; metrics?: Record<string, unknown> };
}

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

export interface InferenceRecord {
  id: number;
  model_id: number;
  mode: 'batch' | 'upload' | 'online';
  status: 'succeeded' | 'failed';
  user: string;
  count: number;
  message: string;
  result_format: 'csv' | 'json' | '';
  has_result: boolean;
  created_at: string;
  result?:
    | { columns: string[]; rows: string[][]; prediction_column: string }
    | { results: ImageResult[]; label_names: string[] }
    | null;
}

export const isImageModel = (kind: ModelKind) => kind.startsWith('image_');

export interface InferenceApi {
  projectId: number;
  models(): Promise<Model[]>;
  history(modelId: number): Promise<InferenceRecord[]>;
  record(id: number): Promise<InferenceRecord>;
  batch(modelId: number, subset: string): Promise<InferenceRecord>;
  upload(modelId: number, files: File[]): Promise<InferenceRecord>;
  download(id: number): Promise<{ blob: Blob; filename: string }>;
}

/** 多個檔案的 multipart/form-data；內容是位元組陣列，瀏覽器與測試環境的 fetch 都能送。 */
export async function multipartFiles(files: File[]): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
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
    async upload(modelId, files) {
      const { body, contentType } = await multipartFiles(files);
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

const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';

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
