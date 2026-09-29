import '../../styles/pages.css';

/** 相關係數 → 儲存格底色：負相關藍、正相關紅、0 為中性灰。最深只混到 60%，文字對比才夠。 */
export function cellColor(value: number | null): string {
  if (value === null || Number.isNaN(value)) return 'var(--chart-neutral)';
  const pole = value < 0 ? 'var(--chart-negative)' : 'var(--chart-positive)';
  const pct = Math.round(Math.min(1, Math.abs(value)) * 60);
  return `color-mix(in srgb, ${pole} ${pct}%, var(--chart-neutral))`;
}

/** 相關矩陣：本身就是表格，數值直接寫在格子裡，顏色只是輔助。 */
export function Heatmap({ title, columns, matrix }: { title: string; columns: string[]; matrix: (number | null)[][] }) {
  return (
    <figure className="chart">
      <figcaption className="chart__title">{title}</figcaption>
      <div className="table-wrap">
        <table className="heatmap" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">欄位</th>
              {columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, i) => (
              <tr key={columns[i]}>
                <th scope="row">{columns[i]}</th>
                {row.map((v, j) => (
                  <td key={columns[j]} className="heatmap__cell" style={{ background: cellColor(v) }}>
                    {v === null || Number.isNaN(v) ? '—' : v.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="chart__legend" aria-label="圖例">
        <li>
          <span className="chart__swatch" style={{ background: cellColor(-1) }} />
          負相關（−1）
        </li>
        <li>
          <span className="chart__swatch" style={{ background: cellColor(0) }} />
          無相關（0）
        </li>
        <li>
          <span className="chart__swatch" style={{ background: cellColor(1) }} />
          正相關（+1）
        </li>
      </ul>
    </figure>
  );
}
