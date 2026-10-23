import type { ReactNode } from 'react';
import { Navigate, Route } from 'react-router-dom';
import { Tabs } from '../../components/Tabs';
import { NotFoundPage } from '../SimplePages';
import { ClusterNodesPage } from './ClusterNodesPage';
import { GpuDashboardPage } from './GpuDashboardPage';
import { GpuGroupsPage } from './GpuGroupsPage';
import { JobsPage } from './JobsPage';
import { QueueOrderPage } from './QueueOrderPage';
import { SharedSchedulingPage } from './SharedSchedulingPage';
import '../../styles/pages.css';

// 管理區「運算資源」（03 規格第二節）：GPU 使用對照為第一頁。
const TABS = [
  { to: '/admin/compute/gpu', label: 'GPU 使用對照' },
  { to: '/admin/compute/queues', label: '排隊順序' },
  { to: '/admin/compute/shared', label: '共享設定' },
  { to: '/admin/compute/groups', label: 'GPU 群組' },
  { to: '/admin/compute/nodes', label: '節點' },
  { to: '/admin/compute/jobs', label: '測試工作' },
];

/** 運算資源各頁共用的版頭：頁面標題＋分頁。tabs=false 給系統監控用（它在管理區自成一項）。 */
export function SchedulingPage({ title, children, tabs = true }: { title: string; children: ReactNode; tabs?: boolean }) {
  return (
    <>
      <h1>{title}</h1>
      {tabs && <Tabs label="運算資源分頁" items={TABS} />}
      {children}
    </>
  );
}

/** /admin/compute/* 的子路由（相對路徑）；Admin 守門在 App.tsx。 */
export function computeRoutes() {
  return (
    <>
      <Route index element={<Navigate to="gpu" replace />} />
      <Route path="gpu" element={<GpuDashboardPage />} />
      <Route path="queues" element={<QueueOrderPage />} />
      <Route path="shared" element={<SharedSchedulingPage />} />
      <Route path="groups" element={<GpuGroupsPage />} />
      <Route path="nodes" element={<ClusterNodesPage />} />
      {/* 原「專案工作」：送出示範工作看排程（研究者的訓練紀錄不再列出這些工作） */}
      <Route path="jobs" element={<JobsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </>
  );
}

/** 舊網址 /admin/scheduling/* → 新位置 */
export function legacySchedulingRoutes() {
  return (
    <>
      <Route index element={<Navigate to="/admin/compute/shared" replace />} />
      <Route path="groups" element={<Navigate to="/admin/compute/groups" replace />} />
      <Route path="queues" element={<Navigate to="/admin/compute/queues" replace />} />
      <Route path="nodes" element={<Navigate to="/admin/compute/nodes" replace />} />
      <Route path="gpu-dashboard" element={<Navigate to="/admin/compute/gpu" replace />} />
      <Route path="monitoring" element={<Navigate to="/admin/monitoring" replace />} />
      <Route path="*" element={<Navigate to="/admin/compute" replace />} />
    </>
  );
}
