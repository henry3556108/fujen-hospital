import { formatPercent } from './ProgressBar';
import './ui.css';

export interface BarListItem {
  label: string;
  value: number;
}

/**
 * 類別統計橫條：● 名稱　72（60.0%），下方一條細橫條（設計稿 A04 類別統計、來源統計）。
 * total 不給時用各項加總。第一項用青綠，其餘用灰藍。
 */
export function BarList({
  items,
  total,
  label,
  emptyText = '沒有資料',
}: {
  items: BarListItem[];
  total?: number;
  /** 清單名稱（給輔助技術），例：類別統計 */
  label: string;
  emptyText?: string;
}) {
  const sum = total ?? items.reduce((a, it) => a + it.value, 0);
  if (items.length === 0) return <p className="ui-barlist__empty">{emptyText}</p>;
  return (
    <ul className="ui-barlist" aria-label={label}>
      {items.map((it, i) => (
        <li key={it.label} className="ui-barlist__item">
          <div className="ui-barlist__row">
            <span className={`ui-barlist__dot ${i === 0 ? 'ui-barlist__dot--first' : ''}`} aria-hidden="true" />
            <span className="ui-barlist__label">{it.label}</span>
            <span className="ui-barlist__value">
              {it.value}（{formatPercent(it.value, sum)}）
            </span>
          </div>
          <span className="ui-barlist__track" aria-hidden="true">
            <span
              className={`ui-barlist__fill ${i === 0 ? 'ui-barlist__fill--first' : ''}`}
              style={{ width: formatPercent(it.value, sum) }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
