// 語言模型各分頁共用的小元件：⋮ 選單、檔案格式小圖、文件上傳與文件清單。
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { parseApiTime } from '../../components/format';
import { FileInput } from '../../components/FileInput';
import { Alert, ApiErrorAlert, Badge, ConfirmDialog } from '../../components/ui';
import type { KbDocument, LlmApi, UploadResult } from './api';

/** 文件的處理狀態：有片段＝可使用，否則未完成。 */
export const docStatus = (chunks: number) => (chunks > 0 ? '可使用' : '未完成');

const UPLOAD_STATUS: Record<string, string> = { indexed: '可使用', duplicate: '重複，已略過', failed: '未完成' };

const pad = (n: number) => String(n).padStart(2, '0');

/** 2026/10/23 */
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? parseApiTime(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 2026/10/23 10:15 */
export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? parseApiTime(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 檔案格式小方塊（PDF 紅、DOCX 藍，其他灰） */
export function FileBadge({ name, format }: { name?: string; format?: string }) {
  const ext = (format || name?.split('.').pop() || '').toLowerCase();
  const tone = ext === 'pdf' ? 'pdf' : ext === 'docx' || ext === 'doc' ? 'word' : 'other';
  return (
    <span className={`llm-file llm-file--${tone}`} aria-hidden="true">
      {ext === 'docx' || ext === 'doc' ? 'W' : (ext || 'file').slice(0, 4).toUpperCase()}
    </span>
  );
}

export interface MoreMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** 每列右側的 ⋮ 選單（設計稿 A08 文件清單）。Esc 或點外面關閉。 */
export function MoreMenu({ label, items }: { label: string; items: MoreMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="llm-more" ref={ref}>
      <button type="button" className="ui-icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true" className="llm-more__dots">⋮</span>
      </button>
      {open && (
        <div role="menu" aria-label={label} className="llm-more__menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`llm-more__item ${it.danger ? 'llm-more__item--danger' : ''}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 加入文件：多檔上傳＋逐檔結果（參考文件分頁與對話左側「加入文件」共用）。 */
export function DocumentUpload({ llm, kbId, idPrefix = 'kb', onUploaded }: { llm: LlmApi; kbId: number; idPrefix?: string; onUploaded: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await llm.upload(kbId, files));
      onUploaded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form aria-label="加入文件" className="stack" onSubmit={upload}>
        <div className="field">
          <label htmlFor={`${idPrefix}-files`}>選擇檔案（PDF、DOCX、TXT、CSV、JSON、HTML，可多選）</label>
          <FileInput id={`${idPrefix}-files`} multiple accept=".pdf,.docx,.txt,.csv,.json,.html,.htm" onFiles={setFiles} fileNames={files.map((f) => f.name)} />
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy || files.length === 0}>
          {busy ? '處理中…' : '加入文件'}
        </button>
      </form>
      <ApiErrorAlert error={error} />
      {result && (
        <>
          <Alert tone={result.counts.failed ? 'warning' : 'success'}>
            可使用 {result.counts.indexed} 份、重複 {result.counts.duplicate} 份、未完成 {result.counts.failed} 份
          </Alert>
          <ul aria-label="上傳結果" className="llm-plain-list">
            {result.results.map((r) => (
              <li key={r.filename}>
                {r.filename}：{UPLOAD_STATUS[r.status]}
                {r.reason ? `（${r.reason}）` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** 文件清單：格式、檔名、上傳日期與大小、狀態徽章、⋮（刪除文件）。 */
export function DocumentList({ llm, kbId, docs, onChanged }: { llm: LlmApi; kbId: number; docs: KbDocument[]; onChanged: () => void }) {
  const [removing, setRemoving] = useState<KbDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await llm.deleteDocument(kbId, removing.id);
      setRemoving(null);
      onChanged();
    } catch (err) {
      setError(err);
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ApiErrorAlert error={error} />
      {docs.length === 0 ? (
        <p className="text-muted">這個文件集還沒有文件，按「加入文件」上傳。</p>
      ) : (
        <ul aria-label="文件與處理狀態" className="llm-docs">
          {docs.map((d) => (
            <li key={d.id} className="llm-docs__item">
              <FileBadge name={d.filename} format={d.format} />
              <div className="llm-docs__text">
                <span className="llm-docs__name">{d.filename}</span>
                <span className="llm-docs__meta">
                  {d.uploaded_at ? `上傳日期 ${fmtDate(d.uploaded_at)} · ` : ''}
                  {fmtSize(d.size)} · {d.format.toUpperCase()}，{d.chunks} 個片段
                </span>
              </div>
              <Badge tone={d.chunks > 0 ? 'success' : 'warning'}>{docStatus(d.chunks)}</Badge>
              <MoreMenu label={`${d.filename} 更多操作`} items={[{ label: '刪除文件', danger: true, onSelect: () => setRemoving(d) }]} />
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <ConfirmDialog title="刪除文件" confirmLabel="刪除" busy={busy} onConfirm={() => void remove()} onCancel={() => setRemoving(null)}>
          刪除「{removing.filename}」後，根據文件回答不會再引用這份文件。
        </ConfirmDialog>
      )}
    </>
  );
}
