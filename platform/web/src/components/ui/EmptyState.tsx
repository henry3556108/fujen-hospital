import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';
import './ui.css';

/** 沒有資料時的提示：圖示、標題、說明、下一步動作。 */
export function EmptyState({
  title,
  description,
  icon = 'folder',
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <Icon name={icon} className="ui-empty__icon" />
      <p className="ui-empty__title">{title}</p>
      {description && <p className="ui-empty__desc">{description}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
