import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'ai-platform.theme';

function read(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const el = document.documentElement;
  if (choice === 'system') delete el.dataset.theme;
  else el.dataset.theme = choice;
}

/** 啟動時套用上次選擇，避免閃爍。 */
export function applyStoredTheme(): void {
  applyTheme(read());
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  useEffect(() => {
    applyTheme(choice);
    try {
      if (choice === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch {
      /* 無法儲存時只影響本次瀏覽 */
    }
  }, [choice]);
  return (
    <div className="field field--inline">
      <label htmlFor="theme-toggle">色彩主題</label>
      <select id="theme-toggle" className="select" value={choice} onChange={(e) => setChoice(e.target.value as ThemeChoice)}>
        <option value="system">跟隨系統</option>
        <option value="light">淺色</option>
        <option value="dark">深色</option>
      </select>
    </div>
  );
}
