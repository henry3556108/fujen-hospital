import { formatNumber } from '../../components/format';
import type { Cell, Preview } from './types';

export function cellText(value: Cell): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'number') return formatNumber(value, 6);
  return String(value);
}

/** 資料預覽表：第一欄是列號（從 0 起算，與驗證報告相同）。 */
export function DataTable({ label, preview }: { label: string; preview: Preview }) {
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col" className="num">
              列
            </th>
            {preview.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r, i) => (
            <tr key={preview.offset + i}>
              <th scope="row" className="num">
                {preview.offset + i}
              </th>
              {r.map((v, j) => (
                <td key={preview.columns[j]} className={typeof v === 'number' ? 'num' : v === null ? 'text-muted' : undefined}>
                  {cellText(v)}
                </td>
              ))}
            </tr>
          ))}
          {preview.rows.length === 0 && (
            <tr>
              <td colSpan={preview.columns.length + 1}>沒有資料列</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
