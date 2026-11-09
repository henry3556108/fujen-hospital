import type { ReactNode } from 'react';
import { Navigate, Route } from 'react-router-dom';
import { PageHeader, SplitLayout, Tabs } from '../../components/ui';
import { NotFoundPage } from '../SimplePages';
import { ClusterNodesPage } from './ClusterNodesPage';
import { GpuDashboardPage } from './GpuDashboardPage';
import { GpuGroupsPage } from './GpuGroupsPage';
import { JobsPage } from './JobsPage';
import { QueueOrderPage } from './QueueOrderPage';
import { SharedSchedulingPage } from './SharedSchedulingPage';
import '../../styles/pages.css';
import './scheduling.css';

// 管理區「運算資源」（03 規格第二節）：GPU Dashboard 為第一頁。
// 分頁名稱沿用（驗收腳本以名稱點分頁）；版型照設計稿 B21／B22。
const TABS = [
  { to: '/admin/compute/gpu', label: 'GPU Dashboard' },
  { to: '/admin/compute/queues', label: '佇列排程' },
  { to: '/admin/compute/shared', label: '共享排程設定' },
  { to: '/admin/compute/groups', label: 'GPU 群組' },
  { to: '/admin/compute/nodes', label: '節點' },
  { to: '/admin/compute/jobs', label: '測試工作' },
];

/**
 * 運算資源各頁共用的版頭：頁面標題、副標、右上動作＋分頁；side 給右側設定欄（B21 建立群組、B22 共享排程設定）。
 * tabs=false 給系統監控用（它在管理區自成一項）。
 */
export function SchedulingPage({
  title,
  subtitle,
  actions,
  side,
  children,
  tabs = true,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  side?: ReactNode;
  children: ReactNode;
  tabs?: boolean;
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions}>
        {tabs && <Tabs label="GPU／CPU 伺服器管理分頁" items={TABS} />}
      </PageHeader>
      <SplitLayout side={side}>{children}</SplitLayout>
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
