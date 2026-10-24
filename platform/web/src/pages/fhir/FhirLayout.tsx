import { NavLink, Navigate, Outlet, Route, useLocation, useParams } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { ProjectPicker } from '../../components/ProjectPicker';
import { Alert, Badge, PageHeader } from '../../components/ui';
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

/** 各分頁的標題與副標（設計稿 B24～B28） */
const HEADS: Record<string, { title: string; subtitle: string }> = {
  resources: { title: '醫療資料交換', subtitle: '瀏覽 FHIR 資源並檢視病人關聯' },
  sources: { title: 'FHIR 來源與對應', subtitle: '設定資料來源並對應至 FHIR 資料結構' },
  schedules: { title: 'FHIR 轉換排程', subtitle: '設定定期轉換任務，自動匯入並轉換為 FHIR 資料' },
  graph: { title: 'FHIR 關聯圖', subtitle: '以病歷號查看病人與就醫、觀察值的參照關係' },
  alerts: { title: 'FHIR 流量告警', subtitle: '監控 FHIR 介面的使用流量，請求數超過門檻時發出通知' },
  gateway: { title: 'Gateway 路由與流量門檻', subtitle: '設定各 API 路由的上游服務與每人每分鐘請求門檻' },
};

/** 需要選定專案（＝FHIR 租戶）的分頁 */
function RequireProject() {
  const { project } = useSession();
  if (!project) return <Alert tone="info">請先在上方選擇租戶專案。每個專案是一個獨立的 FHIR 租戶。</Alert>;
  return <Outlet />;
}

function FhirLayout() {
  const { project } = useSession();
  const tab = useLocation().pathname.split('/')[3] ?? 'resources';
  const head = HEADS[tab] ?? HEADS.resources;
  const global = tab === 'gateway';
  return (
    <>
      <PageHeader
        title={head.title}
        subtitle={head.subtitle}
        actions={
          global ? (
            <Badge tone="info">全平台設定</Badge>
          ) : (
            <div className="fhir-head-actions">
              <ProjectPicker id="fhir-tenant" label="租戶專案" />
              <span className="fhir-source">
                資料來源 <Badge tone="info">FHIR R4</Badge>
              </span>
            </div>
          )
        }
      >
        <nav aria-label="FHIR 分頁" className="tabs">
          {TABS.map(([path, label]) => (
            <NavLink key={path} to={`/admin/fhir/${path}`} className="tabs__item">
              {label}
            </NavLink>
          ))}
        </nav>
      </PageHeader>
      {global ? (
        <p className="text-muted fhir-scope">全平台設定：影響所有專案，和各專案的資料交換分開。不需選專案。</p>
      ) : (
        <p className="text-muted fhir-scope">
          模組代碼：C-03。目前租戶：<strong>{project ? `${project.name}（專案 ${project.id}）` : '未選擇'}</strong>
          。外部系統經 Gateway 的 <span className="fhir-code">/fhir/projects/{project?.id ?? '{專案}'}/</span> 存取；切換專案後不保留其他專案的病人資料。
        </p>
      )}
      <Outlet />
    </>
  );
}

/** /admin/fhir/* 的子路由（相對路徑）；外層由 App.tsx 以 Admin 規則守門。 */
export function fhirRoutes() {
  return (
    <Route element={<FhirLayout />}>
      <Route index element={<Navigate to="/admin/fhir/resources" replace />} />
      <Route path="gateway" element={<GatewayRoutesPage />} />
      <Route element={<RequireProject />}>
        <Route path="resources" element={<ResourcesPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="alerts" element={<AlertsPage />} />
      </Route>
    </Route>
  );
}

/** 舊網址 /fhir/* → /admin/fhir/* */
export function LegacyFhirRedirect() {
  const rest = useParams()['*'] ?? '';
  return <Navigate to={`/admin/fhir${rest ? `/${rest}` : ''}`} replace />;
}
