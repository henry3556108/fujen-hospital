import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../Icon';
import './ui.css';

/**
 * 從右滑出的面板：半透明遮罩、Esc 或點遮罩關閉、開啟時焦點移入、關閉後焦點回原處
 * （設計稿 A02「匯入資料」、數據管理逐筆詳情）。open 為 false 時不渲染。
 */
export function SlideOver({
  open,
  title,
  onClose,
  children,
  footer,
  width,
  closeOnBackdrop = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** CSS 寬度，預設 28rem */
  width?: string;
  closeOnBackdrop?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ui-slideover">
      <div
        className="ui-slideover__backdrop"
        data-testid="slideover-backdrop"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="ui-slideover__panel"
        style={width ? { width: `min(${width}, 100%)` } : undefined}
      >
        <div className="ui-slideover__head">
          <h2 id={id} className="ui-slideover__title">
            {title}
          </h2>
          <button type="button" className="ui-icon-btn" onClick={onClose} aria-label="關閉">
            <Icon name="close" />
          </button>
        </div>
        <div className="ui-slideover__body">{children}</div>
        {footer && <div className="ui-slideover__footer">{footer}</div>}
      </div>
    </div>
  );
}
