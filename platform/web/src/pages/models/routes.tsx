import { Navigate, Route } from 'react-router-dom';
import { ModelListPage, ModelPage } from './ModelsPage';

/** /models/* 底下的子路由（相對路徑）；入口權限（Prediction）由 App.tsx 檢查。 */
export function modelRoutes() {
  return (
    <>
      <Route index element={<ModelListPage />} />
      <Route path=":runId" element={<Navigate to="result" replace />} />
      <Route path=":runId/result" element={<ModelPage tab="result" />} />
      <Route path=":runId/predict" element={<ModelPage tab="predict" />} />
      <Route path=":runId/history" element={<ModelPage tab="history" />} />
      <Route path=":runId/share" element={<ModelPage tab="share" />} />
      <Route path=":runId/download" element={<ModelPage tab="download" />} />
    </>
  );
}
