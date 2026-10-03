// 訓練結果（B4）：重點指標（數值＋白話＋怎麼看）、比較基準與提醒、K 折平均±標準差、所有指標、
// 混淆矩陣、ROC、特徵重要性、迴歸的預測值對實際值與殘差，以及可列印的報表。
import { useState, type ReactNode } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { BarChart } from '../../components/charts/BarChart';
import { LineChart } from '../../components/charts/LineChart';
import { ScatterChart } from '../../components/charts/ScatterChart';
import { formatNumber } from '../../components/format';
import { isImageKind, type Charts, type TrainingApi, type TrainingRun } from './api';
import {
  METRICS,
  SPLIT_NAMES,
  cvOf,
  formatMetric,
  metricLabel,
  plainSentence,
  dataSentence,
  rowsOf,
  sortMetrics,
  splitScores,
  warnings,
  verdict,
  baselineSentence,
  positiveSentence,
  headlineNumber,
  type Source,
} from './metrics';
import { downloadAndSave } from './ModelExport';

const KEY_METRICS = ['accuracy', 'auc', 'sensitivity', 'specificity', 'r2', 'rmse', 'mae', 'dice', 'pixel_accuracy', 'mean_iou'];
const BASELINES = ['baseline_accuracy', 'baseline_rmse'];

/** actions：結論與重點指標下方的按鈕（例如「用這個模型預測病人」），不必捲到圖表下面才看到。 */
export function ResultView({ api, run, actions }: { api: TrainingApi; run: TrainingRun; actions?: ReactNode }) {
  const [done, setDone] = useState('');
  const [error, setError] = useState<unknown>(null);
  const splits = splitScores(run);
  const cv = cvOf(run);
  const conclusion = verdict(run);
  // 重點指標卡與結論用同一個來源（K 折時是 K 折平均）
  const source = conclusion?.source ?? null;
  const main = source?.scores ?? {};
  const keys = sortMetrics(Object.keys(main).filter((k) => KEY_METRICS.includes(k)));
  const baseline = source ? baselineSentence(run, source) : '';
  const notes = warnings(run);
  const fake = run.executor === 'fake';
  const [testSplit, testScores] = splits[0] ?? ['test', {}];
  const testBaselines = BASELINES.filter((k) => typeof testScores[k] === 'number');

  async function report() {
    setError(null);
    setDone('');
    try {
      setDone(await downloadAndSave(() => api.report(run.id)));
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="stack" aria-labelledby={`result-${run.id}`}>
      <div className="training-head">
        <h3 id={`result-${run.id}`}>模型好不好？</h3>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => void report()}>
          下載報表（可列印）
        </button>
      </div>
      {done ? <Alert tone="success">{done}</Alert> : null}
      <ApiErrorAlert error={error} />
      {fake ? <Alert tone="info">這是「快速測試」，沒有真正訓練，以下數字沒有意義。</Alert> : null}
      {conclusion ? (
        <p className="result-verdict" data-testid="verdict">
          <strong>整體表現：{conclusion.text}</strong>
          {notes.length ? <span className="text-muted">（下方「詳細」有 {notes.length} 則提醒）</span> : null}
        </p>
      ) : null}
      {dataSentence(run) ? (
        <p className="data-usage" data-testid="data-usage">
          <strong>用了哪些病人：</strong>
          {dataSentence(run)}
        </p>
      ) : null}
      {keys.length && source ? (
        <>
          <p className="text-muted">
            {source.key === 'cv' && cv
              ? `以下數字是 ${cv.folds} 折平均（${cv.rows} 人輪流當檢查資料）。`
              : `以下是${SPLIT_NAMES[source.key] ?? source.label}${rowsOf(run, source.key) ? `（${rowsOf(run, source.key)} 人，訓練時沒看過）` : ''}的結果。`}
          </p>
          <ul className="metric-cards" aria-label={`訓練 #${run.id} 的重點指標`}>
            {keys.map((k) => (
              <li key={k} className="metric-card">
                <span className="metric-card__label">{metricLabel(k)}</span>
                <span className="metric-card__value">{k === conclusion?.name ? headlineNumber(k, main[k]) : formatMetric(k, main[k])}</span>
                {cardSentence(run, source, k, main[k]) ? <span className="metric-card__plain">{cardSentence(run, source, k, main[k])}</span> : null}
                <span className="metric-card__help">{METRICS[k]?.help}</span>
              </li>
            ))}
          </ul>
          {baseline ? <p className="metric-baseline" data-testid="baseline">{baseline}</p> : null}
          {positiveSentence(run) ? <p className="metric-baseline" data-testid="positive-class">{positiveSentence(run)}</p> : null}
        </>
      ) : null}
      {actions}
      <details className="training-details" data-testid="result-details">
        <summary>詳細（{[cv ? '測試集與各折的數字' : '各資料的數字', notes.length ? `${notes.length} 則提醒` : ''].filter(Boolean).join('、')}）</summary>
        <div className="stack">
          {notes.map((n) => (
            <Alert key={n} tone="warning">
              {n}
            </Alert>
          ))}
          {testBaselines.map((k) => (
            <p key={k} className="metric-baseline">
              {metricLabel(k)}（{SPLIT_NAMES[testSplit]}）：{formatMetric(k === 'baseline_rmse' ? 'rmse' : 'accuracy', testScores[k])}
              {plainSentence(run, testSplit, k, testScores[k]) ? `。${plainSentence(run, testSplit, k, testScores[k])}` : ''}。
            </p>
          ))}
          {cv ? <CvTable runId={run.id} cv={cv} /> : null}
          <AllMetrics run={run} />
        </div>
      </details>
      {!isImageKind(run.kind) && run.status === 'succeeded' ? <RunCharts api={api} run={run} /> : null}
    </section>
  );
}

/** 指標卡的一句白話：K 折時說幾人輪流檢查；切分時說幾人中猜對幾人。 */
function cardSentence(run: TrainingRun, source: Source, name: string, value: number): string {
  if (source.key !== 'cv') return plainSentence(run, source.key, name, value);
  const cv = cvOf(run);
  if (name === 'accuracy' && cv) return `${cv.rows} 人輪流當檢查資料，平均猜對 ${Math.round(value * 100)}%`;
  return plainSentence(run, 'test', name, value);
}

function CvTable({ runId, cv }: { runId: number; cv: NonNullable<ReturnType<typeof cvOf>> }) {
  const names = sortMetrics(Object.keys(cv.metrics).filter((k) => !BASELINES.includes(k)));
  return (
    <div className="stack">
      <h4>K 折交叉驗證（{cv.folds} 折）</h4>
      <p className="text-muted">
        {cv.rows} 筆資料分成 {cv.folds} 份，輪流拿一份檢查、其他份訓練。平均值看整體表現；標準差越小代表結果越穩定，不是剛好碰到容易的資料。
        {cv.stratified ? '' : '（有類別的人數少於折數，各折未依類別比例分配。）'}
      </p>
      <div className="table-wrap">
        <table className="table" aria-label={`訓練 #${runId} 的 K 折結果`}>
          <thead>
            <tr>
              <th scope="col">指標</th>
              <th scope="col">平均 ± 標準差</th>
              <th scope="col">各折</th>
              <th scope="col">怎麼看</th>
            </tr>
          </thead>
          <tbody>
            {names.map((k) => (
              <tr key={k}>
                <th scope="row">{metricLabel(k)}</th>
                <td>
                  {formatMetric(k, cv.metrics[k].mean)} ± {formatMetric(k, cv.metrics[k].std)}
                </td>
                <td>{cv.metrics[k].values.map((v) => formatMetric(k, v)).join('、')}</td>
                <td className="field__hint">{METRICS[k]?.help ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AllMetrics({ run }: { run: TrainingRun }) {
  const rows = splitScores(run).flatMap(([split, scores]) => sortMetrics(Object.keys(scores)).map((k) => [split, k, scores[k]] as const));
  if (!rows.length) return null;
  return (
    <details className="training-details">
      <summary>所有指標（訓練、驗證、測試）</summary>
      <div className="table-wrap">
        <table className="table" aria-label={`訓練 #${run.id} 的指標`}>
          <thead>
            <tr>
              <th scope="col">資料</th>
              <th scope="col">指標</th>
              <th scope="col">數值</th>
              <th scope="col">怎麼看</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([split, k, v]) => (
              <tr key={`${split}.${k}`}>
                <td>
                  {SPLIT_NAMES[split]}
                  {rowsOf(run, split) !== null ? `（${rowsOf(run, split)} 筆）` : ''}
                </td>
                <th scope="row">{metricLabel(k)}</th>
                <td>{formatMetric(k, v)}</td>
                <td>{METRICS[k]?.help ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const SUBSET_NOTE: Record<Charts['subset'], string> = {
  test: '以下圖表以測試集（訓練時沒看過的資料）計算',
  validation: '沒有測試集，以下圖表以驗證集計算',
  train: '沒有測試集與驗證集，以下圖表以訓練資料計算，結果可能過度樂觀',
};

function RunCharts({ api, run }: { api: TrainingApi; run: TrainingRun }) {
  const charts = useResource(() => api.charts(run.id), [api, run.id]);
  if (charts.error) return <ApiErrorAlert error={charts.error} />;
  if (!charts.data) return <p role="status">圖表載入中…</p>;
  const c = charts.data.charts;
  if (!c) return <p className="text-muted">這次訓練沒有圖表資料（快速測試或舊版訓練只提供指標）。</p>;
  const target = run.config.tabular?.target ?? '目標';
  return (
    <div className="stack" aria-label={`訓練 #${run.id} 的圖表`} role="group">
      <h4>圖表</h4>
      <p className="text-muted">
        {SUBSET_NOTE[c.subset]}（{c.rows} 筆）。
      </p>
      {c.confusion_matrix ? <ConfusionMatrix runId={run.id} {...c.confusion_matrix} /> : null}
      {c.roc ? (
        <div>
          <LineChart
            title={`ROC 曲線（${SPLIT_NAMES[c.subset]}，陽性＝「${c.roc.positive}」）`}
            series={[{ name: '模型', points: c.roc.points }]}
            xLabel="偽陽性率（1 − 特異度）"
            yLabel="真陽性率（敏感度）"
            yRange={[0, 1]}
            diagonal
          />
          <p className="field__hint">曲線越往左上角彎越好；斜的直線代表亂猜。{cvOf(run) ? `這張圖只用${SPLIT_NAMES[c.subset]}的 ${c.rows} 人（AUC ${formatNumber(c.roc.auc, 2)}），和上方用 K 折平均的結論不同時，以結論為準。` : ''}</p>
        </div>
      ) : null}
      {c.regression ? (
        <>
          <div>
            <ScatterChart title={`預測值與實際值${c.regression.sampled ? `（共 ${c.regression.total} 筆，畫出 ${c.regression.points.length} 筆）` : ''}`}
              points={c.regression.points} xLabel={`實際 ${target}`} yLabel={`預測 ${target}`} />
            <p className="field__hint">點越貼近從左下到右上的對角線（預測＝實際）越好。</p>
          </div>
          <div>
            <BarChart
              title="殘差分布（實際值 − 預測值）"
              bars={c.regression.residuals.map((b) => ({ label: formatNumber(b.start, 3), value: b.count, detail: `${formatNumber(b.start, 3)}～${formatNumber(b.end, 3)}` }))}
              xLabel="殘差"
              yLabel="筆數"
            />
            <p className="field__hint">集中在 0 附近、左右大致對稱較好；偏向一邊代表模型習慣高估或低估。</p>
          </div>
        </>
      ) : null}
      {c.feature_importance?.items.length ? (
        <div>
          <BarChart
            title="特徵重要性（打亂後分數下降多少）"
            horizontal
            bars={c.feature_importance.items.slice(0, 15).map((i) => ({ label: i.feature, value: Number((Math.max(i.mean, 0) * 100).toFixed(1)), detail: `${i.feature}（±${formatNumber(i.std * 100, 2)}）` }))}
            xLabel={`${metricLabel(c.feature_importance.metric)}下降（百分點）`}
            yLabel="特徵"
          />
          <p className="field__hint">
            把一個特徵的值隨機打亂後分數掉越多，代表模型越依賴它。這只代表模型的依賴程度，不代表因果關係；接近 0 代表幾乎沒用到。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ConfusionMatrix({ runId, labels, matrix }: { runId: number; labels: string[]; matrix: number[][] }) {
  const peak = Math.max(1, ...matrix.flat());
  return (
    <figure className="chart">
      <figcaption className="chart__title">混淆矩陣</figcaption>
      <p className="field__hint">每一列是實際類別、每一欄是模型預測；對角線（左上到右下）是預測正確的人數，越集中在對角線越好。</p>
      <div className="table-wrap">
        <table className="heatmap" aria-label={`訓練 #${runId} 的混淆矩陣`}>
          <thead>
            <tr>
              <th scope="col">實際＼預測</th>
              {labels.map((l) => (
                <th key={l} scope="col">
                  預測「{l}」
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, i) => {
              const total = row.reduce((a, b) => a + b, 0) || 1;
              return (
                <tr key={labels[i]}>
                  <th scope="row">實際「{labels[i]}」</th>
                  {row.map((v, j) => (
                    <td key={labels[j]} className="heatmap__cell"
                      style={{ background: `color-mix(in srgb, var(--chart-series-1) ${Math.round((v / peak) * 55)}%, var(--chart-neutral))` }}>
                      {v} 人（{Math.round((v / total) * 100)}%）{i === j ? '，正確' : ''}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
