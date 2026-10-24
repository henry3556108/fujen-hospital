import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../Icon';
import './ui.css';

export type StatTone = 'primary' | 'secondary' | 'warning' | 'error' | 'neutral';

/** 統計方塊：左側圖示、標籤、大數字（設計稿 B17 專案總數／帳號總數）。給 onClick 或 to 時整塊可點，右側出現 ›。 */
export function StatTile({
  label,
  value,
  unit,
  icon,
  tone = 'primary',
  hint,
  onClick,
  to,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: IconName;
  tone?: StatTone;
  hint?: ReactNode;
  onClick?: () => void;
  to?: string;
}) {
  const inner = (
    <>
      {icon && (
        <span className={`ui-stat__icon ui-stat__icon--${tone}`} aria-hidden="true">
          <Icon name={icon} />
        </span>
      )}
      <span className="ui-stat__text">
        <span className="ui-stat__label">{label}</span>
        <span className={`ui-stat__value ui-stat__value--${tone}`}>
          {value}
          {unit && <span className="ui-stat__unit">{unit}</span>}
        </span>
        {hint && <span className="ui-stat__hint">{hint}</span>}
      </span>
      {(onClick || to) && <Icon name="chevron-right" className="ui-stat__chevron" />}
    </>
  );
  if (to) {
    return (
      <Link to={to} className="ui-stat ui-stat--clickable">
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className="ui-stat ui-stat--clickable" onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className="ui-stat">{inner}</div>;
}
