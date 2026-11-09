import type { ReactNode } from 'react';
import './ui.css';

export type ProgressTone = 'secondary' | 'primary' | 'pending';

function pct(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

export function formatPercent(value: number, max: number, digits = 1): string {
  return `${pct(value, max).toFixed(digits)}%`;
}

/**
 * 進度條（設計稿 A01「已確認 92 / 120」青綠進度條）。
 * label 是可見標題，也是 progressbar 的名稱；showValue 顯示「92 / 120」。
 */
export function ProgressBar({
  value,
  max,
  label,
  showValue = true,
  showPercent = false,
  tone = 'secondary',
  hideLabel,
}: {
  value: number;
  max: number;
  label: string;
  showValue?: boolean;
  showPercent?: boolean;
  tone?: ProgressTone;
  hideLabel?: boolean;
}) {
  return (
    <div className="ui-progress">
      <div className={`ui-progress__meta ${hideLabel ? 'visually-hidden' : ''}`}>
        <span className="ui-progress__label">{label}</span>
        {showValue && (
          <span className="ui-progress__value">
            {value} / {max}
          </span>
        )}
        {showPercent && <span className="ui-progress__pct">{formatPercent(value, max)}</span>}
      </div>
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} / ${max}`}
      >
        <span className={`ui-progress__fill ui-progress__fill--${tone}`} style={{ width: `${pct(value, max)}%` }} />
      </div>
    </div>
  );
}

/**
 * 已確認／待確認雙段（設計稿 A04「120 筆影像｜已確認 92 筆 76.7%｜待確認 28 筆 23.3%」）。
 * 兩段各自一條；total 不給時用 confirmed + pending。
 */
export function ConfirmProgress({
  confirmed,
  pending,
  total,
  unit = '筆',
  totalLabel,
  confirmedLabel = '已確認',
  pendingLabel = '待確認',
}: {
  confirmed: number;
  pending: number;
  total?: number;
  unit?: string;
  /** 左側大數字後的文字，例：筆影像 */
  totalLabel?: ReactNode;
  confirmedLabel?: string;
  pendingLabel?: string;
}) {
  const all = total ?? confirmed + pending;
  return (
    <div className="ui-confirm-progress">
      {totalLabel !== undefined && (
        <div className="ui-confirm-progress__total">
          <span className="ui-confirm-progress__num">{all}</span> {totalLabel}
        </div>
      )}
      {[
        { label: confirmedLabel, value: confirmed, tone: 'secondary' as const },
        { label: pendingLabel, value: pending, tone: 'pending' as const },
      ].map((seg) => (
        <div key={seg.label} className="ui-confirm-progress__seg">
          <div className="ui-confirm-progress__head">
            <span>
              {seg.label} <strong>{seg.value}</strong> {unit}
            </span>
          </div>
          <div className="ui-confirm-progress__bar">
            <div
              className="ui-progress__track"
              role="progressbar"
              aria-label={seg.label}
              aria-valuemin={0}
              aria-valuemax={all}
              aria-valuenow={seg.value}
              aria-valuetext={`${seg.value} / ${all}`}
            >
              <span className={`ui-progress__fill ui-progress__fill--${seg.tone}`} style={{ width: `${pct(seg.value, all)}%` }} />
            </div>
            <span className="ui-progress__pct">{formatPercent(seg.value, all)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 分段條（設計稿 B02「資料分群 70% / 15% / 15%」）。 */
export function SegmentBar({
  label,
  segments,
}: {
  label: string;
  segments: { label: string; value: number; tone?: 'secondary' | 'secondary-soft' | 'pending' }[];
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="ui-segbar" role="img" aria-label={`${label}：${segments.map((s) => `${s.label} ${formatPercent(s.value, total, 0)}`).join('、')}`}>
      <div className="ui-segbar__track">
        {segments.map((s, i) => (
          <span
            key={s.label}
            className={`ui-segbar__seg ui-segbar__seg--${s.tone ?? (i === 0 ? 'secondary' : i === 1 ? 'secondary-soft' : 'pending')}`}
            style={{ width: `${pct(s.value, total)}%` }}
          >
            {formatPercent(s.value, total, 0)}
          </span>
        ))}
      </div>
      <div className="ui-segbar__labels" aria-hidden="true">
        {segments.map((s) => (
          <span key={s.label} style={{ width: `${pct(s.value, total)}%` }}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
