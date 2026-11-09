import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { withQuery } from '../../api/client';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { Heatmap } from '../../components/charts/Heatmap';
import { ScatterChart } from '../../components/charts/ScatterChart';
import { formatNumber } from '../../components/format';
import { useDataset } from './DatasetLayout';
import type { Correlation, Scatter } from './types';

const METHODS: [string, string][] = [
  ['pearson', 'Pearson'],
  ['spearman', 'Spearman'],
  ['kendall', 'Kendall'],
];

/** 「進一步分析」連到醫學統計分析段落並預選模型 */
const NEXT: [string, string][] = [
  ['logistic', 'Logistic Regression'],
  ['linear', 'Linear Regression'],
  ['kaplan-meier', 'Survival Analysis'],
  ['cox', 'Cox Proportional Hazard Model'],
];

/** Correlation Matrix 裡兩欄的係數；沒算過或不在矩陣裡回 null */
export function pairCoefficient(m: Correlation | null, x: string, y: string): number | null {
  if (!m) return null;
  const i = m.columns.indexOf(x);
  const j = m.columns.indexOf(y);
  return i < 0 || j < 0 ? null : (m.matrix[i]?.[j] ?? null);
}

/** TC-B04-05 Correlation Matrix 與 Scatter Chart（B10）：左邊 Correlation Matrix（三種方法），右邊 Scatter Chart，下方接醫學統計分析。 */
export function CorrelationTab() {
  const { api } = useSession();
  const { dataset, base } = useDataset();
  const numeric = dataset.columns.filter((c) => c.kind === 'numeric').map((c) => c.name);
  const [picked, setPicked] = useState<string[]>(numeric);
  const [method, setMethod] = useState('pearson');
  const [matrix, setMatrix] = useState<Correlation | null>(null);
  const [matrixError, setMatrixError] = useState<unknown>(null);
  const [x, setX] = useState(numeric[0] ?? '');
  const [y, setY] = useState(numeric[1] ?? numeric[0] ?? '');
  const [points, setPoints] = useState<Scatter | null>(null);
  const [scatterError, setScatterError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function runMatrix(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMatrixError(null);
    try {
      setMatrix(await api.get<Correlation>(withQuery(`${base}/correlation`, { columns: picked, method })));
    } catch (err) {
      setMatrixError(err);
      setMatrix(null);
    } finally {
      setBusy(false);
    }
  }

  async function runScatter(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setScatterError(null);
    try {
      setPoints(await api.get<Scatter>(withQuery(`${base}/scatter`, { x, y, limit: 2000 })));
    } catch (err) {
      setScatterError(err);
      setPoints(null);
    } finally {
      setBusy(false);
    }
  }

  const all = dataset.columns.map((c) => c.name);
  const r = points ? pairCoefficient(matrix, points.x, points.y) : null;
  const methodLabel = METHODS.find(([v]) => v === matrix?.method)?.[1] ?? matrix?.method;

  return (
    <>
      <div className="rd-two-col">
        <form aria-label="Correlation Matrix" className="card" onSubmit={runMatrix} noValidate>
          <h3>Correlation Matrix</h3>
          <ApiErrorAlert error={matrixError} />
          <fieldset className="rd-radios">
            <legend>相關係數方法</legend>
            {METHODS.map(([v, label]) => (
              <label key={v} className="checkbox">
                <input type="radio" name="corr-method" value={v} checked={method === v} onChange={() => setMethod(v)} />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset className="section">
            <legend>選擇數值欄位（至少 2 個）</legend>
            <div className="col-picker rd-chips">
              {numeric.map((c) => (
                <label key={c} className="checkbox">
                  <input
                    type="checkbox"
                    checked={picked.includes(c)}
                    onChange={(e) => setPicked(e.target.checked ? numeric.filter((n) => n === c || picked.includes(n)) : picked.filter((p) => p !== c))}
                  />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row-actions section">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              產生 Correlation Matrix
            </button>
          </div>
          {matrix && <Heatmap title={`Correlation Matrix（${matrix.method}）`} columns={matrix.columns} matrix={matrix.matrix} />}
        </form>

        <form aria-label="Scatter Chart" className="card" onSubmit={runScatter} noValidate>
          <h3>Scatter Chart</h3>
          <ApiErrorAlert error={scatterError} />
          <div className="toolbar">
            <div className="field">
              <label htmlFor="scatter-x">橫軸</label>
              <select id="scatter-x" className="select" value={x} onChange={(e) => setX(e.target.value)}>
                {all.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="scatter-y">縱軸</label>
              <select id="scatter-y" className="select" value={y} onChange={(e) => setY(e.target.value)}>
                {all.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              產生 Scatter Chart
            </button>
          </div>
          {points && (
            <>
              {r !== null && (
                <p className="text-muted section" data-testid="scatter-r">
                  相關係數 r = {formatNumber(r, 2)}（{methodLabel}）
                </p>
              )}
              <ScatterChart title={`${points.x} 與 ${points.y}`} xLabel={points.x} yLabel={points.y} points={points.points} />
              <p role="status" className="text-muted">
                {points.total} 筆兩欄都有值的資料{points.sampled ? `，抽樣顯示 ${points.returned} 筆` : ''}。
              </p>
            </>
          )}
        </form>
      </div>

      <section className="card section" aria-labelledby="corr-next">
        <h3 id="corr-next">進一步分析</h3>
        <p className="text-muted">看到有關的欄位後，可以用統計模型確認影響大小與顯著性（附 p 值與 95% 信賴區間）。</p>
        <div className="rd-next">
          {NEXT.map(([model, label]) => (
            <Link key={model} to={`?show=stats&model=${model}`} className="btn btn--secondary btn--small">
              {label}
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
