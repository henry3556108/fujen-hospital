import { Route, Routes } from 'react-router-dom';
import { NotFoundPage } from '../SimplePages';
import { AllowlistPage } from './AllowlistPage';
import { FilesPage } from './FilesPage';
import { ImportJobsPage } from './ImportJobsPage';
import { ImportPage } from './ImportPage';
import { PacsPage } from './PacsPage';
import { StudiesPage } from './StudiesPage';
import { StudyDetailPage } from './StudyDetailPage';

/** 舊的 /data/imaging/* 掛法（新版改由 pages/data/routes.tsx 掛）；頁內分頁由各頁的 ImagingNav 提供。 */
export function ImagingRoutes() {
  return (
    <Routes>
      <Route index element={<StudiesPage />} />
      <Route path="studies/:studyUid" element={<StudyDetailPage />} />
      <Route path="import" element={<ImportPage />} />
      <Route path="jobs" element={<ImportJobsPage />} />
      <Route path="jobs/:jobId" element={<ImportJobsPage />} />
      <Route path="files" element={<FilesPage />} />
      <Route path="allowlist" element={<AllowlistPage />} />
      <Route path="pacs" element={<PacsPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
