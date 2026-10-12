import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Tabs } from '../../components/Tabs';
import { NotFoundPage } from '../SimplePages';
import { ClusterNodesPage } from './ClusterNodesPage';
import { GpuDashboardPage } from './GpuDashboardPage';
import { GpuGroupsPage } from './GpuGroupsPage';
import { MonitoringPage } from './MonitoringPage';
import { QueueOrderPage } from './QueueOrderPage';
import { SharedSchedulingPage } from './SharedSchedulingPage';
import '../../styles/pages.css';

const TABS = [
  { to: '/admin/scheduling', label: '共享排程設定', end: true },
  { to: '/admin/scheduling/groups', label: 'GPU 群組' },
  { to: '/admin/scheduling/queues', label: '佇列順序' },
  { to: '/admin/scheduling/nodes', label: '叢集節點' },
  { to: '/admin/scheduling/gpu-dashboard', label: 'GPU Dashboard' },
  { to: '/admin/scheduling/monitoring', label: '監控儀表板' },
];

/** 排程與叢集各頁共用的版頭：頁面標題＋分頁。 */
export function SchedulingPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <Tabs label="排程與叢集分頁" items={TABS} />
      {children}
    </>
  );
}

/** 掛在 /admin/scheduling/*（只有 Admin 能進入，由 App.tsx 的 EntryGuard 把關）。 */
export function SchedulingRoutes() {
  return (
    <Routes>
      <Route index element={<SharedSchedulingPage />} />
      <Route path="groups" element={<GpuGroupsPage />} />
      <Route path="queues" element={<QueueOrderPage />} />
      <Route path="nodes" element={<ClusterNodesPage />} />
      <Route path="gpu-dashboard" element={<GpuDashboardPage />} />
      <Route path="monitoring" element={<MonitoringPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
