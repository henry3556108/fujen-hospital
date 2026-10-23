// 全域「有沒存的內容」登記（03 規格 4.1：離開或切換專案前先提醒）。
//
// 用法（任何頁面）：
//   import { useUnsavedChanges } from '../../components/unsaved';
//   useUnsavedChanges(isDirty, '標註還沒儲存');
// isDirty 為 true 時登記；切換專案、點側欄、關閉分頁（beforeunload）都會先詢問。
// 自己的頁內動作（例如「下一筆」）想一起提醒時呼叫 confirmLeave('開啟下一筆')，回傳 false 就不要繼續。
import { useEffect } from 'react';

const registry = new Map<symbol, string>();

const DEFAULT_MESSAGE = '這一頁有還沒儲存的內容。';

export function hasUnsavedChanges(): boolean {
  return registry.size > 0;
}

/** 有沒存的內容時跳出確認；使用者取消就回傳 false。action 例：「切換專案」 */
export function confirmLeave(action = '離開這一頁'): boolean {
  if (registry.size === 0) return true;
  const message = [...registry.values()][0];
  return window.confirm(`${message}\n確定要${action}嗎？還沒儲存的內容會遺失。`);
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (registry.size === 0) return;
  e.preventDefault();
  e.returnValue = '';
}

/** 頁面登記自己有沒存的內容；元件卸載或 dirty 變回 false 時自動取消登記。 */
export function useUnsavedChanges(dirty: boolean, message: string = DEFAULT_MESSAGE): void {
  useEffect(() => {
    if (!dirty) return;
    const key = Symbol('unsaved');
    registry.set(key, message);
    if (registry.size === 1) window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      registry.delete(key);
      if (registry.size === 0) window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty, message]);
}
