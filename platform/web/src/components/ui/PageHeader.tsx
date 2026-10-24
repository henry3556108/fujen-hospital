import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import './ui.css';

export interface Crumb {
  label: string;
  to?: string;
}

/** 頁面標題區：大標題＋灰色副標，右上放主要動作（設計稿 A01～A08 標題列）。 */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** 上一層位置，例：使用模型 › 模型結果（設計稿 A07） */
  breadcrumbs?: Crumb[];
  /** 標題下方的額外內容，例如分頁 */
  children?: ReactNode;
}) {
  return (
    <div className="ui-page-header">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="目前位置" className="ui-page-header__crumbs">
          <ol>
            {breadcrumbs.map((c, i) => (
              <li key={`${c.label}-${i}`}>
                {i > 0 && <Icon name="chevron-right" className="ui-page-header__crumb-sep" />}
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="ui-page-header__row">
        <div className="ui-page-header__text">
          <h1 className="ui-page-header__title">{title}</h1>
          {subtitle && <p className="ui-page-header__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="ui-page-header__actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
