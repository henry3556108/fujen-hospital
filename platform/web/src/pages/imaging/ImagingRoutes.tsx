import { Route, Routes } from 'react-router-dom';
import { Tabs } from '../../components/Tabs';
import { NotFoundPage } from '../SimplePages';
import { AllowlistPage } from './AllowlistPage';
import { FilesPage } from './FilesPage';
import { ImportJobsPage } from './ImportJobsPage';
import { ImportPage } from './ImportPage';
import { PacsPage } from './PacsPage';
import { StudiesPage } from './StudiesPage';
import { StudyDetailPage } from './StudyDetailPage';

const TABS = [
  { to: '/data/imaging', label: '研究列表', end: true },
  { to: '/data/imaging/import', label: '匯入影像' },
  { to: '/data/imaging/jobs', label: '匯入工作' },
  { to: '/data/imaging/files', label: '檔案與配對' },
  { to: '/data/imaging/allowlist', label: 'Accession 清單' },
  { to: '/data/imaging/pacs', label: 'PACS 查詢取像' },
];

export function ImagingRoutes() {
  return (
    <>
      <Tabs label="醫療影像分頁" items={TABS} />
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
    </>
  );
}
