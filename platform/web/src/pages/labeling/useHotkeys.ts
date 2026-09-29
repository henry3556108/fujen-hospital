import { useEffect, useRef } from 'react';

export interface Hotkey {
  /** 顯示給使用者看的按鍵，例如「1–5」「R／L」 */
  keys: string;
  description: string;
}

export type HotkeyHandlers = Record<string, (e: KeyboardEvent) => void>;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** 把按鍵事件轉成 'ctrl+s'、'arrowup'、'r' 這種索引鍵。 */
export function hotkeyId(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): string {
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  return `${e.ctrlKey || e.metaKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${key}`;
}

/** 全頁快捷鍵。正在輸入文字時不觸發（Ctrl 組合鍵例外），對話框開啟時不觸發。 */
export function useHotkeys(handlers: HotkeyHandlers, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const id = hotkeyId(e);
      const handler = ref.current[id];
      if (!handler) return;
      if (isTyping(e.target) && !id.startsWith('ctrl+')) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      handler(e);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
