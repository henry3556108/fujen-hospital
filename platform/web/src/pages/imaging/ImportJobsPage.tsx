import { Link, useParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { StatusBadge } from '../../components/StatusBadge';
import { countsText, IMPORT_TONE, ImportResult } from './ImportResult';
import { IMPORT_KIND_LABELS, IMPORT_STATUS_LABELS, type ImportJob } from './types';

function JobDetail({ jobId }: { jobId: string }) {
  const { api, project } = useSession();
  const job = useResource(() => api.get<ImportJob>(`/api/projects/${project!.id}/imaging/jobs/${jobId}`), [project!.id, jobId]);
  return (
    <>
      <ApiErrorAlert error={job.error} />
      {job.loading && !job.data && <p role="status">載入中…</p>}
      {job.data && !job.error && <ImportResult job={job.data} title={`匯入工作 ${job.data.id}`} />}
    </>
  );
}

/** 匯入工作與逐檔結果（含 PACS 取像）。 */
export function ImportJobsPage() {
  const { api, project } = useSession();
  const { jobId } = useParams();
  const jobs = useResource(() => api.get<ImportJob[]>(`/api/projects/${project!.id}/imaging/jobs`), [project!.id]);

  return (
    <>
      <div className="page-head">
        <h2>匯入工作</h2>
        <button type="button" className="btn btn--secondary" onClick={jobs.reload} disabled={jobs.loading}>
          重新整理
        </button>
      </div>
      <ApiErrorAlert error={jobs.error} />
      <div className="table-wrap section">
        <table aria-label="匯入工作列表">
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
              <tr key={j.id} aria-current={String(j.id) === jobId ? 'true' : undefined}>
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
                <td colSpan={7}>這個專案還沒有匯入工作</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {jobId && <JobDetail key={jobId} jobId={jobId} />}
    </>
  );
}
