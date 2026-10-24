import type { ReactNode } from 'react';
import type { BadgeTone } from '../StatusBadge';
import './ui.css';

export type { BadgeTone };

/**
 * 淡底文字徽章，無圖示（設計稿 A02／A04 表格「已確認」青綠、「待確認」橘、「正常／異常」）。
 * 需要圖示強調時用 components/StatusBadge。
 */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}

/** 圓點＋文字（設計稿 B17「● 運作正常」「● 進行中」）。 */
export function StatusDot({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`ui-dot ui-dot--${tone}`}>
      <span className="ui-dot__mark" aria-hidden="true" />
      {children}
    </span>
  );
}
