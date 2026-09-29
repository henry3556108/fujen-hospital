import { useState, type FormEvent } from 'react';
import { withQuery } from '../../api/client';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { Heatmap } from '../../components/charts/Heatmap';
import { ScatterChart } from '../../components/charts/ScatterChart';
import { useDataset } from './DatasetLayout';
import type { Correlation, Scatter } from './types';

const METHODS = [
  ['pearson', 'Pearson'],
  ['spearman', 'Spearman'],
  ['kendall', 'Kendall'],
];

/** TC-B04-05 相關矩陣與散佈圖。 */
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

  return (
    <>
      <form aria-label="相關矩陣" className="card" onSubmit={runMatrix} noValidate>
        <h3>相關矩陣</h3>
        <ApiErrorAlert error={matrixError} />
        <fieldset>
          <legend>數值欄位（至少 2 個）</legend>
          <div className="col-picker">
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
        <div className="toolbar section">
          <div className="field">
            <label htmlFor="corr-method">方法</label>
            <select id="corr-method" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            產生相關矩陣
          </button>
        </div>
        {matrix && <Heatmap title={`相關矩陣（${matrix.method}）`} columns={matrix.columns} matrix={matrix.matrix} />}
      </form>

      <form aria-label="散佈圖" className="card section" onSubmit={runScatter} noValidate>
        <h3>散佈圖</h3>
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
            產生散佈圖
          </button>
        </div>
        {points && (
          <>
            <ScatterChart title={`${points.x} 與 ${points.y}`} xLabel={points.x} yLabel={points.y} points={points.points} />
            <p role="status" className="text-muted">
              {points.total} 筆兩欄都有值的資料{points.sampled ? `，抽樣顯示 ${points.returned} 筆` : ''}。
            </p>
          </>
        )}
      </form>
    </>
  );
}
