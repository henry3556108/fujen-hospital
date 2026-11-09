import { Navigate, Route } from 'react-router-dom';
import { NewTrainingPage } from './NewTrainingPage';
import { SettingsPage, TrainingLayout } from './TrainingPage';
import { CodePage, RunPage, TrainingHome } from './TrainingPages';

/** /training/* 底下的子路由（相對路徑）；入口權限由 App.tsx 的守門檢查。建立訓練任務精靈不在分頁列。 */
export function trainingRoutes() {
  return (
    <>
      <Route path="new" element={<NewTrainingPage />} />
      <Route element={<TrainingLayout />}>
        <Route index element={<TrainingHome />} />
        <Route path="runs/:runId" element={<RunPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="code" element={<CodePage />} />
      </Route>
      <Route path="jobs" element={<Navigate to="/training" replace />} />
    </>
  );
}
