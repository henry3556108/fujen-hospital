// 標註頁共用的小元件：標籤選擇、評分、圖例。
import { useId } from 'react';
import { ANNOTATION_COLOR_COUNT } from './colors';

export const DEFAULT_LABELS = ['nodule', 'lung', 'normal'];

/** 從既有標籤挑選，或輸入新的標籤。 */
export function LabelPicker({
  value,
  options,
  onChange,
  label = '標籤',
  ariaLabel,
}: {
  value: string;
  options: string[];
  onChange: (label: string) => void;
  label?: string;
  /** 畫面文字與輔助技術名稱不同時用（工作台畫面寫「標註類別」，名稱沿用「標籤」） */
  ariaLabel?: string;
}) {
  const id = useId();
  const listId = `${id}-options`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        aria-label={ariaLabel}
        placeholder="例如 normal、nodule"
        list={listId}
        value={value}
        maxLength={128}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <span id={`${id}-hint`} className="field__hint">
        可從清單挑選，或直接輸入新標籤
      </span>
    </div>
  );
}

/** 1–5 分；再按一次目前的分數可以清除。 */
export function Rating({
  value,
  onChange,
  name,
  disabled,
  label,
}: {
  value: number | null;
  onChange: (rating: number | null) => void;
  name: string;
  disabled?: boolean;
  /** 整組的名稱；預設「{name} 的評分」 */
  label?: string;
}) {
  return (
    <fieldset className="rating" aria-label={label ?? `${name} 的評分`} data-rating={value ?? ''}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className="btn btn--small btn--secondary rating__option"
          aria-pressed={value === n}
          aria-label={`${n} 分`}
          disabled={disabled}
          onClick={() => onChange(value === n ? null : n)}
        >
          {n}
        </button>
      ))}
    </fieldset>
  );
}

export function Legend({ colorOf }: { colorOf: Record<string, number> }) {
  const labels = Object.keys(colorOf).sort();
  if (labels.length === 0) return null;
  return (
    <ul className="legend" aria-label="標籤顏色">
      {labels.map((l) => (
        <li key={l}>
          <span className={`legend__swatch legend__swatch--${((colorOf[l] - 1) % ANNOTATION_COLOR_COUNT) + 1}`} aria-hidden="true" />
          {l}
        </li>
      ))}
    </ul>
  );
}

export function formatDate(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : yyyymmdd;
}
