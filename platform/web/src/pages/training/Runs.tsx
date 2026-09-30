// 訓練清單與單筆訓練：狀態（排隊中 → 執行中 → 完成／失敗，進行中自動更新）、指標、訓練輸出、取消、重跑、模型匯出。
import { useEffect, useState } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatNumber, formatTime } from '../../components/format';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { KIND_NAMES } from '../inference/api';
import { JOB_STATUS_LABELS } from '../scheduling/types';
import type { RunStatus, TrainingApi, TrainingRun } from './api';

export const POLL_MS = 1500;

const TONE: Record<RunStatus, BadgeTone> = { queued: 'info', running: 'warning', succeeded: 'success', failed: 'error', cancelled: 'neutral' };
const active = (s: RunStatus) => s === 'queued' || s === 'running';
const EXECUTORS: Record<string, string> = { template: '平台範本', fake: '快速測試', source: '修改後的原始碼' };

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusBadge tone={TONE[status] ?? 'neutral'}>{JOB_STATUS_LABELS[status] ?? status}</StatusBadge>;
}

/** 巢狀指標攤平成「test.accuracy」；只留數值，樣本數另列。 */
export function flatMetrics(metrics: Record<string, unknown>, prefix = ''): [string, number][] {
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(metrics ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatMetrics(v as Record<string, unknown>, `${prefix}${k}.`));
    else if (typeof v === 'number') out.push([`${prefix}${k}`, v]);
  }
  return out;
}

const isCount = (key: string) => /^(samples|rows)\.|^training_samples$/.test(key);

function metricSummary(run: TrainingRun): string {
  const scores = flatMetrics(run.metrics).filter(([k]) => !isCount(k));
  const shown = scores.filter(([k]) => k.startsWith('test.'));
  return (shown.length ? shown : scores).map(([k, v]) => `${k} ${formatNumber(v)}`).join('、') || '—';
}

export function Runs({ api, selected, onSelect }: { api: TrainingApi; selected: number | null; onSelect: (id: number) => void }) {
  const runs = useResource(() => api.runs(), [api]);
  const { reload } = runs;
  const hasActive = (runs.data ?? []).some((r) => active(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, reload]);

  const list = [...(runs.data ?? [])].reverse();
  const run = list.find((r) => r.id === selected) ?? null;

  return (
    <>
      <section className="card section" aria-labelledby="runs-title">
        <div className="training-head">
          <h2 id="runs-title">訓練紀錄</h2>
          <button type="button" className="btn btn--secondary btn--small" onClick={reload}>
            重新整理
          </button>
        </div>
        <ApiErrorAlert error={runs.error} />
        {hasActive ? <p className="text-muted">有訓練在排隊或執行中，狀態每 {POLL_MS / 1000} 秒自動更新。</p> : null}
        {runs.data && runs.data.length === 0 ? <p className="text-muted">還沒有訓練。在上方的訓練設定按「送出訓練」。</p> : null}
        {list.length > 0 ? (
          <div className="table-wrap">
            <table className="table" aria-label="訓練清單">
              <thead>
                <tr>
                  <th scope="col">編號</th>
                  <th scope="col">設定名稱</th>
                  <th scope="col">種類</th>
                  <th scope="col">狀態</th>
                  <th scope="col">指標</th>
                  <th scope="col">建立</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} aria-current={r.id === selected ? 'true' : undefined}>
                    <td>#{r.id}</td>
                    <td>{r.name}</td>
                    <td>
                      {KIND_NAMES[r.kind]}
                      <span className="text-muted">（{EXECUTORS[r.executor] ?? r.executor}）</span>
                    </td>
                    <td>
                      <RunStatusBadge status={r.status} />
                    </td>
                    <td>{metricSummary(r)}</td>
                    <td>
                      {r.created_by}，{formatTime(r.created_at)}
                    </td>
                    <td>
                      <button type="button" className="btn btn--small" onClick={() => onSelect(r.id)} disabled={r.id === selected}>
                        檢視訓練 #{r.id}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {run ? <RunDetail key={run.id} api={api} run={run} onChanged={reload} onSelect={onSelect} /> : null}
    </>
  );
}

function RunDetail({ api, run, onChanged, onSelect }: { api: TrainingApi; run: TrainingRun; onChanged: () => void; onSelect: (id: number) => void }) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const metrics = flatMetrics(run.metrics);

  async function act(call: () => Promise<unknown>) {
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="card section" aria-labelledby="run-title">
      <h2 id="run-title">
        訓練 #{run.id}：{run.name}
      </h2>
      <p data-testid="run-status">
        狀態：<RunStatusBadge status={run.status} />
      </p>
      {run.status === 'failed' ? <Alert tone="error" title="訓練失敗">{run.message || '訓練工作失敗'}</Alert> : null}
      {run.status !== 'failed' && run.message ? <Alert tone="info">{run.message}</Alert> : null}
      <ApiErrorAlert error={error} />
      <dl className="training-facts">
        <dt>種類</dt>
        <dd>{KIND_NAMES[run.kind]}</dd>
        <dt>資料版本</dt>
        <dd>#{run.dataset_version_id}</dd>
        <dt>亂數種子</dt>
        <dd>{run.seed}</dd>
        <dt>開始</dt>
        <dd>{formatTime(run.started_at)}</dd>
        <dt>結束</dt>
        <dd>{formatTime(run.finished_at)}</dd>
        {run.parent_run_id ? (
          <>
            <dt>重跑自</dt>
            <dd>#{run.parent_run_id}</dd>
          </>
        ) : null}
      </dl>
      {metrics.length ? (
        <div className="table-wrap">
          <table className="table" aria-label={`訓練 #${run.id} 的指標`}>
            <thead>
              <tr>
                <th scope="col">指標</th>
                <th scope="col">數值</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td>{formatNumber(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row-actions">
        {active(run.status) ? (
          <button type="button" className="btn btn--danger" onClick={() => setCancelling(true)}>
            取消訓練
          </button>
        ) : (
          <button type="button" className="btn btn--secondary"
            onClick={() => void act(async () => { const r = await api.rerun(run.id); onChanged(); onSelect(r.id); })}>
            以同一資料版本與種子重跑
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={() => void act(async () => setLog((await api.log(run.id)).log))}>
          檢視訓練輸出
        </button>
      </div>
      {log !== null ? (
        <pre className="training-log" aria-label={`訓練 #${run.id} 的輸出`}>
          {log || '（還沒有輸出）'}
        </pre>
      ) : null}
      {cancelling ? (
        <ConfirmDialog title="取消訓練" confirmLabel="確定取消"
          onConfirm={() => void act(async () => { await api.cancel(run.id); onChanged(); }).finally(() => setCancelling(false))}
          onCancel={() => setCancelling(false)}>
          確定要取消訓練 #{run.id}（{JOB_STATUS_LABELS[run.status]}）嗎？取消後無法恢復。
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
