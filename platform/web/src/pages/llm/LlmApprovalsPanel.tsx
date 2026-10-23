import { useState } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import type { Download } from './api';

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
    <section className="card section" aria-labelledby="llm-approvals-title">
      <h2 id="llm-approvals-title">語言模型下載申請</h2>
      <ApiErrorAlert error={list.error ?? error} />
      {list.data && pending.length === 0 && <p className="text-muted">目前沒有待審核的申請。</p>}
      {pending.length > 0 && (
        <div className="table-wrap">
          <table aria-label="待審核的下載申請">
            <thead><tr><th>模型</th><th>申請人</th><th>時間</th><th>操作</th></tr></thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.name}</th>
                  <td>{d.user}</td>
                  <td>{d.time ?? '—'}</td>
                  <td className="row-actions">
                    <button type="button" className="btn btn--small btn--primary" onClick={() => void review(d.id, true)}>核准</button>
                    <button type="button" className="btn btn--small btn--secondary" onClick={() => void review(d.id, false)}>駁回</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
