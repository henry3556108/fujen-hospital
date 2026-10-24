import { Navigate, Outlet, Route } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
import { PageHeader } from '../../components/ui';
import { AllowlistPage } from '../imaging/AllowlistPage';
import { FilesPage } from '../imaging/FilesPage';
import { ImportJobsPage } from '../imaging/ImportJobsPage';
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
import './data.css';

/** 研究資料區外框（A02）：頁標題＋影像／表格分頁；沒有專案時提示，切換專案時整區重新載入。 */
function DataLayout() {
  const { project } = useSession();
  if (!project) return <Alert tone="info">目前沒有專案。請先選擇或建立專案。</Alert>;
  return (
    <div key={project.id}>
      <PageHeader
        title="研究資料"
        subtitle={
          <>
            目前專案：<strong>{project.name}</strong>。資料只在這個專案內可見。
          </>
        }
      >
        <Tabs
          label="研究資料分頁"
          items={[
            { to: '/data/imaging', label: '影像' },
            { to: '/data/tabular', label: '表格資料' },
          ]}
        />
      </PageHeader>
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
      {/* 加入資料：影像清單上的滑出面板（A02），網址保留 /imaging/import，可直接連結 */}
      <Route path="imaging/import" element={<StudiesPage adding />} />
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
