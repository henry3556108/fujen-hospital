// 與 platform/api/app/labeling 的回應形狀一致。

export type AnnotationKind = 'classification' | 'segmentation' | 'detection';
export type AnnotationSource = 'manual' | 'csv' | 'autolabel';

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
}

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
}

export interface LabelSummary {
  total: number;
  rated: number;
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
}

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
  classification: '分類',
  segmentation: '分割',
  detection: '偵測',
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
