// 訓練紀錄：清單可依編號或主要分數排序、預設只看自己的；點「展開」在清單內看細節。
// 細節：圖示步驟條（進行中自動更新）、失敗原因（技術細節收合、前往修正）、結果與圖表、模型匯出、分享給同事使用（AI 模型部署）。
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { KIND_NAMES } from '../inference/api';
import { JOB_STATUS_LABELS } from '../scheduling/types';
import type { RunStatus, TrainingApi, TrainingRun, TrainingSetting } from './api';
import { primaryScore, splitFailure, verdict } from './metrics';
import { ModelExport, useHasPermission } from './ModelExport';
import { ResultView } from './ResultView';
import { RunSteps, STATUS_TEXT } from './RunSteps';

export const POLL_MS = 1500;

const TONE: Record<RunStatus, BadgeTone> = { queued: 'info', running: 'warning', succeeded: 'success', failed: 'error', cancelled: 'neutral' };
const LABELS: Record<RunStatus, string> = { ...JOB_STATUS_LABELS, running: '訓練中' };
const active = (s: RunStatus) => s === 'queued' || s === 'running';
const EXECUTORS: Record<string, string> = { fake: '快速測試', source: '修改後的原始碼' };

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusBadge tone={TONE[status] ?? 'neutral'}>{LABELS[status] ?? status}</StatusBadge>;
}

/** 巢狀指標攤平成「test.accuracy」；只留數值。 */
export function flatMetrics(metrics: Record<string, unknown>, prefix = ''): [string, number][] {
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(metrics ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatMetrics(v as Record<string, unknown>, `${prefix}${k}.`));
    else if (typeof v === 'number') out.push([`${prefix}${k}`, v]);
  }
  return out;
}

/** 清單的主要分數：與結果頁最上方的結論同一句（同一個數字、同一個等級）。 */
function scoreText(run: TrainingRun): string {
  return verdict(run)?.text ?? '—';
}

type Sort = { by: 'id' | 'score'; desc: boolean };

export function Runs({ api, selected, onSelect, settings }: {
  api: TrainingApi; selected: number | null; onSelect: (id: number | null) => void; settings: TrainingSetting[];
}) {
  const { me } = useSession();
  const runs = useResource(() => api.runs(), [api]);
  const { reload } = runs;
  const [mineOnly, setMineOnly] = useState(true);
  const [sort, setSort] = useState<Sort>({ by: 'id', desc: true });
  const hasActive = (runs.data ?? []).some((r) => active(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, reload]);

  const all = runs.data ?? [];
  const shown = all.filter((r) => !mineOnly || r.created_by === me?.username || r.id === selected);
  const value = (r: TrainingRun) => (sort.by === 'id' ? r.id : primaryScore(r)?.value ?? -Infinity);
  const list = [...shown].sort((a, b) => (sort.desc ? value(b) - value(a) : value(a) - value(b)) || b.id - a.id);
  const toggleSort = (by: Sort['by']) => setSort((s) => ({ by, desc: s.by === by ? !s.desc : true }));
  const ariaSort = (by: Sort['by']) => (sort.by === by ? (sort.desc ? 'descending' : 'ascending') : 'none');

  return (
    <section className="card section" aria-labelledby="runs-title">
      <div className="training-head">
        <h2 id="runs-title">訓練紀錄</h2>
        <div className="row-actions">
          <label className="checkbox">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            只看我送出的
          </label>
          <button type="button" className="btn btn--secondary btn--small" onClick={reload}>
            重新整理
          </button>
        </div>
      </div>
      <ApiErrorAlert error={runs.error} />
      {hasActive ? <p className="text-muted">有訓練在排隊或訓練中，狀態每 {POLL_MS / 1000} 秒自動更新。</p> : null}
      {runs.data && shown.length === 0 ? (
        <p className="text-muted">
          {all.length ? `沒有你送出的訓練（全部共 ${all.length} 筆，取消勾選「只看我送出的」可查看）。` : '還沒有訓練。在上方的訓練設定按「送出訓練」。'}
        </p>
      ) : null}
      {list.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="訓練清單">
            <thead>
              <tr>
                <th scope="col" aria-sort={ariaSort('id')}>
                  <button type="button" className="sort-button" onClick={() => toggleSort('id')}>
                    編號（依時間排序）
                  </button>
                </th>
                <th scope="col">設定名稱</th>
                <th scope="col">種類</th>
                <th scope="col">狀態</th>
                <th scope="col" aria-sort={ariaSort('score')}>
                  <button type="button" className="sort-button" onClick={() => toggleSort('score')}>
                    主要分數（依分數排序）
                  </button>
                </th>
                <th scope="col">建立</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const open = r.id === selected;
                return (
                  <Fragment key={r.id}>
                    <tr aria-current={open ? 'true' : undefined}>
                      <td>#{r.id}</td>
                      <td>{r.name}</td>
                      <td>
                        {KIND_NAMES[r.kind]}
                        {EXECUTORS[r.executor] ? <span className="text-muted">（{EXECUTORS[r.executor]}）</span> : null}
                      </td>
                      <td>
                        <RunStatusBadge status={r.status} />
                      </td>
                      <td>{scoreText(r)}</td>
                      <td>
                        {r.created_by}，{formatTime(r.created_at)}
                      </td>
                      <td>
                        <button type="button" className="btn btn--small" aria-expanded={open} onClick={() => onSelect(open ? null : r.id)}>
                          {open ? `收合訓練 #${r.id}` : `展開訓練 #${r.id}`}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="run-expanded">
                        <td colSpan={7}>
                          <RunDetail api={api} run={r} settings={settings} onChanged={reload} onSelect={onSelect} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** 設定所用的結構式資料集（前往修正用）；設定已刪除時為 null。 */
function datasetOf(run: TrainingRun, settings: TrainingSetting[]): number | null {
  const source = settings.find((s) => s.id === run.setting_id)?.config.source;
  return source?.type === 'tabular' ? source.dataset_id : null;
}

function RunDetail({ api, run, settings, onChanged, onSelect }: {
  api: TrainingApi; run: TrainingRun; settings: TrainingSetting[]; onChanged: () => void; onSelect: (id: number) => void;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const canDeploy = useHasPermission('prediction');
  const failure = run.status === 'failed' ? splitFailure(run.message) : null;
  const dataset = datasetOf(run, settings);

  async function act(call: () => Promise<unknown>) {
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack run-detail">
      <h3>
        訓練 #{run.id}：{run.name}
      </h3>
      <RunSteps status={run.status} runId={run.id} />
      <p data-testid="run-status" aria-live="polite">
        目前狀態：{STATUS_TEXT[run.status] ?? run.status}
      </p>
      {failure ? (
        <Alert tone="error" title="訓練失敗">
          <span className="stack">
            <span>{failure.reason}</span>
            {dataset !== null ? (
              <span>
                <Link to={`/data/tabular/${dataset}/target`}>前往修正：資料集的 Target／Feature 設定</Link>
                ，修改後回到這裡在訓練設定按「套用資料集設定」再送出。
              </span>
            ) : null}
            {failure.details ? (
              <details>
                <summary>技術細節（給資訊人員）</summary>
                <pre className="training-log">{failure.details}</pre>
              </details>
            ) : null}
          </span>
        </Alert>
      ) : null}
      {run.status !== 'failed' && run.message ? <Alert tone="info">{run.message}</Alert> : null}
      <ApiErrorAlert error={error} />
      {run.status === 'succeeded' ? (
        <ResultView
          api={api}
          run={run}
          actions={
            run.model_id === null ? null : canDeploy ? (
              <div className="row-actions">
                <Link className="btn btn--primary" to={`/inference?model=${run.model_id}`}>
                  用這個模型預測病人
                </Link>
                <Link className="btn btn--secondary" to={`/deployment?model=${run.model_id}`}>
                  分享給同事使用
                </Link>
              </div>
            ) : (
              <p className="text-muted">預測病人與分享模型需要 Prediction 權限，請聯絡專案負責人。</p>
            )
          }
        />
      ) : null}
      <details className="training-details">
        <summary>這次訓練的資料與設定</summary>
        <dl className="training-facts">
          <dt>種類</dt>
          <dd>{KIND_NAMES[run.kind]}</dd>
          <dt>驗證方式</dt>
          <dd>{run.config.validation?.method === 'kfold' ? `K 折交叉驗證（K = ${run.config.validation.folds}）` : '固定比例切分'}</dd>
          <dt>資料版本</dt>
          <dd>#{run.dataset_version_id}（送出當下凍結的資料，之後修改資料集不影響這次訓練）</dd>
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
      </details>
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
      {run.status === 'succeeded' && run.model_id !== null ? <ModelExport api={api} run={run} /> : null}
      {cancelling ? (
        <ConfirmDialog title="取消訓練" confirmLabel="確定取消"
          onConfirm={() => void act(async () => { await api.cancel(run.id); onChanged(); }).finally(() => setCancelling(false))}
          onCancel={() => setCancelling(false)}>
          確定要取消訓練 #{run.id}（{LABELS[run.status]}）嗎？取消後無法恢復。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
