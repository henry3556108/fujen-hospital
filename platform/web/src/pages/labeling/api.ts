// 影像標註的 API 呼叫。頁面只透過 useLabelingApi() 取用，不直接組路徑。
import { useMemo } from 'react';
import { ApiError, type ApiClient } from '../../api/client';
import { useSession } from '../../auth/SessionContext';
import { createDicomwebClient, type DicomwebClient } from './dicomweb';
import type {
  Annotation,
  AnnotationKind,
  AnnotationPayload,
  AnnotationSource,
  AutolabelModel,
  AutolabelRun,
  CsvKey,
  CsvResult,
  LabelSummary,
  NewAnnotation,
} from './types';

export interface TrainingRequest {
  /** 訓練型態：影像分類、分割、物件偵測 */
  trainingType: AnnotationKind;
  labels: string[];
  resize: number;
  validationSplit: number;
  testSplit: number;
  seed: number;
}

export interface TrainingJob {
  id: number;
  project_id: number;
  status: string;
  kind: string;
}

/**
 * 標註後直接訓練（TC-B02-06）：走 WP5b 的訓練 API。
 * 先存一份訓練設定（資料來源＝本專案的標註），再以範本送出訓練；平台會凍結當下的標註與影像，
 * 之後改標註不影響這次訓練。回傳的是訓練（training run），進度在「建模管理」查看。
 */
export function trainingSetting(request: TrainingRequest, name: string) {
  const validation = request.validationSplit;
  const test = request.testSplit;
  return {
    name,
    config: {
      kind: `image_${request.trainingType}`,
      source: { type: 'dicom', studies: 'all', label_source: { provider: 'annotations' } },
      image: { resize: [request.resize, request.resize], labels: request.labels },
      // 以整數百分比計算，避免 0.7 + 0.2 + 0.1 這類浮點誤差讓伺服器判為總和不等於 1
      split: { train: (100 - Math.round(validation * 100) - Math.round(test * 100)) / 100, validation, test },
      seed: request.seed,
    },
  };
}

export async function createTrainingJob(api: ApiClient, projectId: number, request: TrainingRequest): Promise<TrainingJob> {
  const root = `/api/projects/${projectId}/training`;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const name = `標註頁訓練 ${stamp} ${Math.random().toString(36).slice(2, 6)}`;
  const setting = await api.post<{ id: number }>(`${root}/settings`, trainingSetting(request, name));
  return api.post<TrainingJob>(`${root}/settings/${setting.id}/runs`, { executor: 'template' });
}

export interface AnnotationFilter {
  studyUid?: string;
  sopUid?: string;
  kind?: AnnotationKind;
  source?: AnnotationSource;
}

export interface LabelingApi {
  projectId: number;
  dicomweb: DicomwebClient;
  summary(): Promise<LabelSummary>;
  list(filter?: AnnotationFilter): Promise<Annotation[]>;
  get(id: number): Promise<Annotation>;
  create(body: NewAnnotation): Promise<Annotation>;
  update(id: number, payload: AnnotationPayload): Promise<Annotation>;
  rate(id: number, rating: number | null): Promise<Annotation>;
  remove(id: number): Promise<void>;
  classifyCsv(file: File, key: CsvKey, keyColumn?: string, labelColumn?: string): Promise<CsvResult>;
  models(): Promise<AutolabelModel[]>;
  runs(): Promise<AutolabelRun[]>;
  autolabel(model: string, studyUid: string, sopUid: string): Promise<{ run: AutolabelRun; annotation: Annotation }>;
  train(request: TrainingRequest): Promise<TrainingJob>;
}

const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';
export const OHIF_BASE: string = import.meta.env.VITE_OHIF_BASE ?? 'http://localhost:9081';

export function ohifUrl(projectId: number, studyUid: string): string {
  return `${OHIF_BASE}/viewer?StudyInstanceUIDs=${encodeURIComponent(studyUid)}&project=${projectId}`;
}

/** 自己組 multipart/form-data：內容是位元組陣列，瀏覽器與測試環境的 fetch 都能送。 */
export function multipart(
  fields: [string, string][],
  fileField: string,
  filename: string,
  data: Uint8Array,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `----ai-platform-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const safe = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
  const chunks: Uint8Array[] = fields.map(([name, value]) =>
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value.replace(/[\r\n]/g, ' ')}\r\n`),
  );
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${safe(fileField)}"; filename="${safe(filename)}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    ),
    data,
    enc.encode(`\r\n--${boundary}--\r\n`),
  );
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function query(filter: AnnotationFilter): string {
  const q = new URLSearchParams();
  if (filter.studyUid) q.set('study_uid', filter.studyUid);
  if (filter.sopUid) q.set('sop_uid', filter.sopUid);
  if (filter.kind) q.set('kind', filter.kind);
  if (filter.source) q.set('source', filter.source);
  const text = q.toString();
  return text ? `?${text}` : '';
}

export function createLabelingApi(
  api: ApiClient,
  projectId: number,
  getToken: () => Promise<string | null>,
  base: string = API_BASE,
): LabelingApi {
  const root = `/api/projects/${projectId}/labels`;
  return {
    projectId,
    dicomweb: createDicomwebClient({ base, projectId, getToken }),
    summary: () => api.get(`${root}/summary`),
    list: (filter = {}) => api.get(`${root}/annotations${query(filter)}`),
    get: (id) => api.get(`${root}/annotations/${id}`),
    create: (body) => api.post(`${root}/annotations`, body),
    update: (id, payload) => api.put(`${root}/annotations/${id}`, { payload }),
    rate: (id, rating) => api.put(`${root}/annotations/${id}/rating`, { rating }),
    remove: (id) => api.delete(`${root}/annotations/${id}`),
    models: () => api.get(`${root}/autolabel/models`),
    runs: () => api.get(`${root}/autolabel/runs`),
    autolabel: (model, studyUid, sopUid) =>
      api.post(`${root}/autolabel`, { model, study_instance_uid: studyUid, sop_instance_uid: sopUid }),
    train: (request) => createTrainingJob(api, projectId, request),
    async classifyCsv(file, key, keyColumn, labelColumn) {
      // 檔案上傳用 multipart，共用的 ApiClient 只送 JSON，所以這裡自己組請求
      const fields: [string, string][] = [['key', key]];
      if (keyColumn) fields.push(['key_column', keyColumn]);
      if (labelColumn) fields.push(['label_column', labelColumn]);
      const { body, contentType } = multipart(fields, 'file', file.name, new Uint8Array(await file.arrayBuffer()));
      const token = await getToken();
      let res: Response;
      try {
        res = await fetch(new URL(`${root}/classification-csv`, base || window.location.origin), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': contentType,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body,
        });
      } catch {
        throw new ApiError(0, '無法連線到伺服器，請確認網路或稍後再試');
      }
      const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
      if (!res.ok) {
        const d = data?.detail;
        const message =
          typeof d === 'string'
            ? d
            : d && typeof d === 'object' && 'message' in d
              ? String((d as { message: unknown }).message)
              : `伺服器錯誤（HTTP ${res.status}）`;
        throw new ApiError(res.status, message);
      }
      return data as unknown as CsvResult;
    },
  };
}

/** 目前選取專案的標註 API；尚未選取專案時回 null。 */
export function useLabelingApi(): LabelingApi | null {
  const { api, auth, project } = useSession();
  const projectId = project?.id ?? null;
  return useMemo(
    () =>
      projectId === null
        ? null
        : createLabelingApi(api, projectId, async () => (await auth.getUser())?.accessToken ?? null),
    [api, auth, projectId],
  );
}
