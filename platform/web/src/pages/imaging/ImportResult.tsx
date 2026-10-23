import { useState } from 'react';
import { Alert } from '../../components/Alert';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { FILE_STATUS_LABELS, IMPORT_STATUS_LABELS, type FileStatus, type ImportJob, type ImportStatus } from './types';

export const FILE_TONE: Record<FileStatus, BadgeTone> = { imported: 'success', duplicate: 'info', failed: 'error' };
export const IMPORT_TONE: Record<ImportStatus, BadgeTone> = { succeeded: 'success', partial: 'warning', failed: 'error' };

export function countsText(job: ImportJob): string {
  return `新增 ${job.counts.imported}、重複 ${job.counts.duplicate}、失敗 ${job.counts.failed}`;
}

type Show = 'all' | FileStatus;

/**
 * 一次匯入的結果：新增／重複／失敗數＋逐檔狀態；失敗的檔案列出檔名與原因（TC-B01-05），不影響其他檔案。
 * onRetryFailed：有給才顯示「只重傳失敗的檔案」（例如剛上傳完、檔案還在瀏覽器裡）。
 */
export function ImportResult({
  job,
  title,
  onRetryFailed,
  retrying = false,
}: {
  job: ImportJob;
  title: string;
  onRetryFailed?: () => void;
  retrying?: boolean;
}) {
  const files = job.files ?? [];
  const [show, setShow] = useState<Show>('all');
  const tone = job.status === 'succeeded' ? 'success' : job.status === 'partial' ? 'warning' : 'error';
  const total = job.counts.imported + job.counts.duplicate + job.counts.failed;
  const listed = show === 'all' ? files : files.filter((f) => f.status === show);
  const filters: [Show, string, number][] = [
    ['all', '全部', total],
    ['failed', '失敗', job.counts.failed],
    ['duplicate', '重複', job.counts.duplicate],
  ];
  return (
    <section className="section" aria-label={title}>
      <h3>{title}</h3>
      <Alert tone={tone} title={IMPORT_STATUS_LABELS[job.status]}>
        匯入工作 {job.id}：{countsText(job)}。
        {job.counts.duplicate > 0 && '重複的影像已經在專案裡，沒有再存一份。'}
        {job.counts.failed > 0 && '失敗的檔案不影響其他檔案，原因見下表。'}
      </Alert>
      <dl className="stat-grid section" aria-label={`${title}統計`}>
        <div className="card">
          <dt>本次檔案</dt>
          <dd>{total}</dd>
        </div>
        <div className="card">
          <dt>新增</dt>
          <dd>{job.counts.imported}</dd>
        </div>
        <div className="card">
          <dt>重複</dt>
          <dd>{job.counts.duplicate}</dd>
        </div>
        <div className="card">
          <dt>失敗</dt>
          <dd>{job.counts.failed}</dd>
        </div>
      </dl>
      <div className="row-actions section" role="group" aria-label="顯示哪些檔案">
        {filters.map(([key, label, n]) => (
          <button
            key={key}
            type="button"
            className="btn btn--ghost btn--small"
            aria-pressed={show === key}
            onClick={() => setShow(key)}
          >
            {label}（{n}）
          </button>
        ))}
        {onRetryFailed && job.counts.failed > 0 && (
          <button type="button" className="btn btn--secondary btn--small" onClick={onRetryFailed} disabled={retrying}>
            {retrying ? '重傳中…' : `只重傳失敗的 ${job.counts.failed} 個檔案`}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table aria-label={`${title}逐檔結果`}>
          <thead>
            <tr>
              <th scope="col">檔案</th>
              <th scope="col">結果</th>
              <th scope="col">原因</th>
            </tr>
          </thead>
          <tbody>
            {listed.map((f, i) => (
              <tr key={`${f.filename}-${i}`}>
                <th scope="row" className="mono">
                  {f.filename}
                </th>
                <td>
                  <StatusBadge tone={FILE_TONE[f.status] ?? 'neutral'}>{FILE_STATUS_LABELS[f.status] ?? f.status}</StatusBadge>
                </td>
                <td>{f.reason || '—'}</td>
              </tr>
            ))}
            {listed.length === 0 && (
              <tr>
                <td colSpan={3}>沒有檔案</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
