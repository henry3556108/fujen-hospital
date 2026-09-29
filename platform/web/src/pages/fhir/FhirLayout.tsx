import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { AlertsPage } from './AlertsPage';
import { GatewayRoutesPage } from './GatewayRoutesPage';
import { GraphPage } from './GraphPage';
import { ResourcesPage } from './ResourcesPage';
import { SchedulesPage } from './SchedulesPage';
import { SourcesPage } from './SourcesPage';
import './fhir.css';

const TABS = [
  ['resources', '資源'],
  ['sources', '來源與對應'],
  ['schedules', '排程'],
  ['graph', '關聯圖'],
  ['alerts', '流量告警'],
  ['gateway', 'Gateway 路由'],
] as const;

/** 需要選定專案（＝FHIR 租戶）的分頁 */
function RequireProject() {
  const { project } = useSession();
  if (!project) return <Alert tone="info">請先在上方選擇專案。每個專案是一個獨立的 FHIR 租戶。</Alert>;
  return <Outlet />;
}

function FhirLayout() {
  const { project } = useSession();
  return (
    <>
      <h1>醫療資料交換（FHIR）</h1>
      <p className="text-muted">
        模組代碼：C-03。目前租戶：<strong>{project ? `${project.name}（專案 ${project.id}）` : '未選擇'}</strong>
        。外部系統經 Gateway 的 <span className="fhir-code">/fhir/projects/{project?.id ?? '{專案}'}/</span> 存取。
      </p>
      <nav aria-label="FHIR 分頁" className="tabs">
        {TABS.map(([path, label]) => (
          <NavLink key={path} to={`/fhir/${path}`} className="tabs__item">
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

/** /fhir/* 的子路由；外層由 App.tsx 以 Admin 入口規則守門。 */
export function FhirRoutes() {
  return (
    <Routes>
      <Route element={<FhirLayout />}>
        <Route index element={<Navigate to="/fhir/resources" replace />} />
        <Route path="gateway" element={<GatewayRoutesPage />} />
        <Route element={<RequireProject />}>
          <Route path="resources" element={<ResourcesPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="graph" element={<GraphPage />} />
          <Route path="alerts" element={<AlertsPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
