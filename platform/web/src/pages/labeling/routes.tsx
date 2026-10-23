import { Route } from 'react-router-dom';
import { NotFoundPage } from '../SimplePages';
import { AutoLabelPage } from './AutoLabelPage';
import { LabelDatasetPage, LabelDatasetsPage } from './DatasetsPage';
import { LabelingPage } from './LabelingPage';
import { WorkbenchPage } from './WorkbenchPage';

/** 影像標註（/labeling/*）的子路由，路徑相對於 /labeling。 */
export function labelingRoutes() {
  return (
    <>
      <Route index element={<LabelingPage />} />
      <Route path="datasets" element={<LabelDatasetsPage />} />
      <Route path="datasets/:datasetId" element={<LabelDatasetPage />} />
      <Route path="auto" element={<AutoLabelPage />} />
      <Route path="studies/:studyUid" element={<WorkbenchPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </>
  );
}
