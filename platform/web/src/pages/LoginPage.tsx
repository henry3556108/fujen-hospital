import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../auth/SessionContext';
import { Alert } from '../components/Alert';
import { keycloakResetPasswordUrl } from './global/keycloak';

// test 模式可選的種子帳號（對應驗收基線）
const TEST_USERS = ['admin01', 'pi01', 'md01', 'ra01', 'ca01', 'vw01', 'user01', 'user02'];

export function LoginPage() {
  const { auth, status, expired, login } = useSession();
  const location = useLocation();
  const [username, setUsername] = useState('admin01');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (status === 'ready') return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ username: auth.mode === 'test' ? username : undefined, returnTo: from });
    } catch {
      setError('無法連線到登入服務（Keycloak），請稍後再試。');
      setBusy(false);
    }
  }

  return (
    <main id="main" className="login">
      <div className="login__card card">
        <p className="login__product">AI 模型開發管理平台</p>
        <h1>登入</h1>
        {expired && <Alert tone="warning">登入已失效，請重新登入。</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        <form onSubmit={onSubmit} className="stack">
          {auth.mode === 'test' ? (
            <>
              <Alert tone="info" title="測試登入模式">
                僅限開發環境，不連線 Keycloak。
              </Alert>
              <div className="field">
                <label htmlFor="test-user">測試帳號</label>
                <select id="test-user" className="select" value={username} onChange={(e) => setUsername(e.target.value)}>
                  {TEST_USERS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <p className="text-muted">使用醫院統一身分（單一登入）登入，將前往登入頁面。</p>
          )}
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? '登入中…' : '登入'}
          </button>
        </form>
        <p className="login__links">
          <a href={keycloakResetPasswordUrl()}>忘記密碼</a>
          <span className="text-muted">（前往醫院統一身分重設密碼）</span>
        </p>
      </div>
    </main>
  );
}
