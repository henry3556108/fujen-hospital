import { Link } from 'react-router-dom';
import { visibleNav, type NavArea } from '../../access/entries';
import type { Permission } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { Icon } from '../../components/Icon';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { nextPendingStudy } from '../labeling/pending';
import { primaryText } from '../training/metrics';
import type { StudySummary } from '../labeling/types';
import type { OverviewTrainingRun, ProjectOverview } from './types';
import './home.css';

/** 各區在「可以做的事」的一句說明 */
const AREA_HINTS: Record<string, string> = {
  data: '加入或查看影像與表格資料',
  labeling: '標註影像、確認 AI 標註的草稿',
  training: '用整理好的資料訓練模型',
  models: '看模型結果、拿新資料預測',
  llm: '文件問答與語言模型設定',
};

const RUN_STATUS: Record<string, [string, BadgeTone]> = {
  queued: ['排隊中', 'info'],
  pending: ['排隊中', 'info'],
  running: ['處理中', 'info'],
  succeeded: ['已完成', 'success'],
  completed: ['已完成', 'success'],
  failed: ['失敗', 'error'],
  cancelled: ['已取消', 'neutral'],
  canceled: ['已取消', 'neutral'],
};

export function runStatusText(run: Pick<OverviewTrainingRun, 'status' | 'queue_position'>): [string, BadgeTone] {
  const [text, tone] = RUN_STATUS[run.status] ?? [run.status, 'neutral' as BadgeTone];
  if ((run.status === 'queued' || run.status === 'pending') && run.queue_position) return [`排隊第 ${run.queue_position} 位`, tone];
  return [text, tone];
}

const seenKey = (username: string, projectId: number) => `ai-platform.seen-runs.${username}.${projectId}`;

function readSeen(username: string, projectId: number): number[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(seenKey(username, projectId)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

function markSeen(username: string, projectId: number, runId: number) {
  try {
    const list = [...new Set([runId, ...readSeen(username, projectId)])].slice(0, 50);
    window.localStorage.setItem(seenKey(username, projectId), JSON.stringify(list));
  } catch {
    /* 無法儲存只影響「查看結果」按鈕會再出現 */
  }
}

export type PrimaryAction =
  | { kind: 'label'; to: string; pending: number }
  | { kind: 'result'; to: string; runId: number }
  | { kind: 'import'; to: string }
  | { kind: 'none' };

/**
 * 首頁最上面的主要按鈕（03 規格 3.4，依序判斷）。
 * 「繼續標註」打開下一筆待處理（nextUid，上次處理那筆之後的第一筆）；還不知道是哪筆時先到待處理清單。
 */
export function primaryAction(
  ov: ProjectOverview | null,
  permissions: Permission[],
  seenRuns: number[] = [],
  nextUid: string | null = null,
): PrimaryAction {
  if (!ov) return { kind: 'none' };
  const can = (p: Permission) => permissions.includes(p);
  if (can('labeling') && ov.labeling && ov.labeling.pending > 0) {
    const to = nextUid ? `/labeling/studies/${encodeURIComponent(nextUid)}` : '/labeling';
    return { kind: 'label', to, pending: ov.labeling.pending };
  }
  const unseen = (ov.training?.recent_completed ?? []).find((id) => !seenRuns.includes(id));
  if (can('training') && unseen !== undefined) return { kind: 'result', to: `/training/runs/${unseen}`, runId: unseen };
  if (can('labeling') && ov.data && ov.data.studies === 0 && ov.data.tabular_datasets === 0) {
    return { kind: 'import', to: '/data/imaging/import' };
  }
  return { kind: 'none' };
}

function CanDo({ items }: { items: NavArea[] }) {
  const list = items.filter((a) => a.key !== 'home');
  return (
    <section className="card section" aria-labelledby="home-cando">
      <h2 id="home-cando">可以做的事</h2>
      {list.length === 0 ? (
        <p className="text-muted">你在這個專案沒有可使用的功能，請聯絡專案負責人或系統管理者。</p>
      ) : (
        <ul className="home-cando">
          {list.map((a) => (
            <li key={a.key}>
              <Link to={a.path} className="home-cando__item">
                <Icon name={a.icon} />
                <span>
                  <span className="home-cando__title">{a.label}</span>
                  <span className="home-cando__desc">{AREA_HINTS[a.key]}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Progress({ ov }: { ov: ProjectOverview }) {
  const studies = ov.data?.studies ?? ov.labeling?.total_studies ?? 0;
  const lab = ov.labeling;
  const total = lab?.total_studies ?? studies;
  const pct = lab && total > 0 ? Math.min(100, Math.round((lab.confirmed / total) * 100)) : 0;
  const results = ov.models?.length ?? 0;
  const steps: { label: string; detail: string; done: boolean }[] = [
    {
      label: '資料',
      detail: ov.data ? `${ov.data.studies} 筆影像、${ov.data.tabular_datasets} 份表格` : `${studies} 筆影像`,
      done: studies > 0 || (ov.data?.tabular_datasets ?? 0) > 0,
    },
    {
      label: '標註',
      detail: lab ? (lab.pending > 0 ? `進行中，還有 ${lab.pending} 筆` : `已確認 ${lab.confirmed} 筆`) : '—',
      done: !!lab && lab.pending === 0 && lab.confirmed > 0,
    },
    { label: '結果', detail: ov.models ? (results > 0 ? `${results} 個模型可用` : '待產生') : '—', done: results > 0 },
  ];
  return (
    <div className="home-progress">
      {lab && (
        <>
          <p className="home-progress__count">
            已確認 <strong>{lab.confirmed}</strong> / {total}
          </p>
          <div
            className="home-progress__bar"
            role="progressbar"
            aria-label="標註進度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
      <ol className="home-steps" aria-label="專案進度">
        {steps.map((s, i) => (
          <li key={s.label} className={s.done ? 'home-steps__item home-steps__item--done' : 'home-steps__item'}>
            <span className="home-steps__dot" aria-hidden="true">
              {s.done ? <Icon name="success" /> : i + 1}
            </span>
            <span className="home-steps__label">
              {s.label}
              {s.done && <span className="visually-hidden">（完成）</span>}
            </span>
            <span className="home-steps__detail">{s.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 專案首頁（03 規格 3.4）：先接著做，再看進度與最近結果。 */
export function HomePage() {
  const me = useMe();
  const { api, project } = useSession();
  const pid = project!.id;
  const overview = useResource(() => api.get<ProjectOverview>(`/api/projects/${pid}/overview`), [pid]);
  const ov = overview.data;
  const permissions = project!.permissions;
  const can = (p: Permission) => permissions.includes(p);
  const seen = readSeen(me.username, pid);
  // 有待處理時讀研究清單，找出「繼續標註」要打開的那一筆（03 規格第一節醫師第 2 步）
  const pendingCount = can('labeling') ? (ov?.labeling?.pending ?? 0) : 0;
  const lastUid = ov?.labeling?.last?.study_instance_uid ?? null;
  const studies = useResource(
    () =>
      pendingCount > 0
        ? api.get<{ studies: StudySummary[] }>(`/api/projects/${pid}/labels/summary`).catch(() => null)
        : Promise.resolve(null),
    [pid, pendingCount],
  );
  const nextUid = nextPendingStudy(studies.data?.studies ?? [], lastUid)?.study_instance_uid ?? null;
  const action = primaryAction(ov, permissions, seen, nextUid);
  const nav = visibleNav(me, project);

  let headline = '';
  let sub: string | null = null;
  if (action.kind === 'label') {
    headline = `還有 ${action.pending} 筆影像待處理`;
    const last = ov?.labeling?.last;
    sub = last ? `上次處理 ${last.accession_number ?? last.study_instance_uid}・${formatTime(last.updated_at)}` : '包含還沒標的影像與 AI 標註的草稿';
  } else if (action.kind === 'result') {
    headline = '有剛完成的訓練結果';
    sub = '看測試結果，再決定要不要使用這個模型';
  } else if (action.kind === 'import') {
    headline = '這個專案還沒有資料';
    sub = '先加入影像或表格資料，才能開始標註與訓練';
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>專案首頁</h1>
          <p className="text-muted home-subtitle">{project!.name}</p>
        </div>
      </div>

      {overview.loading && !ov && <p role="status">載入中…</p>}
      {overview.error != null && !ov && (
        <Alert tone="warning">
          專案「{project!.name}」的進度暫時讀不到，請稍後重新整理。下面列出你可以做的事。
        </Alert>
      )}

      {ov && (
        <section className="card home-hero" aria-labelledby="home-hero-title">
          <div className="home-hero__head">
            <div>
              <h2 id="home-hero-title" className="home-hero__title">
                {headline || '專案進度'}
              </h2>
              {sub && <p className="text-muted">{sub}</p>}
            </div>
            {action.kind === 'label' && (
              <Link to={action.to} className="btn btn--primary btn--large">
                繼續標註 <Icon name="arrow" />
              </Link>
            )}
            {action.kind === 'result' && (
              <Link to={action.to} className="btn btn--primary btn--large" onClick={() => markSeen(me.username, pid, action.runId)}>
                查看結果 <Icon name="arrow" />
              </Link>
            )}
            {action.kind === 'import' && (
              <Link to={action.to} className="btn btn--primary btn--large">
                加入資料 <Icon name="arrow" />
              </Link>
            )}
          </div>
          {(ov.data || ov.labeling) && <Progress ov={ov} />}
        </section>
      )}

      {(!ov || action.kind === 'none') && !overview.loading && <CanDo items={nav} />}

      {ov && (
        <div className="home-grid">
          {can('labeling') && ov.labeling && (
            <section className="card" aria-labelledby="home-recent">
              <div className="home-card-head">
                <h2 id="home-recent">最近處理</h2>
                <Link to="/labeling">查看全部</Link>
              </div>
              {ov.labeling.last ? (
                <p>
                  <Link to={`/labeling/studies/${encodeURIComponent(ov.labeling.last.study_instance_uid)}`}>
                    {ov.labeling.last.accession_number ?? ov.labeling.last.study_instance_uid}
                  </Link>
                  <span className="text-muted">　{formatTime(ov.labeling.last.updated_at)}</span>
                </p>
              ) : (
                <p className="text-muted">你還沒有存過標註。</p>
              )}
            </section>
          )}

          {can('training') && ov.training && (
            <section className="card" aria-labelledby="home-training">
              <div className="home-card-head">
                <h2 id="home-training">最近訓練</h2>
                <Link to="/training">訓練紀錄</Link>
              </div>
              {ov.training.recent.length === 0 ? (
                <p className="text-muted">還沒有訓練。</p>
              ) : (
                <ul className="home-list">
                  {ov.training.recent.map((r) => {
                    const [text, tone] = runStatusText(r);
                    return (
                      <li key={r.id}>
                        <Link to={`/training/runs/${r.id}`}>{r.setting_name || `訓練 #${r.id}`}</Link>
                        <StatusBadge tone={tone}>{text}</StatusBadge>
                        <span className="text-muted">{formatTime(r.finished_at ?? r.created_at)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {can('prediction') && ov.models && (
            <section className="card" aria-labelledby="home-models">
              <div className="home-card-head">
                <h2 id="home-models">可以使用的模型</h2>
                <Link to="/models">查看全部</Link>
              </div>
              {ov.models.length === 0 ? (
                <p className="text-muted">還沒有完成的模型。</p>
              ) : (
                <ul className="home-list">
                  {ov.models.map((m) => (
                    <li key={m.run_id}>
                      <Link to={`/models/${m.run_id}/result`}>{m.name}</Link>
                      {m.metric_name && m.metric_value != null && (
                        <span className="text-muted">
                          {primaryText(m.metric_name, m.metric_value)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {can('prediction') && ov.predictions && (
            <section className="card" aria-labelledby="home-predictions">
              <div className="home-card-head">
                <h2 id="home-predictions">最近預測</h2>
                <Link to="/models">查看更多</Link>
              </div>
              {ov.predictions.length === 0 ? (
                <p className="text-muted">還沒有預測紀錄。</p>
              ) : (
                <ul className="home-list">
                  {ov.predictions.map((p) => (
                    <li key={p.id}>
                      <Link to={`/models/${p.run_id}/history`}>{p.model_name}</Link>
                      {p.rows != null && <span>{p.rows} 筆</span>}
                      <span className="text-muted">{formatTime(p.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}
