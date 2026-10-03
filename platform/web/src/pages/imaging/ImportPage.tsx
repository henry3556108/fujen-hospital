import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useProjectAccess } from '../data/access';
import { ImportResult } from './ImportResult';
import type { ImportJob } from './types';
import { FileInput } from '../../components/FileInput';

/** 檔案在使用者電腦上的相對路徑；選資料夾時保留資料夾結構（makesense 標註靠路徑配對）。 */
function sourcePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function UploadForm({
  title,
  hint,
  accept,
  endpoint,
  resultTitle,
  allowFolder,
}: {
  title: string;
  hint: string;
  accept: string;
  endpoint: string;
  resultTitle: string;
  allowFolder: boolean;
}) {
  const { api } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folder, setFolder] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const id = endpoint.replace(/\W+/g, '-');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setJob(null);
    if (files.length === 0) {
      setError(new Error('請先選擇檔案'));
      return;
    }
    const form = new FormData();
    for (const f of files) form.append('files', f, sourcePath(f));
    setBusy(true);
    try {
      setJob(await api.postForm<ImportJob>(endpoint, form));
      setFiles([]);
      if (input.current) input.current.value = '';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

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
        {files.length ? `已選擇 ${files.length} 個檔案` : '尚未選擇檔案'}
      </p>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '上傳中…' : `上傳${title}`}
        </button>
      </div>
      {job && (
        <>
          <ImportResult job={job} title={resultTitle} />
          <p>
            <Link to="/data/imaging">到研究列表查看</Link>　<Link to="/data/imaging/files">到檔案與配對查看</Link>
          </p>
        </>
      )}
    </form>
  );
}

/** TC-B01-02～06：DICOM 與 NIfTI／ITK／makesense 上傳；需要 Labeling 權限。 */
export function ImportPage() {
  const { project, can, missing } = useProjectAccess();
  const base = `/api/projects/${project!.id}/imaging`;
  return (
    <>
      <h2>匯入影像</h2>
      {can('labeling') ? (
        <>
          <p className="text-muted">
            單一檔案失敗不影響其他檔案。同一專案內以 SOP Instance UID 判斷重複，重複的影像不會再存一份。大量匯入請使用批次匯入程式。
          </p>
          <UploadForm
            title="DICOM"
            hint="副檔名 .dcm、.dicom、.ima 或沒有副檔名"
            accept=".dcm,.dicom,.ima"
            endpoint={`${base}/dicom`}
            resultTitle="DICOM 匯入結果"
            allowFolder
          />
          <UploadForm
            title="NIfTI、ITK、makesense"
            hint="NIfTI（.nii、.nii.gz）、ITK MetaImage（.mha）、makesense 匯出（.json）。檔名以 _image、_label 結尾會自動配對"
            accept=".nii,.gz,.mha,.json"
            endpoint={`${base}/files`}
            resultTitle="檔案匯入結果"
            allowFolder={false}
          />
        </>
      ) : (
        <Alert tone="warning" title="沒有權限">
          {missing('labeling', '匯入影像')}
        </Alert>
      )}
    </>
  );
}
