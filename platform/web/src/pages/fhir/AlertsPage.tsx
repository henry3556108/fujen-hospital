import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert, Card, Icon, InfoList, SidePanel, SplitLayout, StatusDot } from '../../components/ui';
import { formatTime, type TrafficAlert } from './types';

interface Filter {
  actor: string;
  from: string;
  to: string;
}

/** 依使用者與日期（含當天）篩選；API 一次回最近 200 筆，篩選在畫面上做 */
export function filterAlerts(list: TrafficAlert[], f: Filter): TrafficAlert[] {
  return list.filter((a) => {
    if (f.actor && a.actor !== f.actor) return false;
    const day = localDay(a.created_at);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    return true;
  });
}

function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** FHIR 流量監測與告警（設計稿 B27）：篩選、告警清單、點一筆看詳情；門檻在 API Gateway 路由調整。 */
export function AlertsPage() {
  const { api, project } = useSession();
  const alerts = useResource(() => api.get<TrafficAlert[]>(`/api/projects/${project!.id}/fhir/alerts`), [project!.id]);
  const [draft, setDraft] = useState<Filter>({ actor: '', from: '', to: '' });
  const [filter, setFilter] = useState<Filter>(draft);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const all = alerts.data ?? [];
  const actors = [...new Set(all.map((a) => a.actor))].sort();
  const list = filterAlerts(all, filter);
  const selected = list.find((a) => a.id === selectedId) ?? null;

  function apply(e: FormEvent) {
    e.preventDefault();
    setFilter(draft);
    setSelectedId(null);
  }

  const side = selected ? (
    <SidePanel title="流量告警詳情" onClose={() => setSelectedId(null)}>
      <InfoList
        items={[
          { label: '時間', value: formatTime(selected.created_at) },
          { label: '使用者', value: selected.actor },
          { label: '60 秒請求數', value: selected.request_count },
          { label: '門檻（每分鐘）', value: selected.threshold },
          { label: '統計區間開始', value: formatTime(selected.window_start) },
          { label: '通知狀態', value: selected.notified ? '已寄出' : '未寄出' },
        ]}
      />
      <p className="text-muted fhir-card-note">同一使用者同一分鐘只通知一次。</p>
    </SidePanel>
  ) : undefined;

  return (
    <div className="stack">
      <form className="ui-card fhir-filter" aria-label="篩選流量告警" onSubmit={apply}>
        <div className="field">
          <label htmlFor="alert-actor">使用者</label>
          <select id="alert-actor" className="select" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })}>
            <option value="">全部使用者</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="alert-from">開始日期</label>
          <input id="alert-from" type="date" className="input" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="alert-to">結束日期</label>
          <input id="alert-to" type="date" className="input" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <div className="fhir-filter__actions">
          <button type="submit" className="btn btn--primary">
            查詢
          </button>
          <Link to="/admin/fhir/gateway" className="btn btn--secondary">
            調整告警門檻
          </Link>
        </div>
      </form>
      <p className="text-muted">
        同一使用者在這個租戶 60 秒內的 FHIR 請求超過門檻時建立告警並寄信。門檻是全平台 Gateway 設定，調整後影響所有專案。
      </p>
      <ApiErrorAlert error={alerts.error} />
      <SplitLayout side={side}>
        <Card flush title={`告警紀錄（${list.length} 筆）`}>
          <div className="table-wrap">
            <table aria-label="流量告警">
              <thead>
                <tr>
                  <th scope="col">時間</th>
                  <th scope="col">使用者</th>
                  <th scope="col">60 秒內請求數</th>
                  <th scope="col">門檻（每分鐘）</th>
                  <th scope="col">通知</th>
                  <th scope="col">
                    <span className="visually-hidden">詳情</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id} className={a.id === selectedId ? 'fhir-row--selected' : undefined}>
                    <th scope="row">{formatTime(a.created_at)}</th>
                    <td>{a.actor}</td>
                    <td className={a.request_count > a.threshold ? 'fhir-over' : undefined}>{a.request_count}</td>
                    <td>{a.threshold}</td>
                    <td>
                      <StatusDot tone={a.notified ? 'warning' : 'neutral'}>{a.notified ? '已寄出' : '未寄出'}</StatusDot>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ui-icon-btn"
                        aria-label={`查看 ${formatTime(a.created_at)} ${a.actor} 的告警詳情`}
                        onClick={() => setSelectedId(a.id)}
                      >
                        <Icon name="chevron-right" />
                      </button>
                    </td>
                  </tr>
                ))}
                {alerts.data && list.length === 0 && (
                  <tr>
                    <td colSpan={6}>{all.length === 0 ? '沒有流量告警' : '沒有符合條件的告警'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </SplitLayout>
    </div>
  );
}
