import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { FileInput } from '../../components/FileInput';
import { Icon, type IconName } from '../../components/Icon';
import { useProjectAccess } from '../data/access';
import { ImportResult } from './ImportResult';
import { PacsPage } from './PacsPage';
import type { ImportJob } from './types';
import './imaging.css';

/** 檔案在使用者電腦上的相對路徑；選資料夾時保留資料夾結構（makesense 標註靠路徑配對）。 */
function sourcePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

/** NIfTI／ITK／makesense 走 /files，其餘（.dcm、沒有副檔名…）走 /dicom，由後端判斷是否為 DICOM */
const OTHER_FORMAT = /\.(nii|nii\.gz|gz|mha|json)$/i;
export function endpointOf(file: File): 'dicom' | 'files' {
  return OTHER_FORMAT.test(file.name) ? 'files' : 'dicom';
}

interface Batch {
  endpoint: 'dicom' | 'files';
  files: File[];
  job: ImportJob;
}

const RESULT_TITLE: Record<Batch['endpoint'], string> = { dicom: 'DICOM 匯入結果', files: '影像與標註檔匯入結果' };

function UploadForm({
  id,
  title,
  hint,
  accept,
  allowFolder,
  route,
}: {
  id: string;
  title: string;
  hint: string;
  accept: string;
  allowFolder: boolean;
  /** 每個檔案送到哪個匯入 API */
  route: (file: File) => Batch['endpoint'];
}) {
  const { api } = useSession();
  const { project } = useProjectAccess();
  const base = `/api/projects/${project!.id}/imaging`;
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<number | null>(null);

  async function send(endpoint: Batch['endpoint'], list: File[]): Promise<Batch> {
    const form = new FormData();
    for (const f of list) form.append('files', f, sourcePath(f));
    return { endpoint, files: list, job: await api.postForm<ImportJob>(`${base}/${endpoint}`, form) };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBatches([]);
    if (files.length === 0) {
      setError(new Error('請先選擇檔案'));
      return;
    }
    const groups = new Map<Batch['endpoint'], File[]>();
    for (const f of files) groups.set(route(f), [...(groups.get(route(f)) ?? []), f]);
    setBusy(true);
    try {
      const done: Batch[] = [];
      for (const [endpoint, list] of groups) done.push(await send(endpoint, list));
      setBatches(done);
      setFiles([]);
      if (input.current) input.current.value = '';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** 只重傳失敗的檔案：依結果的檔名找回瀏覽器裡的檔案 */
  async function retry(index: number) {
    const batch = batches[index];
    const failed = new Set((batch.job.files ?? []).filter((f) => f.status === 'failed').map((f) => f.filename));
    const list = batch.files.filter((f) => failed.has(sourcePath(f)) || failed.has(f.name));
    if (list.length === 0) return;
    setRetrying(index);
    setError(null);
    try {
      const next = await send(batch.endpoint, list);
      setBatches((all) => all.map((b, i) => (i === index ? next : b)));
    } catch (err) {
      setError(err);
    } finally {
      setRetrying(null);
    }
  }

  const done = batches.length > 0;
  const added = batches.reduce((n, b) => n + b.job.counts.imported, 0);
  return (
    <form aria-label={title} className="card section" onSubmit={submit} noValidate>
      <h3>{title}</h3>
      <ApiErrorAlert error={error} />
      <div className="field">
        <label htmlFor={`${id}-files`}>選擇檔案（可多選）</label>
        <FileInput
          ref={input}
          id={`${id}-files`}
          multiple
          accept={folder ? undefined : accept}
          aria-describedby={`${id}-hint`}
          onFiles={setFiles}
          fileNames={files.map((f) => f.name)}
          buttonText={folder ? '選擇資料夾' : '選擇檔案'}
          {...(folder ? { webkitdirectory: '' } : {})}
        />
        <span id={`${id}-hint`} className="field__hint">
          {hint}
        </span>
      </div>
      {allowFolder && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={folder}
            onChange={(e) => {
              setFolder(e.target.checked);
              setFiles([]);
              if (input.current) input.current.value = '';
            }}
          />
          選擇整個資料夾（保留資料夾路徑）
        </label>
      )}
      <p role="status" className="text-muted">
        {files.length ? `已選擇 ${files.length} 個檔案，將加入專案「${project!.name}」` : '尚未選擇檔案'}
      </p>
      <div className="row-actions">
        <button type="submit" className={done ? 'btn btn--secondary' : 'btn btn--primary'} disabled={busy}>
          <Icon name="upload" /> {busy ? '上傳中…' : `上傳到「${project!.name}」`}
        </button>
      </div>
      {batches.map((b, i) => (
        <ImportResult
          key={`${b.endpoint}-${b.job.id}`}
          job={b.job}
          title={RESULT_TITLE[b.endpoint]}
          onRetryFailed={() => void retry(i)}
          retrying={retrying === i}
        />
      ))}
      {done && (
        <div className="rd-footer-actions">
          <Link to="/data/imaging/jobs">看匯入紀錄</Link>
          {batches.some((b) => b.endpoint === 'files') && <Link to="/data/imaging/files">看檔案與配對</Link>}
          {added > 0 && (
            <Link to="/labeling" className="btn btn--secondary">
              開始標註
            </Link>
          )}
          {/* 舊名稱「到影像清單查看」保留為無障礙名稱（驗收腳本沿用） */}
          <Link to="/data/imaging" className="btn btn--primary" aria-label="到影像清單查看">
            查看匯入的影像 <Icon name="arrow" />
          </Link>
        </div>
      )}
    </form>
  );
}

export type Source = 'upload' | 'pacs' | 'bundle';
export const SOURCES: { key: Source; title: string; desc: string; icon: IconName }[] = [
  { key: 'upload', title: '從電腦上傳', desc: '支援 DICOM（單檔或整個資料夾）、NIfTI、MHA、makesense JSON', icon: 'upload' },
  { key: 'pacs', title: '從影像儲傳系統取得', desc: '向影像儲傳系統（PACS）查詢，挑選後匯入影像', icon: 'database' },
  { key: 'bundle', title: '匯入影像與標註檔', desc: '影像和對應的標註檔一起匯入（NIfTI 的 _image／_label、MHA、makesense JSON）', icon: 'doc' },
];

export function sourceOf(value: string | null): Source {
  return SOURCES.find((s) => s.key === value)?.key ?? 'upload';
}

/**
 * TC-B01-02～07 匯入資料（A02 滑出面板內容）：目標專案、三種來源卡片、選中來源的上傳或查詢表單；需要 Labeling 權限。
 * source／onSource：目前選的來源（由呼叫端放在網址）。
 */
export function AddDataPanel({ source, onSource }: { source: Source; onSource: (s: Source) => void }) {
  const { project, can, missing } = useProjectAccess();
  if (!can('labeling')) {
    return (
      <Alert tone="warning" title="沒有權限">
        {missing('labeling', '匯入影像')}
      </Alert>
    );
  }
  return (
    <>
      <span className="rd-target-label">目標專案</span>
      <p className="rd-target">{project!.name}</p>
      <p className="field__hint">
        加入的影像只會進到專案「<strong>{project!.name}</strong>」。要加到別的專案，請先在頂端切換專案。
      </p>
      <ul className="rd-sources" aria-label="資料來源">
        {SOURCES.map((s) => (
          <li key={s.key}>
            <button type="button" className="rd-source" aria-pressed={source === s.key} onClick={() => onSource(s.key)}>
              <span className="rd-source__icon" aria-hidden="true">
                <Icon name={s.icon} />
              </span>
              <span>
                <span className="entry-card__title">{s.title}</span>
                <span className="entry-card__desc">{s.desc}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-muted">
        單一檔案失敗不影響其他檔案。同一專案內以 SOP Instance UID 判斷重複，重複的影像不會再存一份。大量匯入請使用批次匯入程式。
      </p>
      {source === 'upload' && (
        <UploadForm
          key="upload"
          id="upload"
          title="從電腦上傳"
          hint="DICOM（.dcm、.dicom、.ima 或沒有副檔名）、NIfTI（.nii、.nii.gz）、ITK MetaImage（.mha）、makesense 匯出（.json）"
          accept=".dcm,.dicom,.ima,.nii,.gz,.mha,.json"
          allowFolder
          route={endpointOf}
        />
      )}
      {source === 'bundle' && (
        <UploadForm
          key="bundle"
          id="bundle"
          title="匯入影像與標註檔"
          hint="檔名以 _image、_label 結尾會自動配對；makesense 標註會依檔名配到已匯入的 DICOM。配對結果可到「檔案與配對」查看。"
          accept=".nii,.gz,.mha,.json"
          allowFolder={false}
          route={() => 'files'}
        />
      )}
      {source === 'pacs' && (
        <section className="card section" aria-label="從影像儲傳系統取得">
          <h3>從影像儲傳系統取得</h3>
          <PacsPage embedded />
        </section>
      )}
    </>
  );
}
