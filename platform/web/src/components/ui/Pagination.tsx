import { useId } from 'react';
import { Icon } from '../Icon';
import './ui.css';

/** 要顯示的頁碼；'…' 代表省略。例：1 … 4 5 6 … 15 */
export function pageItems(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  let start = Math.max(2, page - 1);
  let end = Math.min(pageCount - 1, page + 1);
  if (page <= 3) {
    start = 2;
    end = 5;
  } else if (page >= pageCount - 2) {
    start = pageCount - 4;
    end = pageCount - 1;
  }
  if (start > 2) out.push('…');
  for (let i = start; i <= end; i++) out.push(i);
  if (end < pageCount - 1) out.push('…');
  out.push(pageCount);
  return out;
}

/**
 * 分頁：左「顯示第 1–10 筆，共 120 筆」、中「‹ 1 2 3 … 12 ›」、右「每頁顯示 [10] 筆」（設計稿 A02、A04 表格下方）。
 * page 從 1 起算。給 onPageSizeChange 才出現每頁筆數選單。
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
  label = '分頁',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  label?: string;
}) {
  const sizeId = useId();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="ui-pagination">
      <span className="ui-pagination__summary">
        顯示第 {from}–{to} 筆，共 {total} 筆
      </span>
      <nav aria-label={label} className="ui-pagination__pages">
        <button
          type="button"
          className="ui-pagination__btn"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="上一頁"
        >
          <Icon name="chevron-left" />
        </button>
        {pageItems(page, pageCount).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="ui-pagination__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className="ui-pagination__btn"
              aria-current={p === page ? 'page' : undefined}
              aria-label={`第 ${p} 頁`}
              onClick={() => onPageChange(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="ui-pagination__btn"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          aria-label="下一頁"
        >
          <Icon name="chevron-right" />
        </button>
      </nav>
      {onPageSizeChange && (
        <span className="ui-pagination__size">
          <label htmlFor={sizeId}>每頁顯示</label>
          <select id={sizeId} className="select" value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          筆
        </span>
      )}
    </div>
  );
}
