import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../auth/SessionContext';
import { Alert, Icon, Stepper } from '../components/ui';
import { keycloakResetPasswordUrl } from './global/keycloak';
import './global/global.css';

// test 模式可選的種子帳號（對應驗收基線）
const TEST_USERS = ['admin01', 'pi01', 'md01', 'ra01', 'ca01', 'vw01', 'user01', 'user02'];

const FLOW = [
  { label: '院方登入', description: '使用院方帳號完成驗證' },
  { label: '返回平台', description: '登入完成後自動返回' },
  { label: '選擇專案', description: '進入你有權限的研究專案' },
];

/** 登入（B29）：院方 SSO、忘記密碼、登入失效提示 */
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
    <main id="main" className="gp-login">
      <div className="ui-card gp-login__card">
        <p className="gp-login__brand">
          <Icon name="lungs" />
          醫學研究平台
        </p>
        <h1 className="gp-login__title">使用院方帳號登入</h1>
        <p className="gp-login__lead">請使用院方帳號登入，以存取你的研究專案與相關功能。</p>
        {error && <Alert tone="error">{error}</Alert>}
        <form onSubmit={onSubmit} className="stack">
          {auth.mode === 'test' && (
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
          )}
          <button type="submit" className="btn btn--primary btn--block btn--large" disabled={busy}>
            {busy ? (
              '登入中…'
            ) : (
              <>
                <Icon name="external" /> 前往院方登入
              </>
            )}
          </button>
        </form>
        <p className="gp-login__links">
          <a href={keycloakResetPasswordUrl()}>忘記密碼？</a>
          <span className="text-muted">密碼重設由院方帳號服務（醫院統一身分）處理。</span>
        </p>
        <section className="gp-login__flow" aria-labelledby="login-flow">
          <h2 id="login-flow">登入後的操作流程</h2>
          <Stepper steps={FLOW} current={0} label="登入後的操作流程" />
        </section>
        {expired && <Alert tone="error">登入已失效，請重新登入。</Alert>}
      </div>
    </main>
  );
}
