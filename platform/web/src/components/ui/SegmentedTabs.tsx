import { useRef, type KeyboardEvent } from 'react';
import './ui.css';

export interface SegmentedTab<K extends string = string> {
  key: K;
  label: string;
}

/**
 * 頁內分頁（不換網址）：底線式，外觀與 components/Tabs 相同（設計稿 A02 影像／表格、A03 分類／物件偵測／影像分割）。
 * 要每個分頁一個網址時改用 components/Tabs。左右鍵切換。
 * 分頁內容請包在 id={tabPanelId(idPrefix, key)} 的 role="tabpanel" 裡。
 */
export function SegmentedTabs<K extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix = 'tab',
}: {
  items: SegmentedTab<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  idPrefix?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    onChange(items[n].key);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs ui-tabs">
      {items.map((t, i) => (
        <button
          key={t.key}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-${t.key}-tab`}
          aria-controls={tabPanelId(idPrefix, t.key)}
          aria-selected={t.key === value}
          tabIndex={t.key === value ? 0 : -1}
          className="tabs__item"
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function tabPanelId(idPrefix: string, key: string): string {
  return `${idPrefix}-${key}-panel`;
}
