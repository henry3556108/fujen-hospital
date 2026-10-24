import { useState } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert, Badge, Card, EmptyState } from '../../components/ui';
import type { Download } from './api';
import { fmtDateTime } from './parts';

/** Admin 審核語言模型下載申請（放在管理區）；這組 API 不分專案。 */
export function LlmApprovalsPanel() {
  const { api } = useSession();
  const list = useResource(() => api.get<Download[]>('/api/admin/llm/downloads'), [api]);
  const [error, setError] = useState<unknown>(null);
  async function review(id: number, approve: boolean) {
    setError(null);
    try {
      await api.post(`/api/admin/llm/downloads/${id}/${approve ? 'approve' : 'reject'}`, {});
      list.reload();
    } catch (e) {
      setError(e);
    }
  }
  const pending = (list.data ?? []).filter((d) => d.status === 'pending');
  return (
    <Card title="語言模型下載申請" extra={list.data && <Badge tone={pending.length ? 'warning' : 'neutral'}>待審核 {pending.length}</Badge>} flush>
      <ApiErrorAlert error={list.error ?? error} />
      {list.data && pending.length === 0 && <EmptyState icon="check" title="目前沒有待審核的申請。" description="使用者在語言模型「模型」分頁申請下載後，會出現在這裡。" />}
      {pending.length > 0 && (
        <div className="table-wrap">
          <table aria-label="待審核的下載申請">
            <thead>
              <tr>
                <th>模型</th>
                <th>申請人</th>
                <th>時間</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.name}</th>
                  <td>{d.user}</td>
                  <td>{d.time ? fmtDateTime(d.time) : '—'}</td>
                  <td>
                    <Badge tone="warning">待審核</Badge>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="btn btn--small btn--primary" onClick={() => void review(d.id, true)}>
                      核准
                    </button>
                    <button type="button" className="btn btn--small btn--secondary" onClick={() => void review(d.id, false)}>
                      駁回
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
