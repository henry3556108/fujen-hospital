// 指標的中文名稱、一句話說明（什麼叫好）、主要分數，以及結果的白話解讀與提醒。
// 說明文字與 platform/api/app/training/report.py 的 METRICS 相同，報表與畫面一致。
import { formatNumber } from '../../components/format';
import type { TrainingKind, TrainingRun } from './api';

export interface MetricInfo {
  label: string;
  help: string;
  /** 比例（0～1）以百分比顯示 */
  percent?: boolean;
  /** 越小越好（誤差） */
  lower?: boolean;
}

export const METRICS: Record<string, MetricInfo> = {
  accuracy: { label: '準確率', percent: true, help: '預測正確的比例。越接近 100% 越好；請和「全部都猜最常見的那一類」比較，高出越多越有用。' },
  f1_macro: { label: 'F1 分數（各類平均）', help: '同時考慮「抓得到」與「抓得準」，各類別平均（0～1）。越接近 1 越好；類別人數不平均時比準確率可靠。' },
  auc: { label: 'AUC（ROC 曲線下面積）', help: '隨機挑一位陽性與一位陰性，模型把陽性排在前面的機率。0.5 等於亂猜，0.7 以上尚可，0.8 以上良好，0.9 以上優秀。' },
  sensitivity: { label: '敏感度', percent: true, help: '實際為陽性的人當中，模型抓到的比例。越高代表越少漏掉病人。' },
  specificity: { label: '特異度', percent: true, help: '實際為陰性的人當中，模型正確判為陰性的比例。越高代表越少誤報。' },
  baseline_accuracy: { label: '比較基準：全部猜訓練資料最常見的類別', percent: true, help: '什麼都不學、每個人都猜訓練資料中最常見的那一類時的準確率。模型的準確率要明顯高於它才有用。' },
  r2: { label: 'R²（解釋量）', help: '模型能解釋結果高低差異的比例。1 為完美，0 等於每次都猜平均值，負數代表比猜平均值還差；越接近 1 越好。' },
  rmse: { label: 'RMSE（均方根誤差）', lower: true, help: '預測值平均偏離實際值多少，單位與目標欄位相同，越小越好；大錯會被放大計算。' },
  mae: { label: 'MAE（平均絕對誤差）', lower: true, help: '預測值與實際值差距的平均，單位與目標欄位相同，越小越好。' },
  baseline_rmse: { label: '比較基準：每次都猜平均值', lower: true, help: '什麼都不學、每次都猜訓練資料平均值的 RMSE。模型的 RMSE 要明顯低於它才有用。' },
  pixel_accuracy: { label: '像素準確率', percent: true, help: '每個像素分類正確的比例。背景很多時容易偏高，請一併看 Dice。' },
  dice: { label: 'Dice 係數', help: '預測區域與標註區域的重疊程度（0～1）。越接近 1 越好，一般 0.7 以上算不錯。' },
  mean_iou: { label: '平均 IoU', help: '預測方框與標註方框的重疊比例（0～1）。越接近 1 越好，0.5 以上通常算有框到。' },
  score: { label: '分數（快速測試）', help: '快速測試產生的亂數，沒有意義。' },
  map50: { label: 'mAP@0.5', help: '預測方框與標註方框重疊一半以上算找到，各類別平均精確度（0～1）。越接近 1 越好。' },
};

export const SPLIT_NAMES: Record<string, string> = { test: '測試集', validation: '驗證集', train: '訓練集' };
const ORDER = ['auc', 'accuracy', 'sensitivity', 'specificity', 'f1_macro', 'r2', 'rmse', 'mae', 'dice', 'pixel_accuracy', 'mean_iou', 'score'];

export function metricLabel(name: string): string {
  return METRICS[name]?.label ?? name;
}

export function formatMetric(name: string, value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (METRICS[name]?.percent) return `${Math.round(value * 1000) / 10}%`;
  return formatNumber(value, 3);
}

type Scores = Record<string, number>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const numbers = (v: unknown): Scores =>
  Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === 'number')) as Scores;

export interface CvMetric {
  mean: number;
  std: number;
  values: number[];
}

export interface Cv {
  folds: number;
  stratified: boolean;
  rows: number;
  metrics: Record<string, CvMetric>;
}

export function cvOf(run: Pick<TrainingRun, 'metrics'>): Cv | null {
  const cv = obj(run.metrics.cv);
  if (!cv.folds) return null;
  const metrics = Object.fromEntries(Object.entries(cv).filter(([, v]) => v && typeof v === 'object' && 'mean' in (v as object))) as Record<string, CvMetric>;
  return { folds: Number(cv.folds), stratified: Boolean(cv.stratified), rows: Number(cv.rows ?? 0), metrics };
}

/** 各切分的指標（數值），依 測試、驗證、訓練 排列。 */
export function splitScores(run: Pick<TrainingRun, 'metrics'>): [string, Scores][] {
  return (['test', 'validation', 'train'] as const)
    .map((s): [string, Scores] => [s, numbers(run.metrics[s])])
    .filter(([, v]) => Object.keys(v).length > 0);
}

export const sortMetrics = (names: string[]) =>
  [...names].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

/**
 * 各任務的主要指標（03 規格 3.5），依序取第一個有的：二分類先 AUC、沒有才用準確率（多分類沒有 AUC，就是準確率）；
 * 偵測 mAP@0.5；分割 Dice；迴歸 MAE。首頁、模型清單、訓練紀錄、單次訓練都用 primaryScore／primaryText，
 * 與 platform/api/app/training/report.py 的 PRIMARY 相同。
 */
export const PRIMARY_METRICS: Record<TrainingKind, string[]> = {
  tabular_classification: ['auc', 'accuracy'],
  image_classification: ['auc', 'accuracy'],
  image_detection: ['map50', 'mean_iou'],
  image_segmentation: ['dice', 'pixel_accuracy'],
  tabular_regression: ['mae', 'r2'],
};

/** 結論用的數字從哪裡來：有 K 折用 K 折平均，否則測試集，再否則驗證集，最後才用訓練集。 */
export interface Source {
  /** 'cv' 或切分名稱 */
  key: 'cv' | 'test' | 'validation' | 'train';
  /** 給人看的來源，例如「5 折平均」「測試集」 */
  label: string;
  scores: Scores;
}

export function sourcesOf(run: Pick<TrainingRun, 'metrics'>): Source[] {
  const cv = cvOf(run);
  const out: Source[] = [];
  if (cv) out.push({ key: 'cv', label: `${cv.folds} 折平均`, scores: Object.fromEntries(Object.entries(cv.metrics).map(([k, v]) => [k, v.mean])) });
  for (const [split, scores] of splitScores(run)) {
    out.push({ key: split as Source['key'], label: split === 'train' ? '訓練集，可能過度樂觀' : SPLIT_NAMES[split], scores });
  }
  return out;
}

/** 主要分數（清單排序用，與結論同一個數字）：K 折用平均；否則測試集，再否則驗證集。越大越好。 */
export function primaryScore(run: { kind: string; metrics: TrainingRun['metrics'] | null | undefined }): { name: string; value: number; source: string } | null {
  const sources = sourcesOf({ metrics: run.metrics ?? {} });
  for (const name of PRIMARY_METRICS[run.kind as TrainingKind] ?? []) {
    for (const s of sources) {
      if (typeof s.scores[name] === 'number') return { name, value: s.scores[name], source: s.label };
    }
  }
  const fallback = sources.find((s) => s.key !== 'cv');
  if (fallback) {
    const name = sortMetrics(Object.keys(fallback.scores))[0];
    if (name) return { name, value: fallback.scores[name], source: fallback.label };
  }
  return null;
}

const SHORT_LABELS: Record<string, string> = { auc: 'AUC', r2: 'R²', mae: 'MAE', rmse: 'RMSE' };

/** 主要指標的簡短名稱（AUC、R²、MAE、RMSE 用縮寫，其他同 metricLabel）；各頁共用。 */
export function primaryLabel(name: string): string {
  return SHORT_LABELS[name] ?? metricLabel(name);
}

/** 主要指標的一段文字，例如「AUC 0.84」「準確率 65%」；首頁、模型清單、訓練紀錄、單次訓練共用。 */
export function primaryText(name: string, value: number): string {
  return `${primaryLabel(name)} ${headlineNumber(name, value)}`;
}

/** 結論句的數字：比例用整數百分比，其他取兩位小數（例如 AUC 0.84）。四捨五入（0.725 → 0.73），與報表相同。 */
export function headlineNumber(name: string, value: number): string {
  const round = (v: number) => Math.floor(v + 0.5 + 1e-9);
  if (METRICS[name]?.percent) return `${round(value * 100)}%`;
  return (round(value * 100) / 100).toFixed(2);
}

const step = (value: number, levels: [number, string][], last: string) => levels.find(([at]) => value >= at)?.[1] ?? last;

/** 等級：與 platform/api/app/training/report.py 的 verdict() 相同的門檻。 */
export function grade(name: string, value: number, baseline?: number): string | null {
  if (name === 'auc') return step(value, [[0.9, '優秀'], [0.8, '良好'], [0.7, '尚可'], [0.55, '偏弱']], '接近亂猜');
  if (name === 'r2') return step(value, [[0.9, '優秀'], [0.7, '良好'], [0.5, '尚可'], [0.2, '偏弱']], '幾乎沒有預測能力');
  if (name === 'accuracy' && typeof baseline === 'number') {
    return step(value - baseline + 1e-9, [[0.2, '良好'], [0.1, '尚可'], [0.05, '偏弱']], '沒有比全部猜最常見的類別好');
  }
  if (name === 'dice') return step(value, [[0.8, '良好'], [0.7, '尚可']], '偏弱');
  if (name === 'mean_iou') return step(value, [[0.7, '良好'], [0.5, '尚可']], '偏弱');
  return null;
}

export interface Verdict {
  name: string;
  value: number;
  source: Source;
  grade: string | null;
  /** 例如「良好（AUC 0.84，5 折平均）」；清單與結果卡片共用 */
  text: string;
}

/** 這個模型好不好的一個結論：清單、結果頁、報表都用它（同一個數字、同一個等級）。 */
export function verdict(run: TrainingRun): Verdict | null {
  const score = primaryScore(run);
  if (!score) return null;
  const source = sourcesOf(run).find((s) => s.label === score.source)!;
  const baseline = source.scores.baseline_accuracy;
  const g = run.executor === 'fake' ? '快速測試，沒有意義' : grade(score.name, score.value, baseline);
  const numbers = `${primaryText(score.name, score.value)}，${source.label}`;
  return { name: score.name, value: score.value, source, grade: g, text: g ? `${g}（${numbers}）` : numbers };
}

export function rowsOf(run: TrainingRun, split: string): number | null {
  const rows = obj(run.metrics.rows ?? run.metrics.samples);
  return typeof rows[split] === 'number' ? (rows[split] as number) : null;
}

/** 一句話：例如「準確率 65%：測試集的 20 人中猜對 13 人」。 */
export function plainSentence(run: TrainingRun, split: string, name: string, value: number): string {
  const n = rowsOf(run, split);
  const where = SPLIT_NAMES[split] ?? split;
  const labels = obj(run.metrics.labels);
  if (name === 'accuracy' && n) return `${where}的 ${n} 人中猜對 ${Math.round(value * n)} 人`;
  if (name === 'baseline_accuracy' && n) {
    const label = String(labels.majority ?? '最常見的類別');
    const train = obj(labels.majority_train);
    const guess = `如果${where}每個人都猜「${label}」，${n} 人中會猜對 ${Math.round(value * n)} 人`;
    if (typeof train.count !== 'number' || typeof train.rows !== 'number' || !train.rows) return guess;
    const share = train.count / train.rows;
    const text = `訓練資料中最常見的是「${label}」（${train.rows} 人中 ${train.count} 人）；${guess}`;
    // 測試集的組成和訓練資料差很多時，基準會偏低或偏高：說出原因，免得看起來前後矛盾
    return Math.abs(share - value) >= 0.1
      ? `${text}。${where}裡「${label}」只占 ${Math.round(value * 100)}%，比訓練資料的 ${Math.round(share * 100)}% ${value < share ? '少' : '多'}，所以這個基準${value < share ? '偏低' : '偏高'}`
      : text;
  }
  if (name === 'sensitivity') return `實際為「${String(labels.positive ?? '陽性')}」的人，模型抓到 ${Math.round(value * 100)}%`;
  if (name === 'specificity') return `實際不是「${String(labels.positive ?? '陽性')}」的人，模型正確排除 ${Math.round(value * 100)}%`;
  if (name === 'auc') return value >= 0.9 ? '優秀' : value >= 0.8 ? '良好' : value >= 0.7 ? '尚可' : value > 0.55 ? '偏弱' : '接近亂猜';
  if (name === 'r2') return `模型解釋了目標高低差異的 ${Math.round(Math.max(value, 0) * 100)}%`;
  if (name === 'rmse' || name === 'mae') return `預測平均差 ${formatNumber(value, 3)}（單位同目標欄位）`;
  return '';
}

/** 一句話：這次訓練用了幾位病人、哪些沒用與原因、補了幾位的缺值（metrics.data；與報表的 data_text 相同）。 */
export function dataSentence(run: TrainingRun): string {
  const data = obj(run.metrics.data);
  if (!Object.keys(data).length) return '';
  const used = numbers(data.used);
  const names: Record<string, string> = { train: '訓練', validation: '驗證', test: '測試' };
  const parts = ['train', 'validation', 'test'].filter((k) => used[k]).map((k) => `${names[k]} ${used[k]} 位`).join('、');
  let text = `共 ${Number(data.total ?? Object.values(used).reduce((a, b) => a + b, 0))} 位病人，${parts}。`;
  const left = Object.values(obj(data.left_out)).map(numbers);
  const target = left.reduce((a, v) => a + (v.missing_target ?? 0), 0);
  const feature = left.reduce((a, v) => a + (v.missing_feature ?? 0), 0);
  const filled = Object.values(numbers(data.filled)).reduce((a, b) => a + b, 0);
  const columns = Object.entries(numbers(data.missing_columns)).map(([c, n]) => `${c} ${n} 位`).join('、');
  if (target) text += `目標欄位缺值的 ${target} 位沒有使用。`;
  if (feature) text += `特徵有缺值的 ${feature} 位沒有使用（缺值：${columns}）。`;
  if (filled) text += `有 ${filled} 位的缺值（${columns}）已用訓練資料的中位數或最常見的值補上。`;
  return text;
}

/** 結果的提醒（收在「詳細」裡，每則一兩句）：測試人數少、測試集與 K 折差很多、驗證與測試差很多、只記住訓練資料、沒有比基準好。 */
export function warnings(run: TrainingRun): string[] {
  const out: string[] = [];
  const scores = Object.fromEntries(splitScores(run));
  const test = scores.test ?? {};
  const n = rowsOf(run, 'test');
  const cv = cvOf(run);
  if (n !== null && n > 0 && n < 50) {
    out.push(`測試集只有 ${n} 人，1 人猜對或猜錯就差 ${Math.round(1000 / n) / 10}%，數字不穩定。` +
      (cv ? '上方的結論用 K 折平均。' : '建議改用「K 折交叉驗證」或收集更多資料。'));
  }
  if (cv) {
    for (const name of ['accuracy', 'auc', 'r2']) {
      const mean = cv.metrics[name]?.mean;
      if (typeof mean !== 'number' || typeof test[name] !== 'number' || Math.abs(mean - test[name]) < 0.1) continue;
      out.push(`測試集的${metricLabel(name)}（${formatMetric(name, test[name])}）和 K 折平均（${formatMetric(name, mean)}）差很多：` +
        `測試集人數少，剛好分到哪些人影響很大；以 K 折平均為準。`);
      break;
    }
  }
  const main = run.kind === 'tabular_regression' ? 'r2' : run.kind.startsWith('image_') ? null : 'accuracy';
  // 和訓練集比較的對象：有 K 折用 K 折平均（比較可靠），否則測試集
  const reference = main ? (cv?.metrics[main]?.mean ?? test[main]) : undefined;
  if (main && typeof reference === 'number') {
    const val = scores.validation?.[main];
    if (!cv && typeof val === 'number' && typeof test[main] === 'number' && Math.abs(val - test[main]) >= 0.1) {
      out.push(`驗證集與測試集的${metricLabel(main)}差很多（${formatMetric(main, val)} 對 ${formatMetric(main, test[main])}），` +
        '結果還不穩定；建議用 K 折交叉驗證確認。');
    }
    const train = scores.train?.[main];
    if (typeof train === 'number' && train - reference >= 0.15) {
      out.push(`訓練集的${metricLabel(main)}（${formatMetric(main, train)}）比${cv ? ' K 折平均' : '測試集'}（${formatMetric(main, reference)}）高很多，` +
        `模型可能只記住了訓練資料。可以試著：${overfitAdvice(run)}。`);
    }
  }
  if (typeof test.accuracy === 'number' && typeof test.baseline_accuracy === 'number' && test.accuracy - test.baseline_accuracy < 0.05) {
    out.push(`模型的準確率（${formatMetric('accuracy', test.accuracy)}）沒有明顯高於「全部都猜最常見類別」（${formatMetric('accuracy', test.baseline_accuracy)}），目前還沒有實際用處。`);
  }
  if (typeof test.rmse === 'number' && typeof test.baseline_rmse === 'number' && test.rmse >= test.baseline_rmse * 0.95) {
    out.push(`模型的 RMSE（${formatNumber(test.rmse, 3)}）沒有明顯低於「每次都猜平均值」（${formatNumber(test.baseline_rmse, 3)}），目前還沒有實際用處。`);
  }
  return out;
}

/** 「只記住訓練資料」時的建議，依演算法（名稱與訓練表單的超參數名稱相同）。 */
const OVERFIT_ADVICE: Record<string, string> = {
  random_forest: '把「最大深度」設小一點（例如 3～5）、把「葉節點最少樣本數」調大（例如 5～10），或增加資料',
  logistic_regression: '把「正則化強度的倒數（C）」調小（例如 0.1）讓模型簡單一點，或減少用來預測的欄位',
  gradient_boosting: '把「學習率」調低（例如 0.05）、減少「樹的數量」或把「最大深度」設小一點',
  linear_regression: '減少用來預測的欄位，或增加資料',
};

export function overfitAdvice(run: TrainingRun): string {
  const algorithm = run.config?.tabular?.algorithm;
  if (algorithm && OVERFIT_ADVICE[algorithm]) return OVERFIT_ADVICE[algorithm];
  if (run.kind.startsWith('image_')) return '減少「訓練回合數」、提高「每張影像的增強份數」，或增加影像';
  return '增加資料，或減少用來預測的欄位';
}

/** 比較基準一句話（顯示在結論下方）：與結論同一個來源。 */
export function baselineSentence(run: TrainingRun, source: Source): string {
  const labels = obj(run.metrics.labels);
  const pick = (name: string) => source.scores[name] ?? splitScores(run).find(([, s]) => typeof s[name] === 'number')?.[1][name];
  const acc = pick('baseline_accuracy');
  if (typeof acc === 'number') {
    const label = labels.majority !== undefined ? `「${String(labels.majority)}」` : '最常見的類別';
    return `比較基準：每個人都猜${label}（訓練資料最常見的）可猜對 ${Math.round(acc * 100)}%；模型要明顯高於它才有用。`;
  }
  const rmse = pick('baseline_rmse');
  if (typeof rmse === 'number') return `比較基準：每次都猜平均值，RMSE 是 ${formatNumber(rmse, 3)}；模型的 RMSE 要明顯低於它才有用。`;
  return '';
}

/** 二元分類：說出陽性類別，預測時顯示的機率就是這一類的機率（與報表 report.positive_text 同一句）。 */
export function positiveSentence(run: TrainingRun): string {
  const positive = obj(run.metrics?.labels).positive;
  const target = run.config?.tabular?.target;
  if (positive === undefined || positive === null || !target) return '';
  return `陽性＝${target} 為「${String(positive)}」：敏感度、特異度、ROC 曲線，以及預測時顯示的「${target}＝${String(positive)} 的機率」都以這一類計算。`;
}

/** 訓練失敗的訊息：第一段是給使用者看的原因，分隔線（或舊格式的 Python 堆疊）之後是技術細節。 */
export function splitFailure(message: string): { reason: string; details: string } {
  const text = message || '訓練工作失敗';
  const at = text.indexOf('\n---\n');
  if (at >= 0) return { reason: text.slice(0, at).trim(), details: text.slice(at + 5).trim() };
  if (/Traceback|File "|以 \d+ 結束/.test(text)) {
    const match = /(?:^|\s)(?:[\w.]+\.)?\w*(?:Error|Exception): ([^\n]+?)\s*$/.exec(text);
    return { reason: match ? match[1].trim() : '訓練程式發生錯誤，請展開技術細節或檢視訓練輸出', details: text };
  }
  return { reason: text, details: '' };
}
