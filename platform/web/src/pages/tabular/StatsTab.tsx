import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { ForestPlot } from '../../components/charts/ForestPlot';
import { LineChart } from '../../components/charts/LineChart';
import { ScatterChart } from '../../components/charts/ScatterChart';
import { formatNumber } from '../../components/format';
import { useDataset } from './DatasetLayout';
import { stepSummary } from './StepsEditor';
import type { Coefficient, CoxResult, KmResult, LinearResult, LogisticResult } from './types';

type Model = 'logistic' | 'linear' | 'kaplan-meier' | 'cox';
type Result = LogisticResult | LinearResult | KmResult | CoxResult;

const MODELS: [Model, string, string][] = [
  ['logistic', 'Logistic 迴歸', '二元結果（0／1）'],
  ['linear', 'Linear 迴歸', '連續數值結果'],
  ['kaplan-meier', 'Kaplan-Meier 存活分析', '存活曲線與 log-rank 檢定'],
  ['cox', 'Cox 比例風險模型', '存活時間與多個共變項'],
];

const f = (v: number | null | undefined) => formatNumber(v ?? null, 4);

function Tiles({ items }: { items: [string, string][] }) {
  return (
    <ul className="stat-grid" aria-label="統計量">
      {items.map(([label, value]) => (
        <li key={label} className="card stat-tile">
          <span className="stat-tile__label">{label}</span>
          <span className="stat-tile__value">{value}</span>
        </li>
      ))}
    </ul>
  );
}

function Coefficients({ rows, ratio }: { rows: Coefficient[]; ratio?: 'odds_ratio' | 'hr' }) {
  const stat = rows[0] && 't' in rows[0] ? 't' : 'z';
  const label = ratio === 'hr' ? 'Hazard Ratio' : 'Odds Ratio';
  const low = ratio === 'hr' ? 'hr_ci_low' : 'or_ci_low';
  const high = ratio === 'hr' ? 'hr_ci_high' : 'or_ci_high';
  return (
    <div className="table-wrap">
      <table aria-label="係數">
        <thead>
          <tr>
            <th scope="col">變項</th>
            <th scope="col" className="num">
              係數
            </th>
            <th scope="col" className="num">
              標準誤
            </th>
            <th scope="col" className="num">
              {stat}
            </th>
            <th scope="col" className="num">
              p 值
            </th>
            <th scope="col" className="num">
              95% CI
            </th>
            {ratio && (
              <>
                <th scope="col" className="num">
                  {label}
                </th>
                <th scope="col" className="num">
                  {label} 95% CI
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.name}>
              <th scope="row">{c.name === 'const' ? '截距（const）' : c.name}</th>
              <td className="num">{f(c.coef)}</td>
              <td className="num">{f(c.std_err)}</td>
              <td className="num">{f(c[stat])}</td>
              <td className="num">{f(c.p)}</td>
              <td className="num">
                {f(c.ci_low)} – {f(c.ci_high)}
              </td>
              {ratio && (
                <>
                  <td className="num">{f(c[ratio])}</td>
                  <td className="num">
                    {f(c[low])} – {f(c[high])}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultView({ r }: { r: Result }) {
  const dropped = r.n_dropped ? `（因缺值排除 ${r.n_dropped} 筆）` : '';
  if (r.model === 'logistic') {
    return (
      <>
        <p role="status">
          Logistic 迴歸：結果 {r.target}，樣本 {r.n} 筆{dropped}，事件 {r.events} 筆{r.converged ? '' : '。模型未收斂，結果僅供參考'}
        </p>
        <Tiles items={[['AUC', f(r.roc.auc)], ['Pseudo R²', f(r.pseudo_r2)], ['AIC', f(r.aic)], ['BIC', f(r.bic)], ['LLR p 值', f(r.llr_p_value)]]} />
        <Coefficients rows={r.coefficients} ratio="odds_ratio" />
        <LineChart
          title={`ROC 曲線（AUC ${f(r.roc.auc)}）`}
          xLabel="偽陽性率"
          yLabel="真陽性率"
          yRange={[0, 1]}
          diagonal
          series={[{ name: 'ROC', points: r.roc.fpr.map((x, i): [number, number] => [x, r.roc.tpr[i]]) }]}
        />
      </>
    );
  }
  if (r.model === 'linear') {
    return (
      <>
        <p role="status">
          Linear 迴歸：結果 {r.target}，樣本 {r.n} 筆{dropped}
        </p>
        <Tiles items={[['R²', f(r.r2)], ['調整後 R²', f(r.adj_r2)], ['F 統計量', f(r.f_statistic)], ['F 檢定 p 值', f(r.f_p_value)], ['AIC', f(r.aic)]]} />
        <Coefficients rows={r.coefficients} />
        <ScatterChart title="殘差圖" xLabel="預測值" yLabel="殘差" reference={0} points={r.residuals.points} />
      </>
    );
  }
  if (r.model === 'kaplan_meier') {
    return (
      <>
        <p role="status">
          Kaplan-Meier：時間 {r.duration}，事件 {r.event}
          {r.group_by ? `，依 ${r.group_by} 分組` : ''}，樣本 {r.n} 筆{dropped}
        </p>
        {r.logrank && (
          <Tiles
            items={[
              ['Log-rank 統計量', f(r.logrank.test_statistic)],
              ['Log-rank p 值', f(r.logrank.p_value)],
              ['自由度', String(r.logrank.degrees_of_freedom)],
            ]}
          />
        )}
        <div className="table-wrap">
          <table aria-label="各組存活摘要">
            <thead>
              <tr>
                <th scope="col">組別</th>
                <th scope="col" className="num">
                  人數
                </th>
                <th scope="col" className="num">
                  事件數
                </th>
                <th scope="col" className="num">
                  中位存活時間
                </th>
              </tr>
            </thead>
            <tbody>
              {r.groups.map((g) => (
                <tr key={g.group}>
                  <th scope="row">{g.group}</th>
                  <td className="num">{g.n}</td>
                  <td className="num">{g.events}</td>
                  <td className="num">{g.median_survival === null ? '未達' : f(g.median_survival)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <LineChart
          title="存活曲線"
          xLabel={r.duration}
          yLabel="存活機率"
          step
          yRange={[0, 1]}
          series={r.groups.map((g) => ({ name: g.group, points: g.timeline.map((t, i): [number, number] => [t, g.survival[i]]) }))}
        />
        {r.groups.length > 3 && <p className="text-muted">超過 3 組時，第 4 組以後以中性色顯示，請搭配圖例與表格檢視。</p>}
      </>
    );
  }
  return (
    <>
      <p role="status">
        Cox 比例風險模型：時間 {r.duration}，事件 {r.event}，樣本 {r.n} 筆{dropped}，事件 {r.events} 筆
      </p>
      <Tiles items={[['Concordance', f(r.concordance)], ['Partial AIC', f(r.aic_partial)], ['Log-likelihood', f(r.log_likelihood)]]} />
      <Coefficients rows={r.coefficients} ratio="hr" />
      <ForestPlot title="Hazard Ratio 森林圖" measure="HR" rows={r.forest.map((x) => ({ name: x.name, value: x.hr, low: x.low, high: x.high }))} />
    </>
  );
}

/** TC-B04-07、08 四種統計：Logistic、Linear、Kaplan-Meier、Cox；非數值欄位由 API 回 422 並顯示原因。 */
export function StatsTab() {
  const { api } = useSession();
  const { dataset, base, catalogue, steps } = useDataset();
  const names = dataset.columns.map((c) => c.name);
  const has = (c: string, fallback: string) => (names.includes(c) ? c : fallback);
  const [params] = useSearchParams();
  // 從「相關與散佈圖」的「進一步分析」進來時預選模型（?model=）
  const [model, setModel] = useState<Model>(() => MODELS.find(([v]) => v === params.get('model'))?.[0] ?? 'logistic');
  const [target, setTarget] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [duration, setDuration] = useState(has('time_to_event', ''));
  const [event, setEvent] = useState(has('event', ''));
  const [group, setGroup] = useState('');
  const [useSteps, setUseSteps] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const survival = model === 'kaplan-meier' || model === 'cox';
  const picksVariables = model !== 'kaplan-meier';
  // 只排除「目前模型」用到的欄位：迴歸排除結果欄位，存活分析排除時間與事件欄位。
  // 其他模型選過的欄位（例如 Linear 的結果 sbp）切到 Cox 後要能當共變項。
  const excluded = survival ? [duration, event] : [target];
  const candidates = names.filter((c) => !excluded.includes(c));

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    // 勾選過、但在目前模型被排除的欄位（例如切回 Linear 後成為結果欄位）不送出
    const chosen = features.filter((c) => !excluded.includes(c));
    const vars = [...new Set([...chosen, ...extra.split(/[,，\s]+/).filter(Boolean)])];
    const applied = useSteps ? steps : [];
    const body =
      model === 'kaplan-meier'
        ? { duration, event, group: group || null, steps: applied }
        : model === 'cox'
          ? { duration, event, covariates: vars, steps: applied }
          : { target, features: vars, steps: applied };
    try {
      setResult(await api.post<Result>(`${base}/stats/${model}`, body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const select = (id: string, label: string, value: string, set: (v: string) => void, empty?: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{empty ?? '請選擇'}</option>
        {names.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <form aria-label="統計分析" className="card" onSubmit={run} noValidate>
        <h3>統計分析</h3>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="stats-model">模型</label>
            <select
              id="stats-model"
              className="select"
              value={model}
              onChange={(e) => {
                setModel(e.target.value as Model);
                setResult(null);
                setError(null);
              }}
              aria-describedby="stats-model-hint"
            >
              {MODELS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <span id="stats-model-hint" className="field__hint">
              {MODELS.find(([v]) => v === model)![2]}
            </span>
          </div>
          {survival ? (
            <>
              {select('stats-duration', '存活時間欄位', duration, setDuration)}
              {select('stats-event', '事件欄位（0／1）', event, setEvent)}
              {model === 'kaplan-meier' && select('stats-group', '分組欄位', group, setGroup, '不分組')}
            </>
          ) : (
            select('stats-target', '結果欄位', target, setTarget)
          )}
        </div>
        {picksVariables && (
          <fieldset className="section">
            <legend>{model === 'cox' ? '共變項' : '特徵欄位'}</legend>
            <div className="col-picker">
              {candidates.map((c) => (
                  <label key={c} className="checkbox">
                    <input
                      type="checkbox"
                      checked={features.includes(c)}
                      onChange={(e) => setFeatures(e.target.checked ? [...features, c] : features.filter((x) => x !== c))}
                    />
                    {c}
                  </label>
                ))}
            </div>
            <div className="field">
              <label htmlFor="stats-extra">其他欄位（前處理產生的新欄位，以逗號分隔）</label>
              <input id="stats-extra" className="input" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </div>
          </fieldset>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={useSteps} disabled={steps.length === 0} onChange={(e) => setUseSteps(e.target.checked)} />
          先套用前處理步驟（{steps.length ? steps.map((s) => stepSummary(s, catalogue)).join(' → ') : '目前沒有步驟'}）
        </label>
        <div className="row-actions section">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? '計算中…' : '執行分析'}
          </button>
        </div>
      </form>
      <ApiErrorAlert error={error} />
      {result && (
        <section className="card section" aria-label="分析結果">
          <h3>分析結果</h3>
          <ResultView r={result} />
        </section>
      )}
    </>
  );
}
