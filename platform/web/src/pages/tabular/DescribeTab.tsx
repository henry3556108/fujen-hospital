import { useState } from 'react';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { BarChart } from '../../components/charts/BarChart';
import { formatTick } from '../../components/charts/scale';
import { formatNumber, formatStat } from '../../components/format';
import { cellText } from './DataTable';
import { useDataset } from './DatasetLayout';
import { facts, isBinary01, isIdentifier, typeLabel } from './columnOverview';
import { KIND_LABELS, type Describe, type Histogram, type ValueCounts } from './types';

function Distribution({ column, numeric }: { column: string; numeric: boolean }) {
  const { api } = useSession();
  const { base } = useDataset();
  const [bins, setBins] = useState(10);
  const data = useResource<Histogram | ValueCounts>(
    () =>
      numeric
        ? api.get<Histogram>(withQuery(`${base}/histogram`, { column, bins }))
        : api.get<ValueCounts>(withQuery(`${base}/value-counts`, { column, limit: 30 })),
    [base, column, numeric, bins],
  );
  const d = data.data;
  return (
    <>
      {numeric && (
        <div className="field field--inline">
          <label htmlFor="bins">分組數</label>
          <select id="bins" className="select" value={bins} onChange={(e) => setBins(Number(e.target.value))}>
            {[5, 10, 20, 30].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      )}
      <ApiErrorAlert error={data.error} />
      {d && !data.error && d.column === column && (
        <>
          {'bins' in d ? (
            <BarChart
              title={`${column} 的分布`}
              xLabel={column}
              yLabel="筆數"
              bars={d.bins.map((b) => ({ label: `${formatTick(b.start)}–${formatTick(b.end)}`, value: b.count, detail: `${formatTick(b.start)} – ${formatTick(b.end)}` }))}
            />
          ) : (
            <BarChart
              title={`${column} 的各類別筆數`}
              xLabel={column}
              yLabel="筆數"
              bars={d.items.map((i) => ({ label: cellText(i.value).slice(0, 8), value: i.count, detail: cellText(i.value) }))}
            />
          )}
          <p className="text-muted">
            缺值 {d.missing} 筆{'distinct' in d ? `，共 ${d.distinct} 個類別${d.distinct > d.items.length ? `（只顯示前 ${d.items.length} 個）` : ''}` : ''}。
          </p>
        </>
      )}
    </>
  );
}

/** TC-B04-01 描述統計與分布；數值與 API（pandas）回傳值相同，只做顯示用的四捨五入。 */
export function DescribeTab() {
  const { api } = useSession();
  const { dataset, base } = useDataset();
  const stats = useResource(() => api.get<Describe>(`${base}/describe`), [base]);
  const [column, setColumn] = useState(dataset.columns.find((c) => c.kind === 'numeric')?.name ?? dataset.columns[0]?.name ?? '');
  const kind = dataset.columns.find((c) => c.name === column)?.kind;
  const n = (v: number | undefined) => (v === undefined ? '—' : formatNumber(v, 6));
  // 計算出的統計量四捨五入到好讀的位數，滑鼠移上去看完整數值
  const stat = (v: number | undefined) => (v === undefined ? '—' : <span title={String(v)}>{formatStat(v)}</span>);
  const overview = stats.data ? facts(stats.data.columns, stats.data.row_count, dataset.schema.columns, stats.data.columns) : [];

  return (
    <>
      <ApiErrorAlert error={stats.error} />
      {stats.loading && !stats.data && <p role="status">載入中…</p>}
      {stats.data && (
        <>
          <p role="status">
            共 {stats.data.row_count} 列、{stats.data.columns.length} 欄
          </p>
          <div className="table-wrap">
            <table aria-label="描述統計">
              <thead>
                <tr>
                  <th scope="col">欄位</th>
                  <th scope="col">類型</th>
                  <th scope="col" className="num">
                    筆數
                  </th>
                  <th scope="col" className="num">
                    缺值
                  </th>
                  <th scope="col" className="num">
                    <abbr title="這一欄有幾種不同的值（不算缺值）。等於列數時，多半是病歷號等識別碼。">相異值</abbr>
                  </th>
                  <th scope="col" className="num">
                    平均
                  </th>
                  <th scope="col" className="num">
                    <abbr title="數值分散的程度：越大代表大家差異越大。">標準差</abbr>
                  </th>
                  <th scope="col" className="num">
                    最小
                  </th>
                  <th scope="col" className="num">
                    <abbr title="由小排到大，位在 25% 位置的值；例如 P25＝41 表示四分之一的人小於 41。">P25</abbr>
                  </th>
                  <th scope="col" className="num">
                    <abbr title="由小排到大，正中間的值；一半的人小於它。">中位數</abbr>
                  </th>
                  <th scope="col" className="num">
                    <abbr title="由小排到大，位在 75% 位置的值；四分之三的人小於它。">P75</abbr>
                  </th>
                  <th scope="col" className="num">
                    最大
                  </th>
                  <th scope="col">最常見值</th>
                  <th scope="col" className="num">
                    次數
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.data.columns.map((c, i) => {
                  const f = overview[i];
                  const binary = isBinary01(f);
                  const id = isIdentifier(f);
                  const dash = binary || id;
                  return (
                    <tr key={c.name}>
                      <th scope="row">{c.name}</th>
                      <td>{typeLabel(f)}</td>
                      <td className="num">{c.count}</td>
                      <td className="num">{c.missing}</td>
                      <td className="num">{c.unique}</td>
                      <td className="num">{binary && c.mean !== undefined ? `${formatNumber(c.mean * 100, 3)}% 為 1` : id ? '—' : stat(c.mean)}</td>
                      <td className="num">{dash ? '—' : stat(c.std)}</td>
                      <td className="num">{id ? '—' : n(c.min)}</td>
                      <td className="num">{dash ? '—' : stat(c.p25)}</td>
                      <td className="num">{dash ? '—' : stat(c.p50)}</td>
                      <td className="num">{dash ? '—' : stat(c.p75)}</td>
                      <td className="num">{id ? '—' : n(c.max)}</td>
                      <td>{c.top === undefined || id ? '—' : cellText(c.top)}</td>
                      <td className="num">{id ? '—' : (c.freq ?? '—')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details className="section" open>
            <summary>表頭說明（P25、中位數、P75、標準差、相異值是什麼）</summary>
            <dl className="kv">
              <dt>相異值</dt>
              <dd>這一欄有幾種不同的值（不算缺值）。等於列數時，多半是病歷號等識別碼。</dd>
              <dt>平均、標準差</dt>
              <dd>標準差表示數值分散的程度：越大代表大家差異越大。是／否欄位改顯示「為 1 的比例」。</dd>
              <dt>P25、中位數、P75</dt>
              <dd>由小排到大，位在 25%、50%、75% 位置的值；例如 P25＝41 表示四分之一的人小於 41，P25 到 P75 之間是中間一半的人。</dd>
              <dt>最常見值、次數</dt>
              <dd>類別欄位中出現最多的值，以及出現幾次。</dd>
            </dl>
          </details>
        </>
      )}

      <section className="card section" aria-labelledby="distribution-title">
        <h3 id="distribution-title">分布</h3>
        <div className="field field--inline">
          <label htmlFor="dist-column">欄位</label>
          <select id="dist-column" className="select" value={column} onChange={(e) => setColumn(e.target.value)}>
            {dataset.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}（{KIND_LABELS[c.kind] ?? c.kind}）
              </option>
            ))}
          </select>
        </div>
        {column && <Distribution key={column} column={column} numeric={kind === 'numeric'} />}
      </section>
    </>
  );
}
