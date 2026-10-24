// 訓練紀錄：所有訓練一張清單（合併原「專案工作」），可依狀態、種類、建立者、日期篩選；排隊中的顯示第幾位。
// 每列可取消（先確認）、查看進度或結果；失敗時顯示白話原因與「前往修正」。單次訓練的細節在 /training/runs/:runId（RunDetail）。
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { KIND_NAMES } from '../inference/api';
import { JOB_STATUS_LABELS } from '../scheduling/types';
import type { RunStatus, TrainingApi, TrainingKind, TrainingRun, TrainingSetting } from './api';
import { splitFailure, verdict } from './metrics';
import { ModelExport, useHasPermission } from './ModelExport';
import { ResultView } from './ResultView';
import { RunSteps, STATUS_TEXT } from './RunSteps';
import { stageNames } from './stages';

export const POLL_MS = 1500;
/** 訓練紀錄每頁筆數 */
export const RUN_PAGE = 20;

const TONE: Record<RunStatus, BadgeTone> = { queued: 'info', running: 'warning', succeeded: 'success', failed: 'error', cancelled: 'neutral', held: 'neutral' };
const LABELS: Record<RunStatus, string> = { ...JOB_STATUS_LABELS, running: '訓練中' };
const active = (s: RunStatus) => s === 'queued' || s === 'running';
/** 還沒結束、可以取消（含暫存） */
export const unfinished = (s: RunStatus) => active(s) || s === 'held';
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

/** 排隊中的訓練在本專案佇列的位置（依送出先後，1 起算）；不在排隊時沒有。 */
export function queuePositions(runs: Pick<TrainingRun, 'id' | 'status'>[]): Map<number, number> {
  const queued = runs.filter((r) => r.status === 'queued').sort((a, b) => a.id - b.id);
  return new Map(queued.map((r, i) => [r.id, i + 1]));
}

export interface RunFilter {
  status: '' | RunStatus;
  kind: '' | TrainingKind;
  creator: string;
  from: string;
  to: string;
}

export const EMPTY_FILTER: RunFilter = { status: '', kind: '', creator: '', from: '', to: '' };

/** 本地時間的日期（YYYY-MM-DD）。 */
function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 依篩選條件過濾；「排隊中」包含暫存；日期以建立日比較。 */
export function filterRuns(runs: TrainingRun[], f: RunFilter): TrainingRun[] {
  return runs.filter((r) => {
    if (f.status && (f.status === 'queued' ? !(r.status === 'queued' || r.status === 'held') : r.status !== f.status)) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (f.creator.trim() && !r.created_by.toLowerCase().includes(f.creator.trim().toLowerCase())) return false;
    if (f.from && dayOf(r.created_at) < f.from) return false;
    if (f.to && dayOf(r.created_at) > f.to) return false;
    return true;
  });
}

/** 失敗訓練「前往修正」的位置：結構式到資料集的整理資料，影像到標註資料集，其餘回到精靈帶入這次的設定。 */
export function fixLink(run: Pick<TrainingRun, 'id' | 'config' | 'label_dataset'>): { to: string; text: string } {
  const source = run.config?.source;
  if (source?.type === 'tabular') return { to: `/data/tabular/${source.dataset_id}/prepare`, text: '前往修正：資料集的整理資料' };
  if (run.label_dataset) return { to: `/labeling/datasets/${run.label_dataset.id}`, text: '前往修正：標註資料集' };
  return { to: `/training/new?from=${run.id}`, text: '前往修正：重新設定這次訓練' };
}

/** extra：清單下方的附加內容（Admin 在非正式環境的測試工作）。 */
export function Runs({ api, extra }: { api: TrainingApi; extra?: ReactNode }) {
  const [filter, setFilter] = useState<RunFilter>(EMPTY_FILTER);
  const [page, setPage] = useState(1);
  const runs = useResource(() => api.runs(), [api]);
  const { reload } = runs;
  const all = useMemo(() => [...(runs.data ?? [])].sort((a, b) => b.id - a.id), [runs.data]);
  const [cancelling, setCancelling] = useState<TrainingRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const hasActive = all.some((r) => active(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, reload]);

  const positions = queuePositions(all);
  const users = [...new Set(all.map((r) => r.created_by))];
  const filtered = filterRuns(all, filter);
  const total = filtered.length;
  const lastPage = Math.max(1, Math.ceil(total / RUN_PAGE));
  const current = Math.min(page, lastPage);
  const offset = (current - 1) * RUN_PAGE;
  const shown = filtered.slice(offset, offset + RUN_PAGE);
  const set = <K extends keyof RunFilter>(k: K, v: RunFilter[K]) => {
    setFilter((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const filtering = JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);

  async function cancel() {
    const target = cancelling;
    setCancelling(null);
    if (!target) return;
    setError(null);
    try {
      await api.cancel(target.id);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="card section stack" aria-labelledby="runs-title">
      <div className="training-head">
        <h2 id="runs-title">訓練紀錄</h2>
        <div className="row-actions">
          <button type="button" className="btn btn--secondary btn--small" onClick={reload}>
            重新整理
          </button>
        </div>
      </div>
      <div className="form-grid" role="group" aria-label="篩選訓練紀錄">
        <div className="field">
          <label htmlFor="runs-status">狀態</label>
          <select id="runs-status" className="select" value={filter.status} onChange={(e) => set('status', e.target.value as RunFilter['status'])}>
            <option value="">全部</option>
            <option value="queued">排隊中</option>
            <option value="running">訓練中</option>
            <option value="succeeded">已完成</option>
            <option value="failed">失敗</option>
            <option value="cancelled">已取消</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="runs-kind">任務</label>
          <select id="runs-kind" className="select" value={filter.kind} onChange={(e) => set('kind', e.target.value as RunFilter['kind'])}>
            <option value="">全部</option>
            {(Object.keys(KIND_NAMES) as TrainingKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_NAMES[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="runs-creator">建立者</label>
          <input id="runs-creator" className="input" list="runs-creators" value={filter.creator} onChange={(e) => set('creator', e.target.value)} />
          <datalist id="runs-creators">
            {users.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="runs-from">建立日期（起）</label>
          <input id="runs-from" type="date" className="input" value={filter.from} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="runs-to">建立日期（迄）</label>
          <input id="runs-to" type="date" className="input" value={filter.to} onChange={(e) => set('to', e.target.value)} />
        </div>
      </div>
      {filtering ? (
        <div className="row-actions">
          <button type="button" className="btn btn--small" onClick={() => { setFilter(EMPTY_FILTER); setPage(1); }}>
            清除篩選
          </button>
        </div>
      ) : null}
      <ApiErrorAlert error={runs.error ?? error} />
      {hasActive ? <p className="text-muted">有訓練在排隊或訓練中，狀態每 {POLL_MS / 1000} 秒自動更新。</p> : null}
      {runs.data && all.length === 0 ? (
        <p className="text-muted" data-testid="runs-empty">
          這個專案還沒有訓練。按「建立訓練」選好研究目的與資料，就能送出第一次訓練。
        </p>
      ) : null}
      {runs.data && all.length > 0 && total === 0 ? <p className="text-muted">沒有符合篩選條件的訓練。</p> : null}
      {total > 0 ? (
        <p className="text-muted" data-testid="runs-range">
          共 {total} 筆，這一頁是第 {offset + 1}–{offset + shown.length} 筆（每頁 {RUN_PAGE} 筆，由新到舊）。
        </p>
      ) : null}
      {total > RUN_PAGE ? (
        <nav className="row-actions" aria-label="訓練紀錄分頁">
          <button type="button" className="btn btn--secondary btn--small" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            上一頁
          </button>
          <span>
            第 {current} / {lastPage} 頁
          </span>
          <button type="button" className="btn btn--secondary btn--small" disabled={current >= lastPage} onClick={() => setPage(current + 1)}>
            下一頁
          </button>
        </nav>
      ) : null}
      {shown.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="訓練清單">
            <thead>
              <tr>
                <th scope="col">編號</th>
                <th scope="col">名稱</th>
                <th scope="col">任務</th>
                <th scope="col">狀態</th>
                <th scope="col">主要分數</th>
                <th scope="col">建立</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const failure = r.status === 'failed' ? splitFailure(r.message) : null;
                const pos = positions.get(r.id);
                return (
                  <tr key={r.id}>
                    <td>#{r.id}</td>
                    <td>{r.name}</td>
                    <td>
                      {KIND_NAMES[r.kind]}
                      {r.imported_stages?.length ? (
                        <span className="text-muted">（使用匯入的程式：{stageNames(r.imported_stages)}）</span>
                      ) : EXECUTORS[r.executor] ? <span className="text-muted">（{EXECUTORS[r.executor]}）</span> : null}
                    </td>
                    <td>
                      <RunStatusBadge status={r.status} />
                      {pos ? <span className="text-muted" data-testid="queue-position">（第 {pos} 位）</span> : null}
                      {failure ? (
                        <span className="field__hint" data-testid="run-failure">
                          {failure.reason}
                        </span>
                      ) : null}
                    </td>
                    <td>{scoreText(r)}</td>
                    <td>
                      {r.created_by}，{formatTime(r.created_at)}
                    </td>
                    <td className="row-actions">
                      <Link className="btn btn--small btn--secondary" to={`/training/runs/${r.id}`}>
                        {r.status === 'succeeded' ? `查看結果 #${r.id}` : `查看進度 #${r.id}`}
                      </Link>
                      {failure ? (
                        <Link className="btn btn--small" to={fixLink(r).to}>
                          前往修正 #{r.id}
                        </Link>
                      ) : null}
                      {unfinished(r.status) ? (
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setCancelling(r)}>
                          取消 #{r.id}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {extra}
      {cancelling ? (
        <ConfirmDialog title="取消訓練" confirmLabel="確定取消訓練" cancelLabel="不要取消" onConfirm={() => void cancel()} onCancel={() => setCancelling(null)}>
          確定要取消訓練 #{cancelling.id}（{LABELS[cancelling.status]}）嗎？取消後無法恢復。
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

/** 設定所用的結構式資料集（前往修正用）；設定已刪除時看這次訓練的設定。 */
function datasetOf(run: TrainingRun, settings: TrainingSetting[]): number | null {
  const source = settings.find((s) => s.id === run.setting_id)?.config.source ?? run.config?.source;
  return source?.type === 'tabular' ? source.dataset_id : null;
}

/** position：排隊中的位置（由呼叫端從訓練清單算出，避免多查一次）。 */
export function RunDetail({ api, run, settings, onChanged, onSelect, onSettingSaved, position }: {
  api: TrainingApi; run: TrainingRun; settings: TrainingSetting[]; onChanged: () => void; onSelect: (id: number) => void;
  onSettingSaved?: (setting: TrainingSetting, run: TrainingRun) => void;
  position?: number;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  // 另存設定：輸入的名稱（null＝沒有開啟）
  const [saveName, setSaveName] = useState<string | null>(null);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const canPredict = useHasPermission('prediction');
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
      <h2>
        訓練 #{run.id}：{run.name}
      </h2>
      <RunSteps status={run.status} runId={run.id} />
      <p data-testid="run-status" aria-live="polite">
        目前狀態：{STATUS_TEXT[run.status] ?? run.status}
        {position ? `（排在第 ${position} 位）` : ''}
      </p>
      {failure ? (
        <Alert tone="error" title="訓練失敗">
          <span className="stack">
            <span>{failure.reason}</span>
            {dataset !== null ? (
              <span>
                <Link to={`/data/tabular/${dataset}/prepare`}>前往修正：資料集的整理資料</Link>
                ，修改後到「已存設定」按「套用資料集設定」再送出。
              </span>
            ) : (
              <span>
                <Link to={fixLink(run).to}>{fixLink(run).text}</Link>
              </span>
            )}
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
            run.model_id === null ? null : canPredict ? (
              <div className="row-actions">
                <Link className="btn btn--primary" to={`/models/${run.id}/result`}>
                  前往使用模型
                </Link>
                <Link className="btn btn--secondary" to={`/models/${run.id}/predict`}>
                  用新資料測試
                </Link>
                <Link className="btn btn--secondary" to={`/models/${run.id}/share`}>
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
          <dd>
            {run.label_dataset ? `標註資料集「${run.label_dataset.name}」第 ${run.label_dataset.version} 版；` : ''}#{run.dataset_version_id}
            （送出當下凍結的資料，之後修改資料集不影響這次訓練）
          </dd>
          {run.test_count != null ? (
            <>
              <dt>測試筆數</dt>
              <dd>{run.test_count}</dd>
            </>
          ) : null}
          <dt>亂數種子</dt>
          <dd>{run.seed}</dd>
          <dt>開始</dt>
          <dd>{formatTime(run.started_at)}</dd>
          <dt>結束</dt>
          <dd>{formatTime(run.finished_at)}</dd>
          {run.parent_run_id ? (
            <>
              <dt>重跑自</dt>
              <dd>
                <Link to={`/training/runs/${run.parent_run_id}`}>#{run.parent_run_id}</Link>
              </dd>
            </>
          ) : null}
        </dl>
      </details>
      <div className="row-actions">
        {run.status === 'queued' ? (
          <button type="button" className="btn btn--secondary" title="移出佇列並保存，稍後再恢復排隊（已開始訓練的不能暫存）"
            onClick={() => void act(async () => { await api.hold(run.id); onChanged(); })}>
            暫存
          </button>
        ) : null}
        {run.status === 'held' ? (
          <button type="button" className="btn btn--secondary"
            onClick={() => void act(async () => { await api.resume(run.id); onChanged(); })}>
            恢復排隊
          </button>
        ) : null}
        {unfinished(run.status) ? (
          <button type="button" className="btn btn--danger" onClick={() => setCancelling(true)}>
            取消訓練
          </button>
        ) : (
          <button type="button" className="btn btn--secondary"
            onClick={() => void act(async () => { const r = await api.rerun(run.id); onChanged(); onSelect(r.id); })}>
            依原版本重跑
          </button>
        )}
        <button type="button" className="btn btn--secondary" onClick={() => void act(async () => setLog((await api.log(run.id)).log))}>
          檢視訓練輸出
        </button>
        <button type="button" className="btn btn--secondary" aria-expanded={saveName !== null}
          onClick={() => { setSavedAs(null); setSaveName(saveName === null ? `${run.name}（訓練 #${run.id}）`.slice(0, 128) : null); }}>
          另存設定
        </button>
      </div>
      {saveName !== null ? (
        <form className="row-actions" aria-label={`把訓練 #${run.id} 的設定另存為訓練設定`}
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const s = await api.saveAsSetting(run.id, saveName);
              setSaveName(null);
              setSavedAs(s.name);
              onSettingSaved?.(s, run);
            });
          }}>
          <label htmlFor={`save-as-${run.id}`}>新設定名稱</label>
          <input id={`save-as-${run.id}`} className="input" value={saveName} maxLength={128}
            onChange={(e) => setSaveName(e.target.value)} />
          <button type="submit" className="btn btn--secondary btn--small" disabled={!saveName.trim()}>
            儲存設定
          </button>
        </form>
      ) : null}
      {savedAs ? (
        <Alert tone="success">
          已另存為訓練設定「{savedAs}」，可在<Link to="/training/settings">已存設定</Link>套用（會重新凍結當時的資料）。
        </Alert>
      ) : null}
      {log !== null ? (
        <pre className="training-log" aria-label={`訓練 #${run.id} 的輸出`}>
          {log || '（還沒有輸出）'}
        </pre>
      ) : null}
      {run.status === 'succeeded' && run.model_id !== null ? <ModelExport api={api} run={run} /> : null}
      {cancelling ? (
        <ConfirmDialog title="取消訓練" confirmLabel="確定取消訓練" cancelLabel="不要取消"
          onConfirm={() => void act(async () => { await api.cancel(run.id); onChanged(); }).finally(() => setCancelling(false))}
          onCancel={() => setCancelling(false)}>
          確定要取消訓練 #{run.id}（{LABELS[run.status]}）嗎？取消後無法恢復。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
