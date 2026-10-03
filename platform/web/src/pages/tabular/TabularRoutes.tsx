import { Navigate, Route, Routes } from 'react-router-dom';
import { NotFoundPage } from '../SimplePages';
import { CorrelationTab } from './CorrelationTab';
import { DatasetLayout } from './DatasetLayout';
import { DatasetsPage } from './DatasetsPage';
import { DescribeTab } from './DescribeTab';
import { PreprocessTab } from './PreprocessTab';
import { PreviewTab } from './PreviewTab';
import { StatsTab } from './StatsTab';
import { TargetFeatureTab } from './TargetFeatureTab';

/** 掛在 /data/tabular/*。 */
export function TabularRoutes() {
  return (
    <Routes>
      <Route index element={<DatasetsPage />} />
      <Route path=":datasetId" element={<DatasetLayout />}>
        {/* 開啟資料集先看描述統計（每欄的平均、範圍與分布），逐列的原始資料在「預覽」 */}
        <Route index element={<Navigate to="describe" replace />} />
        <Route path="describe" element={<DescribeTab />} />
        <Route path="preview" element={<PreviewTab />} />
        <Route path="target" element={<TargetFeatureTab />} />
        <Route path="preprocess" element={<PreprocessTab />} />
        <Route path="correlation" element={<CorrelationTab />} />
        <Route path="stats" element={<StatsTab />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
