import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { ReportView } from './ReportView';
import type { Dataset, UploadResult, ValidationReport } from './types';

const SCHEMA_EXAMPLE = `{
  "columns": [
    { "name": "patient_id", "type": "str", "required": true, "unique": true },
    { "name": "age", "type": "int", "required": true, "min": 18, "max": 100 },
    { "name": "sex", "type": "category", "required": true, "allowed": ["M", "F"] }
  ]
}`;

function UploadForm({ onUploaded }: { onUploaded: (r: UploadResult) => void }) {
  const { api, project } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [schema, setSchema] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function loadSchema(f: File | undefined) {
    if (f) setSchema(await f.text());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError(new Error('請先選擇 CSV 檔案'));
    if (!schema.trim()) return setError(new Error('請貼上或載入結構定義（JSON）'));
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('schema', schema);
    if (name.trim()) form.append('name', name.trim());
    setBusy(true);
    try {
      onUploaded(await api.postForm<UploadResult>(`/api/projects/${project!.id}/tabular/datasets`, form));
      setFile(null);
      setName('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  return (
    <form aria-label="上傳 CSV" className="card section" onSubmit={submit} noValidate>
      <h3>上傳 CSV</h3>
      <p className="text-muted">上傳時依結構定義逐列驗證。不合格的列會被拒絕並列出原因，合格的列才進入資料集。</p>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="csv-file">CSV 檔案（UTF-8）</label>
          <input
            ref={fileInput}
            id="csv-file"
            className="file-input"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="field">
          <label htmlFor="csv-name">資料集名稱</label>
          <input id="csv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="csv-name-hint" />
          <span id="csv-name-hint" className="field__hint">
            留白則使用檔名；同一專案內名稱不可重複
          </span>
        </div>
        <div className="field">
          <label htmlFor="schema-file">載入結構定義檔（.json）</label>
          <input
            id="schema-file"
            className="file-input"
            type="file"
            accept=".json,application/json"
            onChange={(e) => void loadSchema(e.target.files?.[0])}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="schema-text">結構定義（JSON）</label>
        <textarea
          id="schema-text"
          className="textarea"
          value={schema}
          onChange={(e) => setSchema(e.target.value)}
          spellCheck={false}
          aria-describedby="schema-hint"
        />
        <span id="schema-hint" className="field__hint">
          每個欄位可設定 type（int、float、str、category、bool、date）、required、min、max、allowed、unique、pattern
        </span>
        <details>
          <summary>結構定義範例</summary>
          <pre className="mono">{SCHEMA_EXAMPLE}</pre>
        </details>
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '上傳中…' : '上傳並驗證'}
        </button>
      </div>
    </form>
  );
}

/** TC-B01-10 資料集列表、CSV 上傳與驗證報告。 */
export function DatasetsPage() {
  const { api, project } = useSession();
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
      <h2>結構式資料</h2>
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

      <UploadForm
        onUploaded={(r) => {
          setUploaded(r);
          setReport(null);
          setNotice(`已建立資料集「${r.dataset.name}」`);
          datasets.reload();
        }}
      />
      {uploaded && (
        <>
          <ReportView report={uploaded.report} title={`「${uploaded.dataset.name}」的上傳結果`} />
          <p>
            <Link to={`/data/tabular/${uploaded.dataset.id}`}>開啟資料集「{uploaded.dataset.name}」</Link>
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
            確定要刪除資料集「<strong>{deleting.name}</strong>」嗎？檔案與 Target／Feature 設定會一併刪除，此動作無法復原。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
