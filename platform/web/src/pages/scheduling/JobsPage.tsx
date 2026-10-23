import { useEffect, useState, type FormEvent } from 'react';
import { ProjectPicker } from '../../components/ProjectPicker';
import { SchedulingPage } from './SchedulingRoutes';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { StatusBadge } from '../../components/StatusBadge';
import { isActive, isOpen, JOB_KIND_LABELS, JOB_STATUS_LABELS, JOB_STATUS_TONE as STATUS_TONE, QUEUE_KIND_LABELS, type Job, type JobKind } from './types';

const POLL_MS = 2000;

function invalid(error: unknown, field: string): boolean {
  return error instanceof ApiError && error.fieldErrors.some((f) => f.field === field);
}

/** 專案工作：送出、查看狀態（排隊→執行→完成）、取消。需要目前專案的 Training 權限。 */
export function JobsPage() {
  const { api, project } = useSession();
  const pid = project?.id;
  const jobs = useResource(() => (pid ? api.get<Job[]>(`/api/projects/${pid}/jobs`) : Promise.resolve([])), [pid]);
  const { reload } = jobs;
  const [kind, setKind] = useState<JobKind>('training');
  const [duration, setDuration] = useState('30');
  const [memory, setMemory] = useState('16');
  const [fail, setFail] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<Job | null>(null);
  const [cancelError, setCancelError] = useState<unknown>(null);

  const hasActive = (jobs.data ?? []).some((j) => isActive(j.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, reload]);

  if (!project) return <Alert tone="info">請先選擇專案。</Alert>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await api.post<Job>(`/api/projects/${pid}/jobs`, {
        kind,
        duration_seconds: Number(duration),
        memory_mb: Number(memory),
        fail,
      });
      setNotice(`已送出工作 ${job.id}，進入佇列 ${job.queue}`);
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function queueAction(job: Job, action: 'hold' | 'resume') {
    setBusy(true);
    setNotice(null);
    setCancelError(null);
    try {
      const out = await api.post<Job>(`/api/projects/${pid}/jobs/${job.id}/${action}`);
      setNotice(action === 'hold' ? `已暫存工作 ${out.id}，之後按「恢復排隊」會排到佇列最後` : `工作 ${out.id} 已恢復排隊（排在佇列最後）`);
      reload();
    } catch (err) {
      setCancelError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    setBusy(true);
    setCancelError(null);
    try {
      const job = await api.post<Job>(`/api/projects/${pid}/jobs/${cancelling.id}/cancel`);
      setNotice(`已取消工作 ${job.id}`);
      reload();
    } catch (err) {
      setCancelError(err);
    } finally {
      setCancelling(null);
      setBusy(false);
    }
  }

  const list = [...(jobs.data ?? [])].sort((a, b) => b.id - a.id);

  return (
      <SchedulingPage title="測試工作">
      <ProjectPicker id="jobs-project" label="送出到專案" />
      <p className="text-muted">
        專案「{project.name}」的排程工作。訓練工作進入專案綁定 GPU 群組的佇列，資料清洗工作進入 CPU 佇列。
        研究者的訓練紀錄不會列出這裡送出的示範工作。
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={cancelError} />
      <ApiErrorAlert error={jobs.error} />

      <form aria-label="送出工作" className="card section" onSubmit={submit} noValidate>
        <h2>送出工作</h2>
        <ApiErrorAlert error={error} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="job-kind">工作種類</label>
            <select id="job-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as JobKind)}>
              {(Object.keys(JOB_KIND_LABELS) as JobKind[]).map((k) => (
                <option key={k} value={k}>
                  {JOB_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="job-duration">執行秒數（1–3600）</label>
            <input
              id="job-duration"
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={3600}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              aria-invalid={invalid(error, 'duration_seconds') || undefined}
            />
          </div>
          <div className="field">
            <label htmlFor="job-memory">記憶體（MB，1–256）</label>
            <input
              id="job-memory"
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={256}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              aria-invalid={invalid(error, 'memory_mb') || undefined}
            />
          </div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />
          讓這件工作以失敗結束（測試佇列不會卡住）
        </label>
        <div className="row-actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            送出工作
          </button>
        </div>
      </form>

      <section className="section" aria-labelledby="jobs-title">
        <div className="page-head">
          <h2 id="jobs-title">工作列表</h2>
          <button type="button" className="btn btn--secondary" onClick={reload} disabled={jobs.loading}>
            重新整理
          </button>
        </div>
        <p className="text-muted" role="status">
          {hasActive ? '有工作在排隊或執行中，每 2 秒自動更新。' : '沒有進行中的工作。'}
        </p>
        <p className="field__hint">開始與結束時間是叢集實際啟動與結束工作的時間（不是畫面更新的時間），可與叢集紀錄比對。</p>
        <p className="field__hint">排隊中的工作可以「暫存」移出佇列、保留工作內容，之後按「恢復排隊」會重新排到佇列最後。</p>
        <div className="table-wrap">
          <table aria-label="工作列表">
            <thead>
              <tr>
                <th scope="col" className="num">
                  工作 ID
                </th>
                <th scope="col">種類</th>
                <th scope="col">狀態</th>
                <th scope="col">使用者</th>
                <th scope="col">GPU 群組</th>
                <th scope="col">佇列</th>
                <th scope="col">建立時間</th>
                <th scope="col">開始時間</th>
                <th scope="col">結束時間</th>
                <th scope="col">訊息</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.loading && !jobs.data && (
                <tr>
                  <td colSpan={11} role="status">
                    載入中…
                  </td>
                </tr>
              )}
              {list.map((j) => (
                <tr key={j.id} data-status={j.status}>
                  <th scope="row" className="num">
                    {j.id}
                  </th>
                  <td>{QUEUE_KIND_LABELS[j.kind] ?? j.kind}</td>
                  <td>
                    <StatusBadge tone={STATUS_TONE[j.status] ?? 'neutral'}>{JOB_STATUS_LABELS[j.status] ?? j.status}</StatusBadge>
                  </td>
                  <td>{j.user}</td>
                  <td>{j.gpu_group ?? '—'}</td>
                  <td>{j.queue}</td>
                  <td>{formatTime(j.created_at)}</td>
                  <td>{formatTime(j.started_at)}</td>
                  <td>{formatTime(j.finished_at)}</td>
                  <td>{j.message || '—'}</td>
                  <td>
                    {isOpen(j.status) ? (
                      <div className="row-actions">
                        {j.status === 'queued' && (
                          <button
                            type="button"
                            className="btn btn--secondary btn--small"
                            aria-label={`暫存工作 ${j.id}`}
                            title="移出佇列並保存，稍後再恢復排隊（已開始執行的工作不能暫存）"
                            disabled={busy}
                            onClick={() => void queueAction(j, 'hold')}
                          >
                            暫存
                          </button>
                        )}
                        {j.status === 'held' && (
                          <button
                            type="button"
                            className="btn btn--primary btn--small"
                            aria-label={`恢復排隊工作 ${j.id}`}
                            disabled={busy}
                            onClick={() => void queueAction(j, 'resume')}
                          >
                            恢復排隊
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          aria-label={`取消工作 ${j.id}`}
                          onClick={() => {
                            setNotice(null);
                            setCancelError(null);
                            setCancelling(j);
                          }}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {jobs.data?.length === 0 && (
                <tr>
                  <td colSpan={11}>這個專案還沒有工作</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {cancelling && (
        <ConfirmDialog
          title="取消工作"
          confirmLabel="確定取消工作"
          cancelLabel="不要取消"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelling(null)}
        >
          <p>
            確定要取消工作 <strong>{cancelling.id}</strong>（{JOB_STATUS_LABELS[cancelling.status]}）嗎？取消後無法恢復。
          </p>
        </ConfirmDialog>
      )}
    </SchedulingPage>
  );
}
