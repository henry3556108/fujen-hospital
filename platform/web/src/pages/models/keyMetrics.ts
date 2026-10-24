// 使用模型 › 結果：依任務挑 3 個以內的主要指標（03 規格 3.5），以及跨次比較時判斷測試資料是否相同。
import type { ModelKind } from '../inference/api';
import type { TrainingRun } from '../training/api';
import { formatMetric, metricLabel } from '../training/metrics';

/** 依任務的主要指標（依序取有的前 3 個）；二分類與多分類分開。 */
const PREFERRED: Record<ModelKind | 'multiclass', string[]> = {
  image_classification: ['sensitivity', 'specificity', 'auc'],
  tabular_classification: ['sensitivity', 'specificity', 'auc'],
  multiclass: ['accuracy', 'recall_per_class'],
  image_detection: ['map50', 'mAP50', 'map_50', 'recall'],
  image_segmentation: ['dice', 'iou', 'mean_iou'],
  tabular_regression: ['mae', 'rmse', 'r2'],
};

/** 指標的來源：測試集優先，否則驗證集，再否則最上層的數值。 */
export function testScores(metrics: Record<string, unknown> | undefined | null): Record<string, unknown> {
  const m = metrics ?? {};
  for (const key of ['test', 'validation']) {
    const v = m[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return m;
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** 平台指標表沒有的名稱（偵測、分割的第二期指標） */
const EXTRA: Record<string, { label: string; percent?: boolean }> = {
  map50: { label: 'mAP@0.5' }, mAP50: { label: 'mAP@0.5' }, map_50: { label: 'mAP@0.5' },
  recall: { label: '召回率', percent: true }, iou: { label: 'IoU' },
};
const label = (name: string) => EXTRA[name]?.label ?? metricLabel(name);
const text = (name: string, v: number) => (EXTRA[name]?.percent ? pct(v) : formatMetric(name, v));

export interface KeyMetric {
  name: string;
  label: string;
  text: string;
  /** 原始數值（各類別召回率等沒有單一數值時為 null） */
  value: number | null;
}

/** 3 個以內的主要指標；還沒有規格指標時顯示目前有的數值指標（不留空格）。 */
export function keyMetrics(kind: ModelKind, metrics: Record<string, unknown> | undefined | null, classes?: string[]): KeyMetric[] {
  const scores = testScores(metrics);
  const multiclass = kind.endsWith('classification') && (classes?.length ?? 2) > 2;
  const wanted = PREFERRED[multiclass ? 'multiclass' : kind] ?? [];
  const out: KeyMetric[] = [];
  for (const name of wanted) {
    const v = scores[name];
    if (typeof v === 'number') out.push({ name, label: label(name), text: text(name, v), value: v });
    else if (name === 'recall_per_class' && v && typeof v === 'object') {
      const parts = Object.entries(v as Record<string, number>).map(([c, n]) => `${c} ${pct(n)}`);
      out.push({ name, label: '各類別召回率', text: parts.join('、'), value: null });
    }
    if (out.length === 3) return out;
  }
  if (out.length) return out;
  // 補上規格指標之前：顯示目前有的數值指標
  for (const [name, v] of Object.entries(scores)) {
    if (typeof v !== 'number' || name.startsWith('baseline_')) continue;
    out.push({ name, label: label(name), text: text(name, v), value: v });
    if (out.length === 3) break;
  }
  return out;
}

/** 測試資料筆數：run.test_count，否則 metrics 的 rows／samples。 */
export function testCount(run: Pick<TrainingRun, 'test_count' | 'metrics'> | null, metrics?: Record<string, unknown>): number | null {
  if (run?.test_count != null) return run.test_count;
  const m = run?.metrics ?? metrics ?? {};
  for (const key of ['rows', 'samples']) {
    const v = m[key] as Record<string, unknown> | undefined;
    if (v && typeof v.test === 'number') return v.test;
  }
  return null;
}

/** 測試筆數少於這個數字時提醒結果僅供參考。 */
export const FEW_TESTS = 30;

/** 兩次訓練的測試資料是否相同：資料版本、標註資料集版本、切分比例、驗證方式與亂數種子都一樣。 */
export function sameTestData(a: TrainingRun, b: TrainingRun): boolean {
  const key = (r: TrainingRun) =>
    JSON.stringify([
      r.dataset_version_id,
      r.label_dataset ? [r.label_dataset.id, r.label_dataset.version] : null,
      r.config?.split,
      r.config?.validation ?? null,
      r.seed,
    ]);
  return key(a) === key(b);
}

/** 資料版本的一句話。 */
export function dataVersionText(run: Pick<TrainingRun, 'label_dataset' | 'dataset_version_id'>): string {
  if (run.label_dataset) return `標註資料集「${run.label_dataset.name}」第 ${run.label_dataset.version} 版`;
  return `資料版本 #${run.dataset_version_id}`;
}
