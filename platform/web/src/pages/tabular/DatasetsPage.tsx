import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { useProjectAccess } from '../data/access';
import { ReportView } from './ReportView';
import type { Dataset, UploadResult, ValidationReport } from './types';
import { UploadForm } from './UploadForm';

/** TC-B01-10 資料集列表、CSV 上傳與驗證報告。 */
export function DatasetsPage() {
  const { api, project } = useSession();
  const { can, missing } = useProjectAccess();
  // 建立、刪除資料集需要 Training 權限（與後端一致）
  const writable = can('training');
  const base = `/api/projects/${project!.id}/tabular/datasets`;
  const datasets = useResource(() => api.get<Dataset[]>(base), [project!.id]);
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);
  const [report, setReport] = useState<{ dataset: Dataset; report: ValidationReport } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<Dataset | null>(null);
  const [busy, setBusy] = useState(false);

  async function showReport(d: Dataset) {
    setError(null);
    setUploaded(null);
    try {
      setReport({ dataset: d, report: await api.get<ValidationReport>(`${base}/${d.id}/report`) });
    } catch (e) {
      setError(e);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${base}/${deleting.id}`);
      setNotice(`已刪除資料集「${deleting.name}」`);
      setUploaded(null);
      setReport(null);
      datasets.reload();
    } catch (e) {
      setError(e);
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return (
    <>
      <h2>表格資料</h2>
      <div className="row-actions">
        <p className="text-muted">表格資料（CSV），例如從病歷或 Excel 匯出的檢驗值、診斷。上傳後可查看資料、選想預測的欄位並整理，再用來建立模型。</p>
        {writable && (
          // 跳到下方上傳表單；主要按鈕是表單裡的「上傳並驗證」（03 規格 4.1）
          <a className="btn btn--secondary" href="#upload-csv">
            上傳 CSV
          </a>
        )}
      </div>
      {!writable && <Alert tone="info">{missing('training', '上傳或刪除資料集')}可以查看資料與做統計分析。</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={datasets.error} />
      <div className="table-wrap">
        <table aria-label="資料集列表">
          <thead>
            <tr>
              <th scope="col">資料集</th>
              <th scope="col">原始檔名</th>
              <th scope="col" className="num">
                總列數
              </th>
              <th scope="col" className="num">
                有效列
              </th>
              <th scope="col" className="num">
                拒絕列
              </th>
              <th scope="col">上傳者</th>
              <th scope="col">上傳時間</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {datasets.loading && !datasets.data && (
              <tr>
                <td colSpan={8} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {datasets.data?.map((d) => (
              <tr key={d.id}>
                <th scope="row">
                  <Link to={`/data/tabular/${d.id}`}>{d.name}</Link>
                </th>
                <td className="mono">{d.original_filename}</td>
                <td className="num">{d.total_rows}</td>
                <td className="num">{d.valid_rows}</td>
                <td className="num">{d.rejected_rows}</td>
                <td>{d.created_by}</td>
                <td>{formatTime(d.created_at)}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="btn btn--secondary btn--small" aria-label={`驗證報告 ${d.name}`} onClick={() => void showReport(d)}>
                      驗證報告
                    </button>
                    {writable && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--small"
                        aria-label={`刪除 ${d.name}`}
                        onClick={() => {
                          setNotice(null);
                          setDeleting(d);
                        }}
                      >
                        刪除
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {datasets.data?.length === 0 && (
              <tr>
                <td colSpan={8}>這個專案還沒有資料集</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {report && <ReportView report={report.report} title={`「${report.dataset.name}」的驗證報告`} />}

      {writable && (
        <UploadForm
          datasets={datasets.data ?? []}
          onUploaded={(r, replaced) => {
            setUploaded(r);
            setReport(null);
            setNotice(replaced ? `已取代資料集「${r.dataset.name}」` : `已建立資料集「${r.dataset.name}」`);
            datasets.reload();
          }}
        />
      )}
      {uploaded && (
        <>
          <ReportView report={uploaded.report} title={`「${uploaded.dataset.name}」的上傳結果`} />
          <p className="row-actions">
            <Link to={`/data/tabular/${uploaded.dataset.id}/view`}>開啟資料集「{uploaded.dataset.name}」</Link>
            <Link to={`/data/tabular/${uploaded.dataset.id}/prepare`}>下一步：整理資料</Link>
          </p>
        </>
      )}

      {deleting && (
        <ConfirmDialog
          title="刪除資料集"
          confirmLabel="確認刪除"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>
            確定要刪除資料集「<strong>{deleting.name}</strong>」嗎？檔案與整理設定會一併刪除，此動作無法復原。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
