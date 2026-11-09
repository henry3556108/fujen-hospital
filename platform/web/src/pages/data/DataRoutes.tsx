import { Link, Route, Routes } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
import { ImagingRoutes } from '../imaging/ImagingRoutes';
import { NotFoundPage } from '../SimplePages';
import { TabularRoutes } from '../tabular/TabularRoutes';
import '../../styles/pages.css';

const TABS = [
  { to: '/data/imaging', label: '醫療影像' },
  { to: '/data/tabular', label: '結構式資料（CSV 表格）' },
];

/** 進入「數據管理」先選資料種類，不必猜 CSV 在哪個分頁。 */
function DataLanding() {
  return (
    <section aria-labelledby="data-choose">
      <h2 id="data-choose">要處理哪一種資料？</h2>
      <ul className="entry-grid" aria-label="資料種類">
        <li>
          <Link to="/data/tabular" className="card entry-card">
            <span className="entry-card__title">結構式資料：上傳 CSV</span>
            <span className="entry-card__desc">結構式資料，例如從病歷或 Excel 匯出的檢驗值、生命徵象、診斷。上傳後可看統計、設定預測目標。</span>
          </Link>
        </li>
        <li>
          <Link to="/data/imaging" className="card entry-card">
            <span className="entry-card__title">醫療影像</span>
            <span className="entry-card__desc">DICOM、NIfTI 等影像檔，或從 PACS 取像；可篩選研究、交給影像標註。</span>
          </Link>
        </li>
      </ul>
    </section>
  );
}

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
            <Route index element={<DataLanding />} />
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
