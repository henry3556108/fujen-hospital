// 與 platform/api/app/labeling 的回應形狀一致。

export type AnnotationKind = 'classification' | 'segmentation' | 'detection';
export type AnnotationSource = 'manual' | 'csv' | 'autolabel';
/** 標註狀態：自動標註先是草稿（待確認），人工與診斷表匯入直接是已確認 */
export type AnnotationStatus = 'draft' | 'confirmed';

export interface ClassificationPayload {
  label: string;
}
export interface SegmentationPayload {
  shape: [number, number];
  encoding: 'rle';
  rle: [number, number][];
  label_names: Record<string, number>;
}
export interface DetectionBox {
  label: string;
  box: [number, number, number, number];
  score?: number;
}
export interface DetectionPayload {
  shape: [number, number];
  box_format: 'xyxy';
  boxes: DetectionBox[];
}
export type AnnotationPayload = ClassificationPayload | SegmentationPayload | DetectionPayload;

export interface Annotation {
  id: number;
  project_id: number;
  study_instance_uid: string;
  series_instance_uid: string | null;
  sop_instance_uid: string | null;
  kind: AnnotationKind;
  payload: AnnotationPayload;
  source: AnnotationSource;
  rating: number | null;
  version: number;
  autolabel_run_id: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  /** 舊後端沒有這三欄，視為已確認 */
  status?: AnnotationStatus;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
}

/** 沒有 status 的舊資料一律當作已確認。 */
export const isDraft = (a: Pick<Annotation, 'status'>) => a.status === 'draft';

export interface NewAnnotation {
  study_instance_uid: string;
  series_instance_uid?: string | null;
  sop_instance_uid?: string | null;
  kind: AnnotationKind;
  payload: AnnotationPayload;
}

export interface StudySummary {
  study_instance_uid: string;
  accession_number: string;
  patient_id: string;
  study_date: string;
  study_description: string;
  annotations: number;
  by_kind: Record<AnnotationKind, number>;
  /** 這個研究用到的分類標籤（研究層級與影像層級合併、排序） */
  classification_labels: string[];
  /** 待確認的草稿數、已確認的標註數（第二期欄位，舊後端沒有） */
  drafts?: number;
  confirmed?: number;
}

export interface LabelSummary {
  total: number;
  rated: number;
  /** 待處理數＝沒有已確認標註的研究數＋草稿數；已確認數＝有已確認標註的研究數 */
  pending?: number;
  confirmed?: number;
  by_kind: Record<AnnotationKind, number>;
  by_source: Record<AnnotationSource, number>;
  labels: Record<AnnotationKind, Record<string, number>>;
  studies: StudySummary[];
}

export type CsvKey = 'patient_id' | 'accession_number';
export type CsvRowStatus = 'matched' | 'unmatched' | 'conflict' | 'invalid';
export interface CsvRowResult {
  row: number;
  key: string;
  label: string;
  status: CsvRowStatus;
  reason: string;
  study_instance_uids: string[];
  annotation_ids: number[];
}
export interface CsvResult {
  key: CsvKey;
  rows: number;
  matched: number;
  unmatched: number;
  conflict: number;
  invalid: number;
  created: number;
  updated: number;
  unchanged: number;
  annotated_studies: number;
  results: CsvRowResult[];
  /** 這次匯入寫進的標註資料集 */
  dataset_id?: number | null;
}

// ---------- 標註資料集 ----------

export interface LabelDatasetCounts {
  annotations: number;
  studies: number;
  by_class: Record<string, number>;
  by_source: Record<AnnotationSource, number>;
  /** 待確認、不會用在訓練的草稿數 */
  drafts_excluded: number;
}

export interface LabelDatasetVersion {
  version: number;
  created_at: string;
  created_by: string;
  annotations: number;
  by_class: Record<string, number>;
}

export interface LabelDataset {
  id: number;
  name: string;
  task: AnnotationKind;
  scope_id: number | null;
  classes: string[];
  created_by: string;
  created_at: string;
  current: LabelDatasetCounts;
  latest_version: LabelDatasetVersion | null;
}

export interface NewLabelDataset {
  name: string;
  task: AnnotationKind;
  scope_id?: number | null;
  classes?: string[];
}

export interface LabelDatasetItem {
  annotation_id: number;
  study_instance_uid: string;
  accession_number: string;
  sop_instance_uid: string | null;
  label: string;
  source: AnnotationSource;
  status: AnnotationStatus;
  updated_by: string;
  updated_at: string;
}

export interface LabelDatasetItems {
  total: number;
  items: LabelDatasetItem[];
}

export const STATUS_LABELS: Record<AnnotationStatus, string> = {
  draft: '待確認',
  confirmed: '已確認',
};

export const TASK_LABELS: Record<AnnotationKind, string> = {
  classification: '影像分類',
  segmentation: '影像分割',
  detection: '物件偵測',
};

export interface AutolabelModel {
  name: string;
  type: 'segmentation' | 'detection';
  labels: string[];
  dimension: number;
  description: string;
}
export interface AutolabelRun {
  id: number;
  project_id: number;
  model: string;
  model_type: 'segmentation' | 'detection';
  study_instance_uid: string;
  sop_instance_uid: string;
  annotation_id: number;
  duration_ms: number;
  created_by: string;
  created_at: string;
}

export const KIND_LABELS: Record<AnnotationKind, string> = {
  classification: '影像分類',
  segmentation: '影像分割',
  detection: '物件偵測',
};
export const SOURCE_LABELS: Record<AnnotationSource, string> = {
  manual: '手動',
  csv: 'CSV 匯入',
  autolabel: '自動標註',
};

export function isSegmentation(a: Annotation): a is Annotation & { payload: SegmentationPayload } {
  return a.kind === 'segmentation';
}
export function isDetection(a: Annotation): a is Annotation & { payload: DetectionPayload } {
  return a.kind === 'detection';
}
export function isClassification(a: Annotation): a is Annotation & { payload: ClassificationPayload } {
  return a.kind === 'classification';
}
