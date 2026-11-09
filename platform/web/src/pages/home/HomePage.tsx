import { Link } from 'react-router-dom';
import { visibleNav, type NavArea } from '../../access/entries';
import type { Permission } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { formatTime } from '../../components/format';
import type { BadgeTone } from '../../components/StatusBadge';
import { Alert, Card, DicomThumb, Icon, PageHeader, ProgressBar, StatusBadge, Stepper, type Step } from '../../components/ui';
import { projectCover } from '../global/projectCover';
import { nextPendingStudy } from '../labeling/pending';
import { primaryText } from '../training/metrics';
import type { StudySummary } from '../labeling/types';
import type { OverviewTrainingRun, ProjectOverview } from './types';
import './home.css';

/** 各區在「可以做的事」的一句說明 */
const AREA_HINTS: Record<string, string> = {
  data: '加入或查看影像與結構式資料',
  labeling: '標註影像、確認 AI 標註的草稿',
  training: '用整理好的資料訓練模型',
  models: '看訓練結果、執行推論',
  llm: 'Chat with Knowledge Base 與大型語言模型設定',
};

const RUN_STATUS: Record<string, [string, BadgeTone]> = {
  queued: ['等待中', 'info'],
  pending: ['等待中', 'info'],
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
    <Card title="可以做的事" className="home-section">
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
    </Card>
  );
}

/** 資料→標註→結果步驟條（A01）：current＝第一個還沒完成的步驟 */
export function progressSteps(ov: ProjectOverview): { steps: Step[]; current: number } {
  const studies = ov.data?.studies ?? ov.labeling?.total_studies ?? 0;
  const tables = ov.data?.tabular_datasets ?? 0;
  const lab = ov.labeling;
  const results = ov.models?.length ?? 0;
  const done = [studies > 0 || tables > 0, !!lab && lab.pending === 0 && lab.confirmed > 0, results > 0];
  const steps: Step[] = [
    { label: '資料', description: tables > 0 ? `${studies} 筆影像、${tables} 份結構式資料` : `${studies} 筆影像` },
    { label: '標註', description: lab ? (lab.pending > 0 ? `進行中・還有 ${lab.pending} 筆` : `已確認 ${lab.confirmed} 筆`) : '—' },
    { label: '結果', description: ov.models ? (results > 0 ? `${results} 個模型可用` : '待產生') : '—' },
  ];
  const first = done.findIndex((d) => !d);
  return { steps, current: first < 0 ? steps.length : first };
}

function Progress({ ov }: { ov: ProjectOverview }) {
  const lab = ov.labeling;
  const total = lab?.total_studies ?? ov.data?.studies ?? 0;
  const { steps, current } = progressSteps(ov);
  return (
    <div className="home-progress">
      {lab && <ProgressBar value={lab.confirmed} max={total} label="已確認" />}
      <Stepper steps={steps} current={current} label="專案進度" />
    </div>
  );
}

const more = (text: string) => (
  <>
    {text} <Icon name="chevron-right" />
  </>
);

/** 專案首頁（A01）：先接著做，再看進度與最近結果。 */
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
  // 模型卡片的示意圖（裝飾用，依專案名稱挑；不是真實影像）
  const cover = projectCover({ name: project!.name });
  const last = ov?.labeling?.last ?? null;

  let headline = '';
  let sub: string | null = null;
  if (action.kind === 'label') {
    headline = `還有 ${action.pending} 筆影像待處理`;
    sub = last ? `上次處理 ${last.accession_number ?? last.study_instance_uid}・${formatTime(last.updated_at)}` : '包含還沒標的影像與 AI 標註的草稿';
  } else if (action.kind === 'result') {
    headline = '有剛完成的訓練結果';
    sub = '看測試結果，再決定要不要使用這個模型';
  } else if (action.kind === 'import') {
    headline = '這個專案還沒有資料';
    sub = '先匯入影像或結構式資料，才能開始標註與訓練';
  }

  const showRecent = can('labeling') && !!ov?.labeling;
  const showTraining = can('training') && !!ov?.training;
  const showModels = can('prediction') && !!ov?.models;
  const showPredictions = can('prediction') && !!ov?.predictions;

  return (
    <>
      <PageHeader title="專案首頁" subtitle={project!.name} />

      {overview.loading && !ov && <p role="status">載入中…</p>}
      {overview.error != null && !ov && (
        <Alert tone="warning">
          專案「{project!.name}」的進度暫時讀不到，請稍後重新整理。下面列出你可以做的事。
        </Alert>
      )}

      {ov && (
        <section className="ui-card home-hero" aria-labelledby="home-hero-title">
          <div className="home-hero__head">
            <div>
              <h2 id="home-hero-title" className="home-hero__title">
                {headline || '專案進度'}
              </h2>
              {sub && <p className="home-hero__sub">{sub}</p>}
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
                匯入資料 <Icon name="arrow" />
              </Link>
            )}
          </div>
          {(ov.data || ov.labeling) && <Progress ov={ov} />}
        </section>
      )}

      {(!ov || action.kind === 'none') && !overview.loading && <CanDo items={nav} />}

      {ov && (showRecent || showTraining || showModels || showPredictions) && (
        <div className="home-grid">
          {(showRecent || showTraining) && (
            <div className="home-grid__col home-grid__col--main">
              {showRecent && (
                <Card title="最近處理" flush extra={<Link to="/labeling">{more('查看全部')}</Link>}>
                  {last ? (
                    <div className="table-wrap">
                      <table aria-label="最近處理" className="home-table">
                        <thead>
                          <tr>
                            <th scope="col">影像縮圖</th>
                            <th scope="col">病例編號</th>
                            <th scope="col">處理時間</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>
                              <DicomThumb projectId={pid} studyUid={last.study_instance_uid} alt={`${last.accession_number ?? '影像'} 縮圖`} />
                            </td>
                            <th scope="row">
                              <Link to={`/labeling/studies/${encodeURIComponent(last.study_instance_uid)}`}>
                                {last.accession_number ?? last.study_instance_uid}
                              </Link>
                            </th>
                            <td>{formatTime(last.updated_at)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="home-pad text-muted">你還沒有存過標註。</p>
                  )}
                </Card>
              )}

              {showTraining && (
                <Card title="最近訓練" extra={<Link to="/training">{more('訓練紀錄')}</Link>}>
                  {ov.training!.recent.length === 0 ? (
                    <p className="text-muted">還沒有訓練。</p>
                  ) : (
                    <ul className="home-list">
                      {ov.training!.recent.map((r) => {
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
                </Card>
              )}
            </div>
          )}

          {(showModels || showPredictions) && (
            <div className="home-grid__col">
              {showModels && (
                <Card title="可使用的模型" extra={<Link to="/models">{more('查看全部')}</Link>}>
                  {ov.models!.length === 0 ? (
                    <p className="text-muted">還沒有完成的模型。</p>
                  ) : (
                    <ul className="home-models">
                      {ov.models!.slice(0, 3).map((m) => (
                        <li key={m.run_id} className="home-model">
                          <div className="home-model__row">
                            <img className="home-model__cover" src={cover.src} alt="" loading="lazy" />
                            <span className="home-model__text">
                              <span className="home-model__name">{m.name}</span>
                              {m.metric_name && m.metric_value != null && (
                                <span className="home-model__metric">{primaryText(m.metric_name, m.metric_value)}</span>
                              )}
                            </span>
                          </div>
                          <Link to={`/models/${m.run_id}/result`} className="btn btn--secondary btn--block" aria-label={`查看模型 ${m.name}`}>
                            查看模型
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}

              {showPredictions && (
                <Card title="最近預測" flush extra={<Link to="/models">{more('查看更多')}</Link>}>
                  {ov.predictions!.length === 0 ? (
                    <p className="home-pad text-muted">還沒有推論服務歷史紀錄。</p>
                  ) : (
                    <div className="table-wrap">
                      <table aria-label="最近預測" className="home-table">
                        <thead>
                          <tr>
                            <th scope="col">模型</th>
                            <th scope="col">預測時間</th>
                            <th scope="col">筆數</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ov.predictions!.map((p) => (
                            <tr key={p.id}>
                              <th scope="row">
                                <Link to={`/models/${p.run_id}/history`}>{p.model_name}</Link>
                              </th>
                              <td>{formatTime(p.created_at)}</td>
                              <td>{p.rows != null ? `${p.rows} 筆` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
