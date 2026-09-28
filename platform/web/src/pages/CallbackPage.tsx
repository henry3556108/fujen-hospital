import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../auth/SessionContext';
import { Alert } from '../components/Alert';

/** OIDC redirect_uri：交換授權碼後回到原本頁面。 */
export function CallbackPage() {
  const { auth, reload } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode 下避免重複交換授權碼
    started.current = true;
    auth
      .handleCallback()
      .then((returnTo) => {
        reload();
        navigate(returnTo, { replace: true });
      })
      .catch(() => setError(true));
  }, [auth, navigate, reload]);

  return (
    <main id="main" className="login">
      <div className="login__card card">
        <h1>登入處理中</h1>
        {error ? (
          <>
            <Alert tone="error">登入回應無效或已過期。</Alert>
            <Link to="/login">回登入頁</Link>
          </>
        ) : (
          <p role="status">正在完成登入…</p>
        )}
      </div>
    </main>
  );
}
