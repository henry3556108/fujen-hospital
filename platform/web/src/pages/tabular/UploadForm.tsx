import { useRef, useState, type FormEvent } from 'react';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ReportView } from './ReportView';
import { SchemaTable } from './SchemaTable';
import type { Dataset, InferResult, SchemaColumn, TabularSchema, UploadResult, ValidationReport } from './types';
import { FileInput } from '../../components/FileInput';

const SCHEMA_EXAMPLE = `{
  "columns": [
    { "name": "patient_id", "type": "str", "required": true, "unique": true },
    { "name": "age", "type": "int", "required": false, "min": 0, "max": 120 },
    { "name": "sex", "type": "category", "required": false, "allowed": ["M", "F"] }
  ]
}`;

const VERSION_RE = /（第 (\d+) 版）$/;

/** 同名資料集已存在時的新版本名稱：「名稱（第 n 版）」，n 取現有版本的最大值加一。 */
export function nextVersionName(name: string, existing: string[]): string {
  const base = name.replace(VERSION_RE, '');
  const versions = existing
    .filter((n) => n === base || (n.startsWith(base) && VERSION_RE.test(n) && n.replace(VERSION_RE, '') === base))
    .map((n) => Number(VERSION_RE.exec(n)?.[1] ?? 1));
  return `${base}（第 ${Math.max(1, ...versions) + 1} 版）`;
}

/** 檔案中有、結構定義沒列出的欄位（上傳時會被忽略） */
function unknownColumns(report: ValidationReport, schemaText: string): string[] {
  try {
    const names = new Set((JSON.parse(schemaText) as TabularSchema).columns.map((c) => c.name));
    return report.columns.filter((c) => !names.has(c));
  } catch {
    return [];
  }
}

type Conflict = 'version' | 'replace';

/** CSV 上傳：選檔後自動判斷每欄型態，使用者在表上確認後上傳；JSON 結構定義收在「進階」。 */
export function UploadForm({ datasets, onUploaded }: { datasets: Dataset[]; onUploaded: (r: UploadResult, replaced: Dataset | null) => void }) {
  const { api, project } = useSession();
  const base = `/api/projects/${project!.id}/tabular`;
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [inferred, setInferred] = useState<InferResult | null>(null);
  const [columns, setColumns] = useState<SchemaColumn[]>([]);
  const [missingText, setMissingText] = useState('');
  const [precheck, setPrecheck] = useState<ValidationReport | null>(null);
  const [stale, setStale] = useState(false);
  const [advanced, setAdvanced] = useState('');
  const [unknown, setUnknown] = useState<string[] | null>(null);
  const [conflict, setConflict] = useState<Conflict>('version');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const finalName = name.trim() || file?.name || '';
  const existing = datasets.find((d) => d.name === finalName) ?? null;

  function form(f: File, extra: Record<string, string>) {
    const body = new FormData();
    body.append('file', f, f.name);
    for (const [k, v] of Object.entries(extra)) body.append(k, v);
    return body;
  }

  async function infer(f: File, tokens?: string[]) {
    setError(null);
    setBusy('正在讀取檔案、判斷每一欄的型態…');
    try {
      const result = await api.postForm<InferResult>(`${base}/schema/infer`, form(f, tokens ? { missing_values: JSON.stringify(tokens) } : {}));
      setInferred(result);
      setColumns(result.schema.columns);
      setMissingText(result.missing_values.join('、'));
      setPrecheck(result.report);
      setStale(false);
      setUnknown(null);
    } catch (err) {
      setInferred(null);
      setColumns([]);
      setPrecheck(null);
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  function chooseFile(f: File | null) {
    setFile(f);
    setInferred(null);
    setPrecheck(null);
    setUnknown(null);
    if (f) void infer(f);
  }

  const schemaText = () => (advanced.trim() ? advanced : JSON.stringify({ columns } satisfies TabularSchema));

  async function check(): Promise<ValidationReport | null> {
    if (!file) return null;
    const { report } = await api.postForm<{ report: ValidationReport }>(`${base}/schema/check`, form(file, { schema: schemaText() }));
    setPrecheck(report);
    setStale(false);
    return report;
  }

  async function recheck() {
    setError(null);
    setBusy('預檢中…');
    try {
      await check();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  /** 進階結構缺少的欄位：用自動判斷的結果補上 */
  function addUnknown() {
    if (!inferred || !unknown) return;
    try {
      const schema = JSON.parse(advanced) as TabularSchema;
      schema.columns = [...schema.columns, ...inferred.schema.columns.filter((c) => unknown.includes(c.name))];
      setAdvanced(JSON.stringify(schema, null, 2));
      setUnknown(null);
      setStale(true);
    } catch (err) {
      setError(err);
    }
  }

  async function submit(e: FormEvent, confirmedDrop = false) {
    e.preventDefault();
    setError(null);
    if (!file) return setError(new Error('請先選擇 CSV 檔案'));
    if (!advanced.trim() && columns.length === 0) return setError(new Error('還沒有欄位設定：請等檔案讀取完成，或在「進階」貼上結構定義'));
    setBusy('上傳中…');
    try {
      // 先預檢：結構定義沒有列到的欄位要使用者確認，不默默丟掉
      const report = await check();
      const dropped = report && !report.errors.length ? unknownColumns(report, schemaText()) : [];
      if (dropped.length && !confirmedDrop) {
        setUnknown(dropped);
        return undefined;
      }
      if (report && (report.errors.length || report.valid_rows === 0)) {
        return setError(new Error(report.errors[0]?.message ?? '沒有任何一列通過驗證，未上傳；請依預檢結果修改欄位設定'));
      }
      let uploadName = finalName;
      let replaced: Dataset | null = null;
      if (existing && conflict === 'version') uploadName = nextVersionName(finalName, datasets.map((d) => d.name));
      if (existing && conflict === 'replace') {
        await api.delete(`${base}/datasets/${existing.id}`);
        replaced = existing;
      }
      const result = await api.postForm<UploadResult>(`${base}/datasets`, form(file, { schema: schemaText(), name: uploadName }));
      onUploaded(result, replaced);
      setFile(null);
      setName('');
      setInferred(null);
      setColumns([]);
      setPrecheck(null);
      setUnknown(null);
      setAdvanced('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
    return undefined;
  }

  return (
    <form id="upload-csv" aria-label="上傳 CSV" className="card section" onSubmit={(e) => void submit(e)} noValidate>
      <h3>上傳 CSV</h3>
      <ol className="steps-list text-muted">
        <li>選擇 CSV 檔（Excel 可「另存新檔」成 CSV）。平台會自動判斷每一欄是數字、類別或日期。</li>
        <li>在下方的「欄位確認」表檢查型態，需要時勾選「必填」或填上合理範圍。</li>
        <li>按「上傳並驗證」。不符合設定的列會被拒絕並列出原因，其餘的列進入資料集。</li>
      </ol>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="csv-file">CSV 檔案</label>
          <FileInput
            ref={fileInput}
            id="csv-file"
            accept=".csv,text/csv"
            fileNames={file ? [file.name] : []}
            onFiles={(files) => chooseFile(files[0] ?? null)}
            aria-describedby="csv-file-hint"
          />
          <span id="csv-file-hint" className="field__hint">
            第一列是欄名，可以用中文。UTF-8 或 Excel 預設的 Big5 編碼都可以。
          </span>
        </div>
        <div className="field">
          <label htmlFor="csv-name">資料集名稱</label>
          <input id="csv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="csv-name-hint" />
          <span id="csv-name-hint" className="field__hint">
            留白則使用檔名
          </span>
        </div>
      </div>

      {existing && (
        <fieldset className="section">
          <legend>已經有名為「{existing.name}」的資料集</legend>
          <label className="checkbox">
            <input type="radio" name="conflict" checked={conflict === 'version'} onChange={() => setConflict('version')} />
            建立新版本「{nextVersionName(finalName, datasets.map((d) => d.name))}」，舊的保留
          </label>
          <label className="checkbox">
            <input type="radio" name="conflict" checked={conflict === 'replace'} onChange={() => setConflict('replace')} />
            取代舊的（刪除舊資料集與它的 Target／Feature 設定，再以同一名稱上傳）
          </label>
        </fieldset>
      )}

      {busy && <p role="status">{busy}</p>}

      {inferred && (
        <section className="section" aria-labelledby="schema-confirm">
          <h4 id="schema-confirm">欄位確認</h4>
          <p className="text-muted">
            共 {inferred.row_count} 列、{columns.length} 欄。型態依每一欄大多數的值判斷；少數不符合的格子不會改變型態，該列在上傳時會被拒絕並列出原因。
            {advanced.trim() && <strong>（目前使用「進階」的結構定義，這張表不會套用）</strong>}
          </p>
          <SchemaTable
            columns={columns}
            summaries={inferred.columns}
            onChange={(c) => {
              setColumns(c);
              setStale(true);
            }}
          />
          <div className="field">
            <label htmlFor="missing-values">視為缺值的寫法</label>
            <input id="missing-values" className="input" value={missingText} onChange={(e) => setMissingText(e.target.value)} aria-describedby="missing-hint" />
            <span id="missing-hint" className="field__hint">
              空白一律視為缺值。以頓號分隔，例如 NA、N/A、-；不分大小寫。
            </span>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!!busy || !file}
              onClick={() => file && void infer(file, missingText.split(/[、,，]/).map((v) => v.trim()).filter(Boolean))}
            >
              套用缺值寫法並重新判斷
            </button>
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void recheck()}>
              重新預檢
            </button>
          </div>
        </section>
      )}

      {precheck && (
        <>
          {stale && <Alert tone="info">欄位設定已修改，按「重新預檢」看新的結果（上傳時也會再檢查一次）。</Alert>}
          <ReportView report={precheck} title="預檢結果（尚未上傳）" />
        </>
      )}

      {unknown && (
        <Alert tone="warning" title={`結構定義沒有列出 ${unknown.length} 個欄位`}>
          <p>{unknown.join('、')} 不在結構定義中，若繼續上傳，這些欄位不會進入資料集。</p>
          <div className="row-actions">
            <button type="button" className="btn btn--primary" onClick={addUnknown}>
              自動加入這些欄位
            </button>
            <button type="button" className="btn btn--secondary" onClick={(e) => void submit(e as unknown as FormEvent, true)}>
              不要這些欄位，繼續上傳
            </button>
          </div>
        </Alert>
      )}

      <details className="section">
        <summary>進階：自行提供結構定義（JSON）</summary>
        <p className="text-muted">有填寫時，以這裡的結構定義取代上方的欄位確認表。</p>
        <div className="field">
          <label htmlFor="schema-file">載入結構定義檔（.json）</label>
          <FileInput
            id="schema-file"
            accept=".json,application/json"
            onFiles={async (files) => {
              const f = files[0];
              if (f) {
                setAdvanced(await f.text());
                setStale(true);
              }
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="schema-text">結構定義（JSON）</label>
          <textarea
            id="schema-text"
            className="textarea"
            value={advanced}
            onChange={(e) => {
              setAdvanced(e.target.value);
              setStale(true);
            }}
            spellCheck={false}
            aria-describedby="schema-hint"
          />
          <span id="schema-hint" className="field__hint">
            每個欄位可設定 type（int、float、str、category、bool、date）、required、min、max、allowed、unique、pattern、missing_values
          </span>
          <details>
            <summary>結構定義範例</summary>
            <pre className="mono">{SCHEMA_EXAMPLE}</pre>
            {inferred && (
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => {
                  setAdvanced(JSON.stringify({ columns }, null, 2));
                  setStale(true);
                }}
              >
                以上方欄位確認表產生 JSON
              </button>
            )}
          </details>
        </div>
      </details>

      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={!!busy}>
          {busy === '上傳中…' ? '上傳中…' : '上傳並驗證'}
        </button>
      </div>
    </form>
  );
}
