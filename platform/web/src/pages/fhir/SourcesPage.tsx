import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { FileInput } from '../../components/FileInput';
import { Alert, ApiErrorAlert, Badge, Card, InfoList, Stepper } from '../../components/ui';
import {
  RUN_STATUS_LABELS,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  TRIGGER_LABELS,
  formatTime,
  writtenText,
  type BuiltinMapping,
  type FhirMapping,
  type FhirRun,
  type FhirSource,
  type SourceKind,
} from './types';

const RUN_TONE = { succeeded: 'success', rejected: 'error', failed: 'error', running: 'info' } as const;

/** 右欄「轉換結果」：讀取、寫入、不合格筆數與失敗明細 */
function RunResult({ run }: { run: FhirRun }) {
  const ok = run.status === 'succeeded';
  return (
    <div className="stack">
      {ok ? (
        <Alert tone="success">
          執行 #{run.id} 成功：讀取 {run.records_read} 筆，寫入 {writtenText(run.resources_written)}。
        </Alert>
      ) : (
        <Alert tone="error">
          執行 #{run.id}：{RUN_STATUS_LABELS[run.status]}。
        </Alert>
      )}
      <InfoList
        items={[
          { label: '讀取', value: `${run.records_read} 筆` },
          { label: '寫入', value: writtenText(run.resources_written) },
          { label: '不合格', value: `${run.errors.length} 筆` },
          { label: '完成時間', value: formatTime(run.finished_at ?? run.started_at) },
        ]}
      />
      {run.errors.length > 0 && (
        <div className="table-wrap">
          <table aria-label={`失敗資料（${run.errors.length} 筆）`}>
            <caption className="fhir-caption">失敗資料（{run.errors.length} 筆，最多列出 10 筆）</caption>
            <thead>
              <tr>
                <th scope="col">列號／訊息</th>
                <th scope="col">原因</th>
              </tr>
            </thead>
            <tbody>
              {run.errors.slice(0, 10).map((e, i) => (
                <tr key={i}>
                  <th scope="row">{e.control_id ? `訊息 ${e.control_id}` : e.index !== undefined ? `第 ${e.index + 1} 筆` : '—'}</th>
                  <td>{e.reasons.join('；')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SourceForm({ onCreated }: { onCreated: (s: FhirSource) => void }) {
  const { api, project } = useSession();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('csv');
  const [content, setContent] = useState('');
  const [dsn, setDsn] = useState('');
  const [query, setQuery] = useState('SELECT * FROM patients');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = kind === 'sql' ? { name, kind, config: { dsn, query } } : { name, kind, content };
      const s = await api.post<FhirSource>(`/api/projects/${project!.id}/fhir/sources`, body);
      setName('');
      setContent('');
      onCreated(s);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(file: File | undefined) {
    if (file) setContent(await file.text());
  }

  return (
    <form aria-label="新增來源" className="stack" onSubmit={submit} noValidate>
      <h3 className="fhir-subhead">新增來源</h3>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="src-name">來源名稱（必填）</label>
          <input id="src-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="src-kind">來源類型</label>
          <select id="src-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as SourceKind)}>
            {SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SOURCE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {kind === 'sql' ? (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="src-dsn">連線字串</label>
            <input id="src-dsn" className="input" value={dsn} onChange={(e) => setDsn(e.target.value)} aria-describedby="src-dsn-hint" />
            <span id="src-dsn-hint" className="field__hint">
              例如 postgresql+psycopg://帳號:密碼@主機:5432/his。密碼存入後不會再顯示。
            </span>
          </div>
          <div className="field">
            <label htmlFor="src-query">查詢（只能是 SELECT）</label>
            <input id="src-query" className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="src-content">內容</label>
          <textarea id="src-content" className="input fhir-textarea" value={content} onChange={(e) => setContent(e.target.value)} />
          <label htmlFor="src-file" className="field__hint">
            或選擇檔案
          </label>
          <FileInput id="src-file" onFiles={(files) => void loadFile(files[0])} />
        </div>
      )}
      <div className="row-actions">
        <button type="submit" className="btn btn--secondary" disabled={busy}>
          新增來源
        </button>
      </div>
    </form>
  );
}

/** FHIR 來源與對應（設計稿 B25）：左側選來源與規則並執行，右側轉換結果與執行紀錄；來源、規則清單在下方。 */
export function SourcesPage() {
  const { api, project } = useSession();
  const base = `/api/projects/${project!.id}/fhir`;
  const sources = useResource(() => api.get<FhirSource[]>(`${base}/sources`), [base]);
  const mappings = useResource(() => api.get<FhirMapping[]>(`${base}/mappings`), [base]);
  const builtin = useResource(() => api.get<BuiltinMapping[]>(`${base}/mappings/builtin`), [base]);
  const runs = useResource(() => api.get<FhirRun[]>(`${base}/runs?limit=20`), [base]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [builtinName, setBuiltinName] = useState('');
  const [kindFilter, setKindFilter] = useState<SourceKind | ''>('');
  const [sourceId, setSourceId] = useState('');
  const [mappingId, setMappingId] = useState('');
  const [lastRun, setLastRun] = useState<FhirRun | null>(null);
  const [busy, setBusy] = useState(false);

  async function addBuiltin() {
    setError(null);
    setNotice(null);
    try {
      const m = await api.post<FhirMapping>(`${base}/mappings`, { builtin: builtinName });
      setNotice(`已加入對應規則「${m.name}」`);
      mappings.reload();
    } catch (e) {
      setError(e);
    }
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setLastRun(null);
    try {
      setLastRun(await api.post<FhirRun>(`${base}/runs`, { source_id: Number(sourceId), mapping_id: Number(mappingId) }));
    } catch (err) {
      // 資料不合格 422、FHIR 拒絕 502、連不上 503：整批未寫入，但仍有一筆執行紀錄，顯示它的原因
      if (err instanceof ApiError && [422, 502, 503].includes(err.status) && err.fieldErrors.length === 0) {
        const [latest] = await api.get<FhirRun[]>(`${base}/runs?limit=1`).catch(() => [] as FhirRun[]);
        if (latest && latest.status !== 'succeeded') setLastRun(latest);
        else setError(err);
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
      runs.reload();
    }
  }

  const sourceName = (id: number | null) => sources.data?.find((s) => s.id === id)?.name ?? (id ? `#${id}` : '—');
  const mappingName = (id: number | null) => mappings.data?.find((m) => m.id === id)?.name ?? (id ? `#${id}` : '—');
  const shownSources = (sources.data ?? []).filter((s) => !kindFilter || s.kind === kindFilter);
  const selected = sources.data?.find((s) => String(s.id) === sourceId);
  const selectedMapping = mappings.data?.find((m) => String(m.id) === mappingId);
  const step = sourceId && mappingId ? 1 : 0;

  return (
    <div className="stack">
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={sources.error ?? mappings.error ?? runs.error} />

      <div className="fhir-split">
        <Card>
          <Stepper label="轉換步驟" steps={[{ label: '選擇來源與規則' }, { label: '預覽與執行' }]} current={lastRun ? 2 : step} />
          <form aria-label="執行轉換" className="stack fhir-run-form" onSubmit={run}>
            <fieldset className="field">
              <legend>資料來源類型</legend>
              <div className="fhir-radios">
                <label className="checkbox-row">
                  <input type="radio" name="kind-filter" checked={kindFilter === ''} onChange={() => setKindFilter('')} />
                  全部
                </label>
                {SOURCE_KINDS.map((k) => (
                  <label key={k} className="checkbox-row">
                    <input
                      type="radio"
                      name="kind-filter"
                      checked={kindFilter === k}
                      onChange={() => {
                        setKindFilter(k);
                        setSourceId('');
                      }}
                    />
                    {SOURCE_KIND_LABELS[k]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="run-source">來源</label>
              <select id="run-source" className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">請選擇</option>
                {shownSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {selected && (
                <span className="field__hint">
                  {SOURCE_KIND_LABELS[selected.kind]}・
                  {selected.kind === 'sql' ? '從資料庫查詢' : `${selected.content_bytes.toLocaleString()} bytes`}
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="run-mapping">對應規則</label>
              <select id="run-mapping" className="select" value={mappingId} onChange={(e) => setMappingId(e.target.value)}>
                <option value="">請選擇</option>
                {mappings.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {selectedMapping && (
                <span className="field__hint">
                  將{SOURCE_KIND_LABELS[selectedMapping.source_kind]}對應至 FHIR {selectedMapping.resource_types.join('、')} 資源
                  {selected && selected.kind !== selectedMapping.source_kind && '（與所選來源類型不同，執行時會被擋下）'}
                </span>
              )}
            </div>
            <p className="text-muted fhir-card-note">整批寫入：任何一筆不合格或寫入中斷，整批都不會寫進 FHIR。</p>
            <div className="fhir-run-form__actions">
              <button type="submit" className="btn btn--primary" disabled={busy || !sourceId || !mappingId}>
                執行轉換
              </button>
            </div>
          </form>
        </Card>

        <div className="stack">
          <Card title="轉換結果" extra={lastRun ? <span className="text-muted">{formatTime(lastRun.started_at)}</span> : undefined}>
            {lastRun ? <RunResult run={lastRun} /> : <p className="text-muted">選擇來源與規則後按「執行轉換」，結果與失敗原因會顯示在這裡。</p>}
          </Card>
          <Card title="執行紀錄" flush extra={<span className="text-muted">最近 20 筆</span>}>
            <div className="table-wrap">
              <table aria-label="執行紀錄">
                <thead>
                  <tr>
                    <th scope="col">編號</th>
                    <th scope="col">開始時間</th>
                    <th scope="col">來源／規則</th>
                    <th scope="col">觸發</th>
                    <th scope="col">讀取</th>
                    <th scope="col">寫入</th>
                    <th scope="col">結果</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data?.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">#{r.id}</th>
                      <td>{formatTime(r.started_at)}</td>
                      <td>{r.source_id || r.mapping_id ? `${sourceName(r.source_id)}／${mappingName(r.mapping_id)}` : '—'}</td>
                      <td>{TRIGGER_LABELS[r.trigger]}</td>
                      <td>{r.records_read}</td>
                      <td>{writtenText(r.resources_written)}</td>
                      <td>
                        <Badge tone={RUN_TONE[r.status]}>{RUN_STATUS_LABELS[r.status]}</Badge>
                      </td>
                    </tr>
                  ))}
                  {runs.data?.length === 0 && (
                    <tr>
                      <td colSpan={7}>還沒有執行紀錄</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      <div className="fhir-split">
        <Card title="資料來源">
          <div className="table-wrap">
            <table aria-label="來源列表">
              <thead>
                <tr>
                  <th scope="col">名稱</th>
                  <th scope="col">類型</th>
                  <th scope="col">設定</th>
                  <th scope="col">建立者</th>
                </tr>
              </thead>
              <tbody>
                {sources.data?.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">{s.name}</th>
                    <td>{SOURCE_KIND_LABELS[s.kind]}</td>
                    <td className="fhir-code">{s.kind === 'sql' ? String(s.config.dsn ?? '') : `${s.content_bytes.toLocaleString()} bytes`}</td>
                    <td>{s.created_by}</td>
                  </tr>
                ))}
                {sources.data?.length === 0 && (
                  <tr>
                    <td colSpan={4}>還沒有來源</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <SourceForm
            onCreated={(s) => {
              setNotice(`已新增來源「${s.name}」`);
              sources.reload();
            }}
          />
        </Card>

        <Card title="對應規則">
          <p className="text-muted fhir-card-note">目前只能加入內建規則；自訂、編輯與刪除規則尚未開放。</p>
          <div className="table-wrap">
            <table aria-label="對應規則列表">
              <thead>
                <tr>
                  <th scope="col">名稱</th>
                  <th scope="col">適用來源</th>
                  <th scope="col">轉出資源</th>
                </tr>
              </thead>
              <tbody>
                {mappings.data?.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{m.name}</th>
                    <td>{SOURCE_KIND_LABELS[m.source_kind]}</td>
                    <td>{m.resource_types.join('、')}</td>
                  </tr>
                ))}
                {mappings.data?.length === 0 && (
                  <tr>
                    <td colSpan={3}>還沒有對應規則</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="field field--inline">
            <label htmlFor="builtin-mapping">內建規則</label>
            <select id="builtin-mapping" className="select" value={builtinName} onChange={(e) => setBuiltinName(e.target.value)}>
              <option value="">請選擇</option>
              {builtin.data?.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}（{SOURCE_KIND_LABELS[b.source_kind]} → {b.resource_types.join('、')}）
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--secondary" disabled={!builtinName} onClick={() => void addBuiltin()}>
              加入
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
