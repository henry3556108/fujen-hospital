// 選帳號：以逗號分隔的帳號欄位，輸入帳號開頭時列出符合的帳號（本專案成員在前），點一下加入。
// 帳號清單來自 /user-lookup（不需要 Admin）；查不到或沒有權限時不顯示建議，仍可直接輸入帳號。
import { useEffect, useRef, useState } from 'react';
import type { UserLookup, UserMatch } from '../api/userLookup';

const SEPARATOR = /[,，、\s]+/;
export const LOOKUP_DELAY_MS = 250;

/** 正在輸入的最後一個帳號（還沒打分隔符號）。 */
export function currentToken(text: string): string {
  return /[^,，、\s]*$/.exec(text)?.[0] ?? '';
}

/** 把正在輸入的帳號換成選到的帳號，後面接「, 」方便繼續輸入。 */
export function pickInto(text: string, username: string): string {
  return `${text.slice(0, text.length - currentToken(text).length)}${username}, `;
}

export function UserPicker({ id, value, onChange, lookup, placeholder, describedBy }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** null：不查（例如沒有選專案），只能手動輸入 */
  lookup: UserLookup | null;
  placeholder?: string;
  describedBy?: string;
}) {
  const [matches, setMatches] = useState<UserMatch[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const token = currentToken(value);
  const chosen = new Set(value.split(SEPARATOR).filter(Boolean));

  useEffect(() => {
    if (!lookup || !token) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      lookup(token).then(
        (found) => !cancelled && setMatches(found),
        () => !cancelled && setMatches([]),
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lookup, token]);

  // 已經完整輸入的帳號不再建議
  const shown = matches.filter((m) => !chosen.has(m.username));
  const hintId = `${id}-suggest-hint`;

  return (
    <>
      <input id={id} ref={input} className="input" value={value} placeholder={placeholder} autoComplete="off"
        aria-describedby={[describedBy, lookup ? hintId : null].filter(Boolean).join(' ') || undefined}
        onChange={(e) => onChange(e.target.value)} />
      {lookup ? (
        <span id={hintId} className="field__hint">
          輸入帳號開頭會列出符合的帳號，點一下即可加入；多個帳號以逗號分隔。
        </span>
      ) : null}
      {shown.length ? (
        <ul className="user-picker" aria-label="符合的帳號">
          {shown.map((m) => (
            <li key={m.username}>
              <button type="button" className="btn btn--small btn--secondary"
                onClick={() => {
                  onChange(pickInto(value, m.username));
                  setMatches([]);
                  input.current?.focus();
                }}>
                {m.username}
                {m.member ? '' : '（不是本專案成員）'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
