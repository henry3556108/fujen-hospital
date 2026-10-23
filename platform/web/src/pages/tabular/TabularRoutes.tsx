import { Navigate, Route, Routes } from 'react-router-dom';
import { NotFoundPage } from '../SimplePages';
import { DatasetLayout } from './DatasetLayout';
import { DatasetsPage } from './DatasetsPage';
import { PrepareTab } from './PrepareTab';
import { StatsTab } from './StatsTab';
import { ViewTab } from './ViewTab';

/** 掛在 /data/tabular/*（舊外框用；新外框由 pages/data/routes.tsx 掛同樣的分頁）。 */
export function TabularRoutes() {
  return (
    <Routes>
      <Route index element={<DatasetsPage />} />
      <Route path=":datasetId" element={<DatasetLayout />}>
        <Route index element={<Navigate to="view" replace />} />
        <Route path="view" element={<ViewTab />} />
        <Route path="prepare" element={<PrepareTab />} />
        <Route path="stats" element={<StatsTab />} />
        {/* 舊網址轉到新分頁 */}
        <Route path="preview" element={<Navigate to="../view" replace />} />
        <Route path="describe" element={<Navigate to="../view?show=describe" replace />} />
        <Route path="correlation" element={<Navigate to="../view?show=correlation" replace />} />
        <Route path="target" element={<Navigate to="../prepare" replace />} />
        <Route path="preprocess" element={<Navigate to="../prepare" replace />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
