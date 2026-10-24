// 介面主題（B32 個人設定）：跟隨系統／淺色／深色。
// 存在瀏覽器 localStorage（個人偏好，只影響這台電腦）；讀寫失敗時當成跟隨系統。
// tokens.css：<html data-theme="dark"> 深色、"light" 強制淺色、不設定跟隨系統。

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ai-platform.theme';

export const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: '跟隨系統' },
  { value: 'light', label: '淺色' },
  { value: 'dark', label: '深色' },
];

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/** 儲存並套用；回傳 false 表示瀏覽器不允許儲存（仍會套用到目前畫面） */
export function saveTheme(choice: ThemeChoice): boolean {
  applyTheme(choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** 啟動時套用上次儲存的主題 */
export function applyStoredTheme(): void {
  applyTheme(readTheme());
}
