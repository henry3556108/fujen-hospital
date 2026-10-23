import type { ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AREAS, checkAccess } from './access/entries';
import type { AuthAdapter } from './auth/adapter';
import { SessionProvider, useSession } from './auth/SessionContext';
import { ApiErrorAlert } from './components/Alert';
import { AppLayout } from './components/AppLayout';
import { CallbackPage } from './pages/CallbackPage';
import { LoginPage } from './pages/LoginPage';
import { AccessDenied, NotFoundPage } from './pages/SimplePages';
import { adminRoutes } from './pages/admin/AdminRoutes';
import { LegacyFhirRedirect } from './pages/fhir/FhirLayout';
import { AccountPage, CatalogPage, NoProjectPage, ProjectSelectPage } from './pages/global/GlobalPages';
import { HomePage } from './pages/home/HomePage';
import { dataRoutes } from './pages/data/routes';
import { labelingRoutes } from './pages/labeling/routes';
import { trainingRoutes } from './pages/training/routes';
import { modelRoutes } from './pages/models/routes';
import { llmRoutes } from './pages/llm/routes';

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
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
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

/** 研究區頁面需要先選專案：沒有任何專案顯示說明頁，有專案但沒選就到「選擇專案」 */
function RequireProject({ children }: { children: ReactNode }) {
  const { me, project } = useSession();
  const location = useLocation();
  if (!project) {
    if (me!.projects.length === 0) return <NoProjectPage />;
    return <Navigate to="/projects" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/**
 * 直接輸入網址也要擋：規則與側欄、功能目錄共用 access/entries.ts 的 checkAccess。
 * Admin 區以外都先要求選專案。
 */
function AreaGuard({ area }: { area: keyof typeof AREAS }) {
  const { me, project } = useSession();
  const target = AREAS[area];
  if (target.rule.kind === 'admin') {
    const result = checkAccess(target, me!, project);
    return result.allowed ? <Outlet /> : <AccessDenied reason={result.reason} />;
  }
  return (
    <RequireProject>
      <AreaCheck area={area} />
    </RequireProject>
  );
}

function AreaCheck({ area }: { area: keyof typeof AREAS }) {
  const { me, project } = useSession();
  const result = checkAccess(AREAS[area], me!, project);
  if (!result.allowed) return <AccessDenied reason={result.reason} />;
  return <Outlet />;
}

/** 專案首頁：Admin 還沒選過專案就進管理區（03 規格第一節 Admin） */
function HomeRoute() {
  const { me, projectChosen } = useSession();
  if (me!.account_type === 'admin' && !projectChosen) return <Navigate to="/admin" replace />;
  return (
    <RequireProject>
      <HomePage />
    </RequireProject>
  );
}

/** 契約入口轉到新位置，保留 query（例：/inference?x=1） */
function Redirect({ to }: { to: string }) {
  const location = useLocation();
  const extra = location.search.replace(/^\?/, '');
  const target = extra ? `${to}${to.includes('?') ? '&' : '?'}${extra}` : to;
  return <Navigate to={target} replace />;
}

export function App({ auth, apiBase }: { auth: AuthAdapter; apiBase: string }) {
  return (
    <SessionProvider auth={auth} apiBase={apiBase}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<CallbackPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomeRoute />} />
            <Route path="projects" element={<ProjectSelectPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="catalog" element={<CatalogPage />} />

            {/* 研究區（各區 routes 由 B、C 提供，路徑相對於區根） */}
            <Route path="data/*" element={<AreaGuard area="data" />}>
              {dataRoutes()}
            </Route>
            <Route path="labeling/*" element={<AreaGuard area="labeling" />}>
              {labelingRoutes()}
            </Route>
            <Route path="training/*" element={<AreaGuard area="training" />}>
              {trainingRoutes()}
            </Route>
            <Route path="models/*" element={<AreaGuard area="models" />}>
              {modelRoutes()}
            </Route>
            <Route path="llm/*" element={<AreaGuard area="llm" />}>
              {llmRoutes()}
            </Route>

            {/* 契約 8 入口中路徑改變的幾個：先檢查權限，再轉到新位置 */}
            <Route path="auto-labeling/*" element={<AreaGuard area="labeling" />}>
              <Route path="*" element={<Navigate to="/labeling/auto" replace />} />
            </Route>
            <Route path="deployment/*" element={<AreaGuard area="models" />}>
              <Route path="*" element={<Redirect to="/models?entry=deployment" />} />
            </Route>
            <Route path="inference/*" element={<AreaGuard area="models" />}>
              <Route path="*" element={<Redirect to="/models?entry=inference" />} />
            </Route>

            {/* 管理區（只有 Admin） */}
            <Route path="admin/*" element={<AreaGuard area="admin" />}>
              {adminRoutes()}
            </Route>
            <Route path="fhir/*" element={<AreaGuard area="admin" />}>
              <Route path="*" element={<LegacyFhirRedirect />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </SessionProvider>
  );
}
