import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { ENTRIES, checkAccess, entryByKey, type Entry } from './access/entries';
import type { AuthAdapter } from './auth/adapter';
import { SessionProvider, useSession } from './auth/SessionContext';
import { ApiErrorAlert } from './components/Alert';
import { AppLayout } from './components/AppLayout';
import { CallbackPage } from './pages/CallbackPage';
import { LoginPage } from './pages/LoginPage';
import { AccessDenied, HomePage, ModulePlaceholder, NotFoundPage } from './pages/SimplePages';
import { ProjectsPage } from './pages/admin/ProjectsPage';
import { UsersPage } from './pages/admin/UsersPage';
import { MembersPage } from './pages/admin/MembersPage';
import { SchedulingPlaceholder } from './pages/admin/SchedulingPlaceholder';

function RequireAuth() {
  const { status, loadError, reload } = useSession();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <p role="status" className="loading">
        載入中…
      </p>
    );
  }
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (status === 'error') {
    return (
      <main id="main" className="login">
        <div className="login__card card stack">
          <h1>無法載入帳號資訊</h1>
          <ApiErrorAlert error={loadError} />
          <button type="button" className="btn btn--primary" onClick={reload}>
            重試
          </button>
        </div>
      </main>
    );
  }
  return <Outlet />;
}

/** 直接輸入網址也要擋：規則與選單共用 access/entries.ts 的 checkAccess。 */
function EntryGuard({ entry, children }: { entry: Entry; children: ReactNode }) {
  const { me, project } = useSession();
  const result = checkAccess(entry, me!, project);
  if (!result.allowed) return <AccessDenied reason={result.reason} />;
  return <>{children}</>;
}

function AdminLayout() {
  return (
    <>
      <h1>帳號管理</h1>
      <nav aria-label="帳號管理分頁" className="tabs">
        <NavLink to="/admin/projects" className="tabs__item">
          專案
        </NavLink>
        <NavLink to="/admin/users" className="tabs__item">
          帳號
        </NavLink>
        <NavLink to="/admin/members" className="tabs__item">
          專案成員
        </NavLink>
        <NavLink to="/admin/scheduling" className="tabs__item">
          共享排程設定
        </NavLink>
      </nav>
      <Outlet />
    </>
  );
}

export function App({ auth, apiBase }: { auth: AuthAdapter; apiBase: string }) {
  const adminEntry = entryByKey('admin')!;
  return (
    <SessionProvider auth={auth} apiBase={apiBase}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<CallbackPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />
            <Route
              path="admin/scheduling"
              element={
                <EntryGuard entry={adminEntry}>
                  <SchedulingPlaceholder />
                </EntryGuard>
              }
            />
            <Route
              path="admin"
              element={
                <EntryGuard entry={adminEntry}>
                  <AdminLayout />
                </EntryGuard>
              }
            >
              <Route index element={<Navigate to="/admin/projects" replace />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="members" element={<MembersPage />} />
            </Route>
            {ENTRIES.filter((e) => e.placeholder).map((e) => (
              <Route
                key={e.key}
                path={e.path.slice(1)}
                element={
                  <EntryGuard entry={e}>
                    <ModulePlaceholder entry={e} />
                  </EntryGuard>
                }
              />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </SessionProvider>
  );
}
