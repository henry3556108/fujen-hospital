import { Navigate, Outlet, Route } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
import { AllowlistPage } from '../imaging/AllowlistPage';
import { FilesPage } from '../imaging/FilesPage';
import { ImportJobsPage } from '../imaging/ImportJobsPage';
import { ImportPage } from '../imaging/ImportPage';
import { PacsPage } from '../imaging/PacsPage';
import { StudiesPage } from '../imaging/StudiesPage';
import { StudyDetailPage } from '../imaging/StudyDetailPage';
import { NotFoundPage } from '../SimplePages';
import { DatasetLayout } from '../tabular/DatasetLayout';
import { DatasetsPage } from '../tabular/DatasetsPage';
import { PrepareTab } from '../tabular/PrepareTab';
import { StatsTab } from '../tabular/StatsTab';
import { ViewTab } from '../tabular/ViewTab';
import '../../styles/pages.css';

/** 研究資料區外框：沒有專案時提示，切換專案時整區重新載入。 */
function DataLayout() {
  const { project } = useSession();
  if (!project) return <Alert tone="info">目前沒有專案。請先選擇或建立專案。</Alert>;
  return (
    <div key={project.id}>
      <h1>研究資料</h1>
      <p className="text-muted">
        目前專案：<strong>{project.name}</strong>。資料只在這個專案內可見。
      </p>
      <Tabs
        label="研究資料分頁"
        items={[
          { to: '/data/imaging', label: '影像' },
          { to: '/data/tabular', label: '表格資料' },
        ]}
      />
      <Outlet />
    </div>
  );
}

/** 研究資料（/data/*）的子路由，路徑相對於 /data。 */
export function dataRoutes() {
  return (
    <Route element={<DataLayout />}>
      <Route index element={<Navigate to="imaging" replace />} />
      <Route path="imaging" element={<StudiesPage />} />
      <Route path="imaging/studies/:studyUid" element={<StudyDetailPage />} />
      <Route path="imaging/import" element={<ImportPage />} />
      <Route path="imaging/jobs" element={<ImportJobsPage />} />
      <Route path="imaging/jobs/:jobId" element={<ImportJobsPage />} />
      <Route path="imaging/allowlist" element={<AllowlistPage />} />
      <Route path="imaging/pacs" element={<PacsPage />} />
      <Route path="imaging/files" element={<FilesPage />} />
      <Route path="tabular" element={<DatasetsPage />} />
      <Route path="tabular/:datasetId" element={<DatasetLayout />}>
        <Route index element={<Navigate to="view" replace />} />
        <Route path="view" element={<ViewTab />} />
        <Route path="prepare" element={<PrepareTab />} />
        <Route path="stats" element={<StatsTab />} />
        {/* 舊網址轉到新分頁 */}
        <Route path="describe" element={<Navigate to="../view?show=describe" replace />} />
        <Route path="preview" element={<Navigate to="../view" replace />} />
        <Route path="correlation" element={<Navigate to="../view?show=correlation" replace />} />
        <Route path="target" element={<Navigate to="../prepare" replace />} />
        <Route path="preprocess" element={<Navigate to="../prepare" replace />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  );
}
