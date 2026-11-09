import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { formatTime } from '../../components/format';
import { Icon } from '../../components/Icon';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { Badge } from '../../components/ui';
import { FILE_STATUS_LABELS, IMPORT_KIND_LABELS, IMPORT_STATUS_LABELS, type FileStatus, type ImportJob, type ImportKind, type ImportStatus } from './types';

export const FILE_TONE: Record<FileStatus, BadgeTone> = { imported: 'success', duplicate: 'info', failed: 'error' };
export const IMPORT_TONE: Record<ImportStatus, BadgeTone> = { succeeded: 'success', partial: 'warning', failed: 'error' };

export function countsText(job: ImportJob): string {
  return `新增 ${job.counts.imported}、重複 ${job.counts.duplicate}、失敗 ${job.counts.failed}`;
}

/** 重新上傳時開哪一種匯入資料來源 */
export const RETRY_SOURCE: Record<ImportKind, string> = { dicom: 'upload', files: 'bundle', pacs: 'pacs' };

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** F6 失敗清單 CSV（Excel 開啟不亂碼：開頭加 BOM）：檔案名稱、失敗原因 */
export function failedCsv(job: ImportJob): string {
  const rows = (job.files ?? []).filter((f) => f.status === 'failed').map((f) => [f.filename, f.reason]);
  return `﻿${[['檔案名稱', '失敗原因'], ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function downloadFailed(job: ImportJob) {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([failedCsv(job)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `匯入失敗清單-工作${job.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type Show = 'all' | FileStatus;

/**
 * 一次匯入的結果（B05）：匯入專案／來源／時間、總數與新增／重複／失敗、全部／失敗／重複分頁、逐檔原因（TC-B01-05），
 * 下方「下載失敗清單」「重新上傳」與呼叫端給的其他動作。
 * onRetryFailed：剛上傳完、檔案還在瀏覽器裡時，只重傳失敗的檔案；retryHref：檔案不在瀏覽器時，連到匯入資料重新選檔。
 */
export function ImportResult({
  job,
  title,
  onRetryFailed,
  retrying = false,
  retryHref,
  actions,
}: {
  job: ImportJob;
  title: string;
  onRetryFailed?: () => void;
  retrying?: boolean;
  retryHref?: string;
  actions?: ReactNode;
}) {
  const { project } = useSession();
  const files = job.files ?? [];
  const [show, setShow] = useState<Show>('all');
  const total = job.counts.imported + job.counts.duplicate + job.counts.failed;
  const listed = show === 'all' ? files : files.filter((f) => f.status === show);
  const failed = job.counts.failed;
  const filters: [Show, string, number][] = [
    ['all', '全部', total],
    ['failed', '失敗', failed],
    ['duplicate', '重複', job.counts.duplicate],
  ];
  return (
    <section className="rd-import" aria-label={title}>
      <h3 className="rd-import__title">{title}</h3>
      <div className="rd-import__summary">
        <dl className="rd-import__meta">
          <div>
            <dt>匯入專案</dt>
            <dd>{project?.name ?? '—'}</dd>
          </div>
          <div>
            <dt>資料來源</dt>
            <dd>{IMPORT_KIND_LABELS[job.kind] ?? job.kind}</dd>
          </div>
          <div>
            <dt>匯入時間</dt>
            <dd>{formatTime(job.created_at)}</dd>
          </div>
          <div>
            <dt>結果</dt>
            <dd>
              <Badge tone={IMPORT_TONE[job.status] ?? 'neutral'}>{IMPORT_STATUS_LABELS[job.status] ?? job.status}</Badge>
            </dd>
          </div>
        </dl>
        <dl className="rd-import__stats" aria-label={`${title}統計`}>
          <div>
            <dt>本次匯入總數</dt>
            <dd>
              {total}
              <small>個檔案</small>
            </dd>
          </div>
          <div>
            <dt>新增成功</dt>
            <dd className="rd-num--success">
              {job.counts.imported}
              <small>筆</small>
            </dd>
          </div>
          <div>
            <dt>重複已有</dt>
            <dd>
              {job.counts.duplicate}
              <small>筆</small>
            </dd>
          </div>
          <div>
            <dt>匯入失敗</dt>
            <dd className={failed ? 'rd-num--warning' : undefined}>
              {failed}
              <small>筆</small>
            </dd>
          </div>
        </dl>
        <p className="rd-import__note">
          匯入工作 {job.id}：{countsText(job)}。
          {job.counts.duplicate > 0 && '重複的影像已經在專案裡，略過、沒有再存一份。'}
          {failed > 0 && '失敗的檔案不影響其他檔案，原因見下表。'}
        </p>
      </div>

      <div className="rd-import__files">
        <div className="tabs rd-tabs" role="group" aria-label="顯示哪些檔案">
          {filters.map(([key, label, n]) => (
            <button key={key} type="button" className="tabs__item" aria-pressed={show === key} onClick={() => setShow(key)}>
              {label}（{n}）
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table aria-label={`${title}逐檔結果`}>
            <thead>
              <tr>
                <th scope="col">檔案名稱</th>
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
      </div>

      <div className="rd-footer-actions">
        {failed > 0 && (
          <button type="button" className="btn btn--secondary" onClick={() => downloadFailed(job)}>
            <Icon name="download" /> 下載失敗清單
          </button>
        )}
        {failed > 0 && onRetryFailed && (
          <button type="button" className="btn btn--secondary" onClick={onRetryFailed} disabled={retrying}>
            <Icon name="upload" /> {retrying ? '重傳中…' : `重新上傳失敗的 ${failed} 個檔案`}
          </button>
        )}
        {failed > 0 && !onRetryFailed && retryHref && (
          <Link to={retryHref} className="btn btn--secondary">
            <Icon name="upload" /> 重新上傳
          </Link>
        )}
        {actions}
      </div>
    </section>
  );
}
