import { Navigate, Outlet, Route } from 'react-router-dom';
import { Tabs } from '../../components/Tabs';
import { fhirRoutes } from '../fhir/FhirLayout';
import { LlmApprovalsPanel } from '../llm/routes';
import { MonitoringPage } from '../scheduling/MonitoringPage';
import { computeRoutes, legacySchedulingRoutes } from '../scheduling/SchedulingRoutes';
import { NotFoundPage } from '../SimplePages';
import { AuditPage } from './AuditPage';
import { DashboardPage } from './DashboardPage';
import { projectDetailRoutes } from './ProjectDetailPage';
import { ProjectsPage } from './ProjectsPage';
import { UsersPage } from './UsersPage';

/** 稽核與審核：稽核紀錄／模型下載審核 */
function ReviewLayout() {
  return (
    <>
      <h1>稽核與審核</h1>
      <Tabs
        label="稽核與審核分頁"
        items={[
          { to: '/admin/audit', label: '稽核紀錄' },
          { to: '/admin/approvals', label: '模型下載審核' },
        ]}
      />
      <Outlet />
    </>
  );
}

/** 管理區 /admin/* 的子路由（相對路徑）；Admin 守門在 App.tsx。 */
export function adminRoutes() {
  return (
    <>
      <Route index element={<DashboardPage />} />
      <Route path="users" element={<UsersPage />} />
      <Route path="projects" element={<ProjectsPage />} />
      <Route path="projects/:projectId">{projectDetailRoutes()}</Route>
      <Route path="compute">{computeRoutes()}</Route>
      <Route path="monitoring" element={<MonitoringPage />} />
      <Route path="fhir">{fhirRoutes()}</Route>
      <Route element={<ReviewLayout />}>
        <Route path="audit" element={<AuditPage />} />
        <Route path="approvals" element={<LlmApprovalsPanel />} />
      </Route>
      {/* 舊網址轉到新位置 */}
      <Route path="dashboard" element={<Navigate to="/admin" replace />} />
      <Route path="members" element={<Navigate to="/admin/projects" replace />} />
      <Route path="labeling-groups" element={<Navigate to="/admin/projects" replace />} />
      <Route path="scheduling">{legacySchedulingRoutes()}</Route>
      <Route path="*" element={<NotFoundPage />} />
    </>
  );
}
