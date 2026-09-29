import { Alert } from '../../components/Alert';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { FILE_STATUS_LABELS, IMPORT_STATUS_LABELS, type FileStatus, type ImportJob, type ImportStatus } from './types';

export const FILE_TONE: Record<FileStatus, BadgeTone> = { imported: 'success', duplicate: 'info', failed: 'error' };
export const IMPORT_TONE: Record<ImportStatus, BadgeTone> = { succeeded: 'success', partial: 'warning', failed: 'error' };

export function countsText(job: ImportJob): string {
  return `匯入 ${job.counts.imported}、重複 ${job.counts.duplicate}、失敗 ${job.counts.failed}`;
}

/** 一次匯入的結果：摘要＋逐檔狀態；失敗的檔案列出檔名與原因（TC-B01-05），不影響其他檔案。 */
export function ImportResult({ job, title }: { job: ImportJob; title: string }) {
  const files = job.files ?? [];
  const tone = job.status === 'succeeded' ? 'success' : job.status === 'partial' ? 'warning' : 'error';
  return (
    <section className="section" aria-label={title}>
      <h3>{title}</h3>
      <Alert tone={tone} title={IMPORT_STATUS_LABELS[job.status]}>
        匯入工作 {job.id}：{countsText(job)}。
        {job.counts.failed > 0 && '失敗的檔案不影響其他檔案，原因見下表。'}
      </Alert>
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
            {files.map((f, i) => (
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
            {files.length === 0 && (
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
