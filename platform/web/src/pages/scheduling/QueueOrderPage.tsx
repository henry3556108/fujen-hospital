import { useState, type ReactNode } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { StatusBadge } from '../../components/StatusBadge';
import { SchedulingPage } from './SchedulingRoutes';
import { JOB_STATUS_LABELS, JOB_STATUS_TONE, QUEUE_KIND_LABELS, type QueueJob, type QueueOverview } from './types';

const QUEUE_NAMES: Record<string, string> = {
  'gpu-exclusive': 'GPU 獨占池（gpu-exclusive）',
  'gpu-shared': 'GPU 共享池（gpu-shared）',
  'cpu-data': 'CPU 資料處理（cpu-data）',
};

function linkText(j: QueueJob): string {
  if (j.training_run) return `訓練 #${j.training_run.id}：${j.training_run.name}`;
  if (j.inference_id !== null) return `批次推論 #${j.inference_id}`;
  return '—';
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 後台佇列順序：執行中的工作固定在前；等待中的可調整先後（套用後依新順序開始）、暫存或恢復排隊。 */
export function QueueOrderPage() {
  const { api } = useSession();
  const queues = useResource(() => api.get<QueueOverview[]>('/api/admin/queues'));
  // 尚未套用的順序（依佇列）；重新整理或套用後清掉
  const [drafts, setDrafts] = useState<Record<string, number[]>>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    setDrafts({});
    queues.reload();
  }

  async function run(call: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await call());
      refresh();
    } catch (err) {
      setError(err);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  function move(q: QueueOverview, order: number[], index: number, delta: number) {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setDrafts((d) => ({ ...d, [q.queue]: next }));
  }

  return (
    <SchedulingPage title="佇列順序">
      <div className="page-head">
        <p className="text-muted">
          每個佇列依先後放行工作。執行中的工作不能移動；等待中的工作可用 ↑／↓ 調整後按「套用順序」，
          或「暫存」移出佇列，之後「恢復排隊」會排到最後。
        </p>
        <button type="button" className="btn btn--secondary" onClick={refresh} disabled={queues.loading || busy}>
          重新整理
        </button>
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={queues.error} />
      {queues.loading && !queues.data && <p role="status">載入中…</p>}
      {(queues.data ?? []).map((q) => {
        const byId = new Map(q.waiting.map((j) => [j.id, j]));
        const current = q.waiting.map((j) => j.id);
        const draft = drafts[q.queue];
        const order = draft && draft.length === current.length && draft.every((id) => byId.has(id)) ? draft : current;
        const changed = !same(order, current);
        const empty = q.running.length + q.waiting.length + q.held.length === 0;
        return (
          <section key={q.queue} className="card section" aria-labelledby={`queue-${q.queue}`}>
            <div className="page-head">
              <h2 id={`queue-${q.queue}`}>{QUEUE_NAMES[q.queue] ?? q.queue}</h2>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  disabled={!changed || busy}
                  onClick={() => setDrafts((d) => ({ ...d, [q.queue]: current }))}
                >
                  還原
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  aria-label={`套用 ${q.queue} 的順序`}
                  disabled={!changed || busy}
                  onClick={() =>
                    void run(async () => {
                      await api.put(`/api/admin/queues/${q.queue}/order`, { job_ids: order });
                      return `已套用 ${q.queue} 的順序：${order.join('、')}`;
                    })
                  }
                >
                  套用順序
                </button>
              </div>
            </div>
            {changed && <p className="text-muted" role="status">順序已調整，尚未套用。</p>}
            {empty ? (
              <p className="text-muted">這個佇列沒有進行中的工作。</p>
            ) : (
              <div className="table-wrap">
                <table aria-label={`佇列 ${q.queue}`}>
                  <thead>
                    <tr>
                      <th scope="col">順序</th>
                      <th scope="col" className="num">
                        工作 ID
                      </th>
                      <th scope="col">專案</th>
                      <th scope="col">種類</th>
                      <th scope="col">對應</th>
                      <th scope="col">使用者</th>
                      <th scope="col">狀態</th>
                      <th scope="col">建立時間</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.running.map((j) => (
                      <Row key={j.id} job={j} order={j.admitted ? '即將開始' : '執行中'}>
                        <span className="text-muted">不可移動</span>
                      </Row>
                    ))}
                    {order.map((id, i) => {
                      const j = byId.get(id)!;
                      return (
                        <Row key={id} job={j} order={`第 ${i + 1} 位`}>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn--secondary btn--small"
                              aria-label={`上移工作 ${id}`}
                              disabled={i === 0 || busy}
                              onClick={() => move(q, order, i, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--small"
                              aria-label={`下移工作 ${id}`}
                              disabled={i === order.length - 1 || busy}
                              onClick={() => move(q, order, i, 1)}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--small"
                              aria-label={`暫存工作 ${id}`}
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await api.post(`/api/admin/jobs/${id}/hold`);
                                  return `已暫存工作 ${id}`;
                                })
                              }
                            >
                              暫存
                            </button>
                          </div>
                        </Row>
                      );
                    })}
                    {q.held.map((j) => (
                      <Row key={j.id} job={j} order={`暫存（${j.held_by ?? ''}，${formatTime(j.held_at)}）`}>
                        <button
                          type="button"
                          className="btn btn--primary btn--small"
                          aria-label={`恢復排隊工作 ${j.id}`}
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.post(`/api/admin/jobs/${j.id}/resume`);
                              return `工作 ${j.id} 已恢復排隊（排在佇列最後）`;
                            })
                          }
                        >
                          恢復排隊
                        </button>
                      </Row>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </SchedulingPage>
  );
}

function Row({ job, order, children }: { job: QueueJob; order: string; children: ReactNode }) {
  return (
    <tr data-status={job.status}>
      <td>{order}</td>
      <th scope="row" className="num">
        {job.id}
      </th>
      <td>{job.project_name || `#${job.project_id}`}</td>
      <td>{QUEUE_KIND_LABELS[job.kind] ?? job.kind}</td>
      <td>{linkText(job)}</td>
      <td>{job.user}</td>
      <td>
        <StatusBadge tone={JOB_STATUS_TONE[job.status] ?? 'neutral'}>
          {job.admitted ? '即將開始' : (JOB_STATUS_LABELS[job.status] ?? job.status)}
        </StatusBadge>
      </td>
      <td>{formatTime(job.created_at)}</td>
      <td>{children}</td>
    </tr>
  );
}
