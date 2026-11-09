import { useId, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../Icon';
import './ui.css';

/**
 * 右側資訊／編輯欄（設計稿 A04 資料集資訊、A06 送出前確認、B02 設定詳情、A02 匯入資料）。
 * 放在頁面格線的右欄；給 onClose 才出現關閉鈕。搭配 SplitLayout 排版。
 */
export function SidePanel({
  title,
  actions,
  onClose,
  children,
  footer,
  sticky = true,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  sticky?: boolean;
}) {
  const id = useId();
  return (
    <aside className={`ui-sidepanel ${sticky ? 'ui-sidepanel--sticky' : ''}`} aria-labelledby={id}>
      <div className="ui-sidepanel__head">
        <h2 id={id} className="ui-sidepanel__title">
          {title}
        </h2>
        {actions && <div className="ui-sidepanel__actions">{actions}</div>}
        {onClose && (
          <button type="button" className="ui-icon-btn" onClick={onClose} aria-label="關閉">
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="ui-sidepanel__body">{children}</div>
      {footer && <div className="ui-sidepanel__footer">{footer}</div>}
    </aside>
  );
}

/** 主內容＋右側欄的兩欄版面；窄螢幕右欄移到下方。 */
export function SplitLayout({ children, side, sideWidth }: { children: ReactNode; side?: ReactNode; sideWidth?: string }) {
  return (
    <div
      className={`ui-split ${side ? 'ui-split--with-side' : ''}`}
      style={sideWidth ? ({ '--ui-split-side': sideWidth } as CSSProperties) : undefined}
    >
      <div className="ui-split__main">{children}</div>
      {side}
    </div>
  );
}

/** 欄位：值 的直式清單（SidePanel 內常用，設計稿 A04「資料集名稱／來源專案／最後更新」） */
export function InfoList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="ui-infolist">
      {items.map((it) => (
        <div key={it.label} className="ui-infolist__row">
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
