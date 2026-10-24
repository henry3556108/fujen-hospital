import { useId, type ReactNode } from 'react';
import './ui.css';

/** 白底卡片：左上標題、右上「查看全部 ›」等連結（設計稿 A01 最近處理、B17 待處理事項）。 */
export function Card({
  title,
  extra,
  children,
  footer,
  className,
  flush,
  headingLevel = 2,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** true＝內容貼齊邊框（放表格時用） */
  flush?: boolean;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const H = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section
      className={`ui-card ${flush ? 'ui-card--flush' : ''} ${className ?? ''}`}
      aria-labelledby={title ? id : undefined}
    >
      {(title || extra) && (
        <div className="ui-card__head">
          {title && (
            <H id={id} className="ui-card__title">
              {title}
            </H>
          )}
          {extra && <div className="ui-card__extra">{extra}</div>}
        </div>
      )}
      <div className="ui-card__body">{children}</div>
      {footer && <div className="ui-card__footer">{footer}</div>}
    </section>
  );
}
