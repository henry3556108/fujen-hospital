import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { RUN_STATUS_LABELS, formatTime, type FhirMapping, type FhirSchedule, type FhirSource } from './types';

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

  async function act(action: () => Promise<unknown>, message: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      schedules.reload();
    } catch (e) {
      setError(e);
    }
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
    ).then(() => setName(''));
  }

  const label = (list: { id: number; name: string }[] | null, id: number) =>
    list?.find((x) => x.id === id)?.name ?? `#${id}`;

  return (
    <div className="section">
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={schedules.error} />
      <div className="table-wrap">
        <table aria-label="排程列表">
          <thead>
            <tr>
              <th scope="col">名稱</th>
              <th scope="col">來源／規則</th>
              <th scope="col">間隔（分鐘）</th>
              <th scope="col">狀態</th>
              <th scope="col">下次執行</th>
              <th scope="col">最近一次</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {schedules.data?.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                <td>
                  {label(sources.data, s.source_id)}／{label(mappings.data, s.mapping_id)}
                </td>
                <td>{s.interval_minutes}</td>
                <td>{s.enabled ? '啟用' : '停用'}</td>
                <td>{s.enabled ? formatTime(s.next_run_at) : '—'}</td>
                <td>
                  {s.last_run
                    ? `${RUN_STATUS_LABELS[s.last_run.status]}（偏差 ${s.last_run.deviation_seconds ?? '—'} 秒）`
                    : '尚未執行'}
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`${s.enabled ? '停用' : '啟用'} ${s.name}`}
                      onClick={() =>
                        void act(
                          () => api.patch(`${base}/schedules/${s.id}`, { enabled: !s.enabled }),
                          `已${s.enabled ? '停用' : '啟用'}排程「${s.name}」`,
                        )
                      }
                    >
                      {s.enabled ? '停用' : '啟用'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`刪除 ${s.name}`}
                      onClick={() => void act(() => api.delete(`${base}/schedules/${s.id}`), `已刪除排程「${s.name}」`)}
                    >
                      刪除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {schedules.data?.length === 0 && (
              <tr>
                <td colSpan={7}>還沒有排程</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form aria-label="新增排程" className="card section" onSubmit={create}>
        <h2>新增排程</h2>
        <p className="text-muted">定時抓取來源、轉換後寫入 FHIR。排程由獨立的 worker 執行，每 5 秒檢查一次。</p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="sch-name">排程名稱（必填）</label>
            <input id="sch-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
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
            />
          </div>
        </div>
        <div className="row-actions">
          <button type="submit" className="btn btn--primary" disabled={!name || !sourceId || !mappingId}>
            新增排程
          </button>
        </div>
      </form>
    </div>
  );
}
