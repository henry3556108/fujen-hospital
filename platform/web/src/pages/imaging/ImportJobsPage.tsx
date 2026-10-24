import { Link, useParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { useProjectAccess } from '../data/access';
import { ImagingNav } from './ImagingNav';
import { countsText, IMPORT_TONE, ImportResult, RETRY_SOURCE } from './ImportResult';
import { IMPORT_KIND_LABELS, IMPORT_STATUS_LABELS, type ImportJob } from './types';

/** 匯入結果（B05）：一次匯入的摘要與逐檔原因；檔案已不在瀏覽器裡，「重新上傳」開加入資料重新選檔。 */
function JobDetail({ jobId }: { jobId: string }) {
  const { api, project } = useSession();
  const { can } = useProjectAccess();
  const job = useResource(() => api.get<ImportJob>(`/api/projects/${project!.id}/imaging/jobs/${jobId}`), [project!.id, jobId]);
  const j = job.data;
  return (
    <>
      <p className="rd-crumbs">
        <Link to="/data/imaging/jobs">
          <Icon name="chevron-left" /> 回匯入紀錄
        </Link>
      </p>
      <div className="rd-section-head">
        <div>
          <h2>匯入結果</h2>
          <p className="text-muted">這次影像匯入的結果與逐檔原因：哪些新增、哪些重複略過、哪些需要重新上傳。</p>
        </div>
      </div>
      <ApiErrorAlert error={job.error} />
      {job.loading && !j && <p role="status">載入中…</p>}
      {j && !job.error && (
        <ImportResult
          job={j}
          title={`匯入工作 ${j.id}`}
          retryHref={can('labeling') ? `/data/imaging/import${RETRY_SOURCE[j.kind] === 'upload' ? '' : `?source=${RETRY_SOURCE[j.kind]}`}` : undefined}
          actions={
            <Link to="/data/imaging" className="btn btn--primary">
              查看匯入的影像 <Icon name="arrow" />
            </Link>
          }
        />
      )}
    </>
  );
}

/** 匯入紀錄：每次匯入的結果（含院內影像系統取像）；點「逐檔結果」看單次匯入結果頁。 */
export function ImportJobsPage() {
  const { api, project } = useSession();
  const { jobId } = useParams();
  const jobs = useResource(() => api.get<ImportJob[]>(`/api/projects/${project!.id}/imaging/jobs`), [project!.id]);

  if (jobId) {
    return (
      <>
        <ImagingNav />
        <JobDetail key={jobId} jobId={jobId} />
      </>
    );
  }

  return (
    <>
      <ImagingNav />
      <div className="rd-section-head">
        <h2>匯入紀錄</h2>
        <button type="button" className="btn btn--secondary" onClick={jobs.reload} disabled={jobs.loading}>
          <Icon name="refresh" /> 重新整理
        </button>
      </div>
      <ApiErrorAlert error={jobs.error} />
      <div className="table-wrap section">
        <table aria-label="匯入紀錄">
          <thead>
            <tr>
              <th scope="col" className="num">
                工作 ID
              </th>
              <th scope="col">來源</th>
              <th scope="col">結果</th>
              <th scope="col">檔案數</th>
              <th scope="col">建立者</th>
              <th scope="col">時間</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.loading && !jobs.data && (
              <tr>
                <td colSpan={7} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {jobs.data?.map((j) => (
              <tr key={j.id}>
                <th scope="row" className="num">
                  {j.id}
                </th>
                <td>{IMPORT_KIND_LABELS[j.kind] ?? j.kind}</td>
                <td>
                  <StatusBadge tone={IMPORT_TONE[j.status] ?? 'neutral'}>{IMPORT_STATUS_LABELS[j.status] ?? j.status}</StatusBadge>
                </td>
                <td>{countsText(j)}</td>
                <td>{j.created_by}</td>
                <td>{formatTime(j.created_at)}</td>
                <td>
                  <Link to={`/data/imaging/jobs/${j.id}`} aria-label={`檢視匯入工作 ${j.id} 的逐檔結果`}>
                    逐檔結果
                  </Link>
                </td>
              </tr>
            ))}
            {jobs.data?.length === 0 && (
              <tr>
                <td colSpan={7}>這個專案還沒有匯入紀錄</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
