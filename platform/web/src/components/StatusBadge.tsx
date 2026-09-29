import { Icon } from './Icon';
import '../styles/pages.css';

export type BadgeTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

/** 狀態標籤：Icon＋文字，顏色只是輔助。 */
export function StatusBadge({ tone, children }: { tone: BadgeTone; children: string }) {
  return (
    <span className={`badge status-badge status-badge--${tone}`}>
      {tone !== 'neutral' && <Icon name={tone} className="status-badge__icon" />}
      {children}
    </span>
  );
}
