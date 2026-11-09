import { useState, type ReactNode } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert, Badge, SidePanel } from '../../components/ui';
import { formatTime } from '../../components/format';
import { SchedulingPage } from './SchedulingRoutes';
import { SHARED_PATH, SharedSettingsForm } from './SharedSchedulingPage';
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_TONE,
  QUEUE_KIND_LABELS,
  type QueueJob,
  type QueueOverview,
  type SharedSchedulingSettings,
} from './types';

// 佇列標題沿用（驗收腳本以標題找佇列卡）
const QUEUE_NAMES: Record<string, string> = {
  'gpu-exclusive': 'GPU 獨占池（gpu-exclusive）',
  'gpu-shared': 'GPU 共享池（gpu-shared）',
  'cpu-data': 'CPU 資料處理（cpu-data）',
};

/** 欄頭底色：獨占＝青綠、共享＝藍、CPU＝橘（設計稿 B22） */
const QUEUE_TONE: Record<string, string> = {
  'gpu-exclusive': 'exclusive',
  'gpu-shared': 'shared',
  'cpu-data': 'cpu',
};

function linkText(j: QueueJob): string {
  if (j.training_run) return `訓練 #${j.training_run.id}：${j.training_run.name}`;
  if (j.inference_id !== null) return `批次推論 #${j.inference_id}`;
  return '—';
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 右欄：共享排程設定（時間片份數、工作時限），與「共享排程設定」分頁同一份表單 */
function SharedPanel() {
  const { api } = useSession();
  const settings = useResource(() => api.get<SharedSchedulingSettings>(SHARED_PATH));
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SidePanel title="共享排程設定">
      <ApiErrorAlert error={settings.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      {settings.loading && !settings.data && <p role="status">載入中…</p>}
      {settings.data && (
        <SharedSettingsForm
          initial={settings.data}
          submitLabel="儲存共享排程設定"
          idPrefix="panel-"
          secondary
          onSaved={(saved) => {
            settings.setData(saved);
            setNotice(`已儲存共享排程設定：時間片 ${saved.time_slice_replicas} 份、工作時限 ${saved.job_timeout_minutes} 分鐘`);
          }}
        />
      )}
      <Alert tone="info">「套用順序」只會調整等待中的工作，不會影響正在執行的工作。共享排程設定只影響共享池。</Alert>
    </SidePanel>
  );
}

/** 後台佇列順序（設計稿 B22）：每個佇列一欄；執行中的工作固定在前；等待中的可調整先後（套用後依新順序開始）、暫存或恢復排隊。 */
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
    <SchedulingPage
      title="佇列排程與共享排程設定"
      subtitle="管理不同資源類型的佇列排程與共享規則"
      side={<SharedPanel />}
      actions={
        <button type="button" className="btn btn--secondary" onClick={refresh} disabled={queues.loading || busy}>
          重新整理
        </button>
      }
    >
      <p className="text-muted">
        每個佇列依先後放行工作。執行中的工作不能移動；等待中的工作可用 ↑／↓ 調整後按「套用順序」，
        或「暫存」移出佇列，之後「恢復排隊」會排到最後。研究者取消自己的工作仍在訓練紀錄操作。
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={queues.error} />
      {queues.loading && !queues.data && <p role="status">載入中…</p>}
      <div className="sch-board">
        {(queues.data ?? []).map((q) => {
          const byId = new Map(q.waiting.map((j) => [j.id, j]));
          const current = q.waiting.map((j) => j.id);
          const draft = drafts[q.queue];
          const order = draft && draft.length === current.length && draft.every((id) => byId.has(id)) ? draft : current;
          const changed = !same(order, current);
          const empty = q.running.length + q.waiting.length + q.held.length === 0;
          return (
            <section key={q.queue} className={`ui-card sch-queue sch-queue--${QUEUE_TONE[q.queue] ?? 'other'}`} aria-labelledby={`queue-${q.queue}`}>
              <div className="sch-queue__head">
                <h2 id={`queue-${q.queue}`} className="sch-queue__title">
                  {QUEUE_NAMES[q.queue] ?? q.queue}
                </h2>
                <span className="sch-queue__counts">
                  執行中 {q.running.length}・等待中 {q.waiting.length}
                  {q.held.length > 0 && `・已暫存 ${q.held.length}`}
                </span>
              </div>
              {empty ? (
                <p className="text-muted sch-queue__empty">這個佇列沒有進行中的工作。</p>
              ) : (
                <table aria-label={`佇列 ${q.queue}`} className="sch-queue__table">
                  <thead className="visually-hidden">
                    <tr>
                      <th scope="col">順序</th>
                      <th scope="col">工作 ID</th>
                      <th scope="col">內容</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.running.map((j) => (
                      <Row key={j.id} job={j} order={j.admitted ? '即將開始' : '執行中'} tone="running">
                        <span className="text-muted">不可移動</span>
                      </Row>
                    ))}
                    {order.map((id, i) => {
                      const j = byId.get(id)!;
                      return (
                        <Row key={id} job={j} order={`第 ${i + 1} 位`} tone="waiting">
                          <div className="sch-queue__moves">
                            <button
                              type="button"
                              className="ui-icon-btn sch-move"
                              aria-label={`上移工作 ${id}`}
                              disabled={i === 0 || busy}
                              onClick={() => move(q, order, i, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="ui-icon-btn sch-move"
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
                      <Row key={j.id} job={j} order={`暫存（${j.held_by ?? ''}，${formatTime(j.held_at)}）`} tone="held">
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
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
              )}
              {changed && (
                <p className="text-muted sch-queue__pending" role="status">
                  順序已調整，尚未套用。
                </p>
              )}
              <div className="sch-queue__foot">
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
            </section>
          );
        })}
      </div>
    </SchedulingPage>
  );
}

function Row({ job, order, tone, children }: { job: QueueJob; order: string; tone: 'running' | 'waiting' | 'held'; children: ReactNode }) {
  return (
    <tr data-status={job.status} className={`sch-job sch-job--${tone}`}>
      <td className="sch-job__order">{order}</td>
      <th scope="row" className="sch-job__id">
        {job.id}
      </th>
      <td className="sch-job__info">
        <span>
          {job.project_name || `#${job.project_id}`}｜{job.user}
        </span>
        <span className="text-muted">
          {QUEUE_KIND_LABELS[job.kind] ?? job.kind}・{linkText(job)}
        </span>
        <span className="sch-job__meta">
          <Badge tone={JOB_STATUS_TONE[job.status] ?? 'neutral'}>
            {job.admitted ? '即將開始' : (JOB_STATUS_LABELS[job.status] ?? job.status)}
          </Badge>
          <span className="text-muted">{formatTime(job.started_at ?? job.created_at)}</span>
        </span>
      </td>
      <td className="sch-job__actions">{children}</td>
    </tr>
  );
}
