import { formatNumber } from '../../components/format';
import type { Cell, Preview } from './types';

export function cellText(value: Cell): string {
  if (value === null || value === undefined) return '（空）';
  if (typeof value === 'number') return formatNumber(value, 6);
  return String(value);
}

/**
 * 資料預覽表：第一欄是列號（從 1 起算，與驗證報告的「第幾列」相同）。
 * cellClass：額外的儲存格樣式（處理前後比較標出缺值與補上的值）。
 */
export function DataTable({
  label,
  preview,
  cellClass,
}: {
  label: string;
  preview: Preview;
  cellClass?: (row: number, column: string, value: Cell) => string | undefined;
}) {
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
                {preview.offset + i + 1}
              </th>
              {r.map((v, j) => (
                <td
                  key={preview.columns[j]}
                  className={[typeof v === 'number' ? 'num' : v === null ? 'text-muted' : '', cellClass?.(i, preview.columns[j], v) ?? '']
                    .filter(Boolean)
                    .join(' ') || undefined}
                >
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
