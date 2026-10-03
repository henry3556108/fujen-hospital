import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** 關閉按鈕的文字；確認動作本身是「取消…」時改用例如「不要取消」，避免兩個按鈕都叫「取消」 */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/** 危險操作前的確認視窗：開啟時焦點移到「取消」，Esc 關閉，Tab 不會離開視窗，關閉後焦點回到觸發按鈕。 */
export function ConfirmDialog({ title, children, confirmLabel, cancelLabel = '取消', onConfirm, onCancel, busy }: Props) {
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === 'Tab' && ref.current) {
      const focusables = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled)'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div className="modal">
      <div className="modal__backdrop" onClick={onCancel} />
      <div
        ref={ref}
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={descId}>{children}</div>
        <div className="modal__actions">
          <button ref={cancelRef} type="button" className="btn btn--secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
