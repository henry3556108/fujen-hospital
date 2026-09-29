import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { formatTime, type TrafficAlert } from './types';

export function AlertsPage() {
  const { api, project } = useSession();
  const alerts = useResource(() => api.get<TrafficAlert[]>(`/api/projects/${project!.id}/fhir/alerts`), [project!.id]);
  return (
    <div className="section">
      <p className="text-muted">
        同一使用者在這個租戶 60 秒內的 FHIR 請求超過門檻時建立告警並寄信；同一分鐘只通知一次。門檻在「Gateway 路由」分頁調整。
      </p>
      <ApiErrorAlert error={alerts.error} />
      <div className="table-wrap">
        <table aria-label="流量告警">
          <thead>
            <tr>
              <th scope="col">時間</th>
              <th scope="col">使用者</th>
              <th scope="col">60 秒內請求數</th>
              <th scope="col">門檻（每分鐘）</th>
              <th scope="col">通知</th>
            </tr>
          </thead>
          <tbody>
            {alerts.data?.map((a) => (
              <tr key={a.id}>
                <th scope="row">{formatTime(a.created_at)}</th>
                <td>{a.actor}</td>
                <td>{a.request_count}</td>
                <td>{a.threshold}</td>
                <td>{a.notified ? '已寄出' : '未寄出'}</td>
              </tr>
            ))}
            {alerts.data?.length === 0 && (
              <tr>
                <td colSpan={5}>沒有流量告警</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
