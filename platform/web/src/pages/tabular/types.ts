// 與 platform/api/app/tabular_api 及 platform/libs/tabular 的回應形狀一致。

export interface SchemaColumn {
  name: string;
  type: string;
  required?: boolean;
  min?: number | null;
  max?: number | null;
  allowed?: string[] | null;
  unique?: boolean;
  pattern?: string | null;
}

export interface Dataset {
  id: number;
  project_id: number;
  name: string;
  original_filename: string;
  object_key: string;
  original_key: string;
  schema: { columns: SchemaColumn[] };
  total_rows: number;
  valid_rows: number;
  rejected_rows: number;
  created_by: string;
  created_at: string;
}

export type ColumnKind = 'numeric' | 'categorical' | 'text' | 'boolean' | 'datetime';

export interface ColumnInfo {
  name: string;
  dtype: string;
  kind: ColumnKind;
  missing: number;
}

export interface DatasetDetail extends Dataset {
  columns: ColumnInfo[];
}

export interface RejectedRow {
  row: number;
  column: string;
  reason: string;
}

export interface ValidationReport {
  valid_rows: number;
  total_rows: number;
  rejected_row_count: number;
  rejected: RejectedRow[];
  columns: string[];
  errors: { code: string; message: string }[];
  warnings: { code?: string; message: string }[] | string[];
}

export interface UploadResult {
  dataset: Dataset;
  report: ValidationReport;
}

export type Cell = string | number | boolean | null;

export interface Preview {
  total_rows: number;
  offset: number;
  limit: number;
  columns: string[];
  rows: Cell[][];
}

export interface DescribeColumn extends ColumnInfo {
  count: number;
  unique: number;
  mean?: number;
  std?: number;
  min?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  max?: number;
  top?: Cell;
  freq?: number;
}

export interface Describe {
  row_count: number;
  columns: DescribeColumn[];
}

export interface Histogram {
  column: string;
  counts: number[];
  edges: number[];
  missing: number;
  bins: { start: number; end: number; count: number }[];
}

export interface ValueCounts {
  column: string;
  missing: number;
  distinct: number;
  items: { value: Cell; count: number }[];
}

export interface Correlation {
  method: string;
  columns: string[];
  matrix: (number | null)[][];
}

export interface Scatter {
  x: string;
  y: string;
  total: number;
  returned: number;
  sampled: boolean;
  points: [number, number][];
}

export interface ParamSpec {
  type: string | string[];
  title: string;
  default: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  enum?: string[];
}

export interface CatalogueItem {
  id: string;
  name_zh: string;
  category: string;
  category_zh: string;
  params: { type: string; properties: Record<string, ParamSpec>; required: string[]; additionalProperties: boolean };
  column_types: string[];
  requires_columns: boolean;
}

export interface Step {
  id: string;
  columns: string[];
  params: Record<string, unknown>;
}

export interface PipelinePreview {
  row_count: number;
  columns: ColumnInfo[];
  preview: Preview;
}

export interface TargetFeature {
  dataset_id: number;
  config: { version: number; target: string; features: string[]; steps: Step[] };
  updated_by: string;
  updated_at: string;
}

export interface Coefficient {
  name: string;
  coef: number;
  std_err: number;
  z?: number;
  t?: number;
  p: number;
  ci_low: number;
  ci_high: number;
  odds_ratio?: number;
  or_ci_low?: number;
  or_ci_high?: number;
  hr?: number;
  hr_ci_low?: number;
  hr_ci_high?: number;
}

export interface LogisticResult {
  model: 'logistic';
  target: string;
  features: string[];
  n: number;
  n_dropped: number;
  events: number;
  coefficients: Coefficient[];
  aic: number;
  bic: number;
  log_likelihood: number;
  pseudo_r2: number;
  llr_p_value: number;
  converged: boolean;
  roc: { fpr: number[]; tpr: number[]; thresholds: number[]; auc: number };
}

export interface LinearResult {
  model: 'linear';
  target: string;
  features: string[];
  n: number;
  n_dropped: number;
  coefficients: Coefficient[];
  r2: number;
  adj_r2: number;
  f_statistic: number;
  f_p_value: number;
  aic: number;
  bic: number;
  log_likelihood: number;
  residuals: { points: [number, number][]; total: number };
}

export interface KmGroup {
  group: string;
  n: number;
  events: number;
  median_survival: number | null;
  timeline: number[];
  survival: number[];
  ci_lower: number[];
  ci_upper: number[];
  at_risk: number[];
}

export interface KmResult {
  model: 'kaplan_meier';
  duration: string;
  event: string;
  group_by: string | null;
  n: number;
  n_dropped: number;
  groups: KmGroup[];
  logrank: { test_statistic: number; p_value: number; degrees_of_freedom: number } | null;
}

export interface CoxResult {
  model: 'cox';
  duration: string;
  event: string;
  covariates: string[];
  n: number;
  n_dropped: number;
  events: number;
  coefficients: Coefficient[];
  concordance: number;
  log_likelihood: number;
  aic_partial: number;
  forest: { name: string; hr: number; low: number; high: number }[];
  baseline_survival: { timeline: number[]; survival: number[] };
}

export const KIND_LABELS: Record<string, string> = {
  numeric: '數值',
  categorical: '類別',
  text: '文字',
  boolean: '布林',
  datetime: '日期時間',
};
