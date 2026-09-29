import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
import { ImagingRoutes } from '../imaging/ImagingRoutes';
import { NotFoundPage } from '../SimplePages';
import { TabularRoutes } from '../tabular/TabularRoutes';
import '../../styles/pages.css';

const TABS = [
  { to: '/data/imaging', label: '醫療影像' },
  { to: '/data/tabular', label: '結構式資料' },
];

/** 「數據管理」入口（B-01、B-04）：掛在 /data/*，需要目前專案的 Project 權限（App.tsx 的 EntryGuard）。 */
export function DataRoutes() {
  const { project } = useSession();
  return (
    <>
      <h1>數據管理</h1>
      {project ? (
        <>
          <p className="text-muted">
            目前專案：<strong>{project.name}</strong>。資料只在這個專案內可見。
          </p>
          <Tabs label="數據管理分頁" items={TABS} />
          <Routes>
            <Route index element={<Navigate to="/data/imaging" replace />} />
            <Route path="imaging/*" element={<ImagingRoutes key={project.id} />} />
            <Route path="tabular/*" element={<TabularRoutes key={project.id} />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </>
      ) : (
        <Alert tone="info">目前沒有專案。請先到「帳號管理」建立專案。</Alert>
      )}
    </>
  );
}
