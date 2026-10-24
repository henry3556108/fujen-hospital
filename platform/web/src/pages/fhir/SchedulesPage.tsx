import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert, Badge, Card, ConfirmDialog, Icon, SidePanel, SplitLayout, Toggle } from '../../components/ui';
import { RUN_STATUS_LABELS, formatTime, type FhirMapping, type FhirSchedule, type FhirSource } from './types';

/** 間隔轉成白話：每 30 分鐘、每 6 小時、每天 */
export function intervalText(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '每天' : `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小時`;
  return `每 ${minutes} 分鐘`;
}

/** FHIR 轉換排程（設計稿 B26）：排程清單＋右側新增排程；刪除先確認。 */
export function SchedulesPage() {
  const { api, project } = useSession();
  const base = `/api/projects/${project!.id}/fhir`;
  const schedules = useResource(() => api.get<FhirSchedule[]>(`${base}/schedules`), [base]);
  const sources = useResource(() => api.get<FhirSource[]>(`${base}/sources`), [base]);
  const mappings = useResource(() => api.get<FhirMapping[]>(`${base}/mappings`), [base]);
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [mappingId, setMappingId] = useState('');
  const [interval, setInterval] = useState('60');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<FhirSchedule | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  async function act(action: () => Promise<unknown>, message: string): Promise<boolean> {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      schedules.reload();
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  }

  function reset() {
    setName('');
    setSourceId('');
    setMappingId('');
    setInterval('60');
  }

  function create(e: FormEvent) {
    e.preventDefault();
    void act(
      () =>
        api.post(`${base}/schedules`, {
          name,
          source_id: Number(sourceId),
          mapping_id: Number(mappingId),
          interval_minutes: Number(interval),
        }),
      `已新增排程「${name}」`,
    ).then((ok) => ok && reset());
  }

  const label = (list: { id: number; name: string }[] | null, id: number) => list?.find((x) => x.id === id)?.name ?? `#${id}`;
  const missing = (sources.data && sources.data.length === 0) || (mappings.data && mappings.data.length === 0);

  const side = (
    <SidePanel title="新增排程">
      <form aria-label="新增排程" className="stack" onSubmit={create}>
        <div className="field">
          <label htmlFor="sch-name">排程名稱（必填）</label>
          <input id="sch-name" ref={nameRef} className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sch-source">來源</label>
          <select id="sch-source" className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">請選擇</option>
            {sources.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sch-mapping">對應規則</label>
          <select id="sch-mapping" className="select" value={mappingId} onChange={(e) => setMappingId(e.target.value)}>
            <option value="">請選擇</option>
            {mappings.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sch-interval">間隔（分鐘，1–10080）</label>
          <input
            id="sch-interval"
            className="input"
            type="number"
            min={1}
            max={10080}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            aria-describedby="sch-interval-hint"
          />
          <span id="sch-interval-hint" className="field__hint">
            {Number(interval) >= 1 ? intervalText(Number(interval)) : '請輸入 1 到 10080'}
          </span>
        </div>
        {missing && <Alert tone="warning">還沒有來源或對應規則，請先到「來源與對應」建立。</Alert>}
        <Alert tone="info">排程由獨立的 worker 每 5 秒檢查一次，到時間自動執行轉換並產生執行紀錄。</Alert>
        <Link to="/admin/fhir/sources" className="fhir-more">
          管理來源與規則 ›
        </Link>
        <div className="fhir-form-actions">
          <button type="button" className="btn btn--secondary" onClick={reset}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={!name || !sourceId || !mappingId}>
            新增排程
          </button>
        </div>
      </form>
    </SidePanel>
  );

  return (
    <SplitLayout side={side}>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={schedules.error} />
      <Card
        title="排程清單"
        flush
        extra={
          <button type="button" className="btn btn--secondary btn--small" onClick={() => nameRef.current?.focus()}>
            ＋ 新增排程
          </button>
        }
      >
        <div className="table-wrap">
          <table aria-label="排程列表">
            <thead>
              <tr>
                <th scope="col">名稱</th>
                <th scope="col">來源</th>
                <th scope="col">規則</th>
                <th scope="col">間隔</th>
                <th scope="col">最近結果</th>
                <th scope="col">下次執行</th>
                <th scope="col">啟用</th>
                <th scope="col">
                  <span className="visually-hidden">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {schedules.data?.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.name}</th>
                  <td>{label(sources.data, s.source_id)}</td>
                  <td>{label(mappings.data, s.mapping_id)}</td>
                  <td>{intervalText(s.interval_minutes)}</td>
                  <td>
                    {s.last_run ? (
                      <span className="fhir-last">
                        <Badge tone={s.last_run.status === 'succeeded' ? 'success' : s.last_run.status === 'running' ? 'info' : 'error'}>
                          {RUN_STATUS_LABELS[s.last_run.status]}
                        </Badge>
                        <span className="text-muted">
                          {formatTime(s.last_run_at)}（延遲 {s.last_run.deviation_seconds ?? '—'} 秒）
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">尚未執行</span>
                    )}
                  </td>
                  <td>{s.enabled ? formatTime(s.next_run_at) : '—'}</td>
                  <td>
                    <Toggle
                      checked={s.enabled}
                      hideLabel
                      label={`啟用 ${s.name}`}
                      onChange={() =>
                        void act(
                          () => api.patch(`${base}/schedules/${s.id}`, { enabled: !s.enabled }),
                          `已${s.enabled ? '停用' : '啟用'}排程「${s.name}」`,
                        )
                      }
                    />
                  </td>
                  <td>
                    <button type="button" className="ui-icon-btn" aria-label={`刪除 ${s.name}`} onClick={() => setDeleting(s)}>
                      <Icon name="close" />
                    </button>
                  </td>
                </tr>
              ))}
              {schedules.data?.length === 0 && (
                <tr>
                  <td colSpan={8}>還沒有排程</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {deleting && (
        <ConfirmDialog
          title="刪除排程"
          confirmLabel="刪除"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const s = deleting;
            setDeleting(null);
            void act(() => api.delete(`${base}/schedules/${s.id}`), `已刪除排程「${s.name}」`);
          }}
        >
          <p>
            確定要刪除「<strong>{deleting.name}</strong>」嗎？此操作無法復原。
          </p>
        </ConfirmDialog>
      )}
    </SplitLayout>
  );
}
