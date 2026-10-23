// 建立模型（B-05）：外框與分頁（訓練紀錄／已存設定／程式與專案包），以及「已存設定」頁：
// 搜尋、套用（開建立訓練精靈帶入）、複製、修改、刪除；設定與資料集目前的設定不一致時列出差異並可套用。
import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { KIND_NAMES } from '../inference/api';
import { useTrainingApi, type Catalogue, type RunStatus, type TrainingApi, type TrainingSetting, type StageLock } from './api';
import { SettingForm } from './SettingForm';
import { useHasPermission } from './ModelExport';
import { stageNames } from './stages';
import { emptyForm, formFromSetting, settingDifference, type FormState } from './settingForm';
import type { TargetFeature } from '../tabular/types';
import '../../styles/pages.css';
import './training.css';

/** 建立模型的外框：標題與分頁；「程式與專案包」另需 Coding。 */
export function TrainingLayout() {
  const api = useTrainingApi();
  const canCode = useHasPermission('coding');
  const tabs = [
    { to: '/training', label: '訓練紀錄', end: true },
    { to: '/training/settings', label: '已存設定', end: false },
    ...(canCode ? [{ to: '/training/code', label: '程式與專案包', end: false }] : []),
  ];
  return (
    <>
      <h1>建立模型</h1>
      <nav aria-label="建立模型分頁" className="tabs">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="tabs__item">
            {t.label}
          </NavLink>
        ))}
      </nav>
      {api ? <Outlet /> : <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>}
    </>
  );
}

/** 舊網址 /training?dataset=ID（資料集頁「用這份資料建立訓練」）轉到精靈。 */
export function LegacyDatasetRedirect({ children }: { children: React.ReactNode }) {
  const [params] = useSearchParams();
  const dataset = params.get('dataset');
  if (dataset) return <Navigate to={`/training/new?tabular=${encodeURIComponent(dataset)}`} replace />;
  return <>{children}</>;
}

/** 已存設定頁。 */
export function SettingsPage() {
  const api = useTrainingApi();
  return api ? <Settings key={api.projectId} api={api} /> : null;
}

/** 舊名稱：已存設定頁。 */
export const TrainingPage = SettingsPage;

/** 結構式設定與資料集目前的設定真的不同時，回傳資料集的設定（可套用）與一句話說明差在哪裡。 */
function outdated(s: TrainingSetting, saved: Record<number, TargetFeature | null>): { tf: TargetFeature; text: string } | null {
  if (s.config.source.type !== 'tabular' || !s.config.tabular) return null;
  const tf = saved[s.config.source.dataset_id];
  if (!tf) return null;
  const text = settingDifference(s.config.tabular, tf.config);
  return text ? { tf, text } : null;
}

/** 剛送出的訓練：訊息跟著狀態更新，不會在完成後還寫「目前排隊中」。 */
export function submittedNotice(id: number, name: string, status: RunStatus): { text: string; tone: 'success' | 'info' | 'error' } {
  switch (status) {
    case 'running':
      return { text: `訓練 #${id}（${name}）訓練中，完成後會顯示結果。`, tone: 'info' };
    case 'succeeded':
      return { text: `訓練 #${id}（${name}）已完成。`, tone: 'success' };
    case 'failed':
      return { text: `訓練 #${id}（${name}）失敗，原因在下方。`, tone: 'error' };
    case 'cancelled':
      return { text: `訓練 #${id}（${name}）已取消。`, tone: 'info' };
    default:
      return { text: `已送出訓練 #${id}（${name}），目前排隊中。`, tone: 'success' };
  }
}

/** 搜尋：名稱、建立者、種類名稱。 */
export function matchSetting(s: Pick<TrainingSetting, 'name' | 'created_by' | 'updated_by' | 'kind'>, q: string): boolean {
  const text = q.trim().toLowerCase();
  if (!text) return true;
  return [s.name, s.created_by, s.updated_by, KIND_NAMES[s.kind]].some((v) => (v ?? '').toLowerCase().includes(text));
}

function Settings({ api }: { api: TrainingApi }) {
  const { me } = useSession();
  const catalogue = useResource(() => api.catalogue(), [api]);
  const settings = useResource(() => api.settings(), [api]);
  const datasets = useResource(() => api.datasets().catch(() => []), [api]);
  const datasetIds = [...new Set((settings.data ?? []).flatMap((s) => (s.config.source.type === 'tabular' ? [s.config.source.dataset_id] : [])))];
  const saved = useResource(
    async () => Object.fromEntries(await Promise.all(datasetIds.map(async (id) => [id, await api.targetFeature(id).catch(() => null)] as const))),
    [api, datasetIds.join(','), settings.data],
  );
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [mineOnly, setMineOnly] = useState(true);
  const [editor, setEditor] = useState<{ form: FormState; editing: TrainingSetting | null; key: number; locks?: StageLock[] } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<TrainingSetting | null>(null);

  if (catalogue.error) return <ApiErrorAlert error={catalogue.error} />;
  if (!catalogue.data) return <p role="status">載入中…</p>;
  const cat: Catalogue = catalogue.data;
  const all = settings.data ?? [];
  const mine = (s: TrainingSetting) => s.created_by === me?.username || s.updated_by === me?.username;
  const visible = all.filter((s) => (!mineOnly || mine(s)) && matchSetting(s, query));
  const others = all.filter((s) => !mine(s)).length;
  const datasetName = (id: number) => datasets.data?.find((d) => d.id === id)?.name ?? `資料集 #${id}`;

  async function act(work: () => Promise<string>) {
    setError(null);
    setNotice('');
    try {
      setNotice(await work());
    } catch (err) {
      setError(err);
    }
  }

  async function edit(s: TrainingSetting) {
    setError(null);
    setNotice('');
    try {
      const fresh = await api.setting(s.id); // 以伺服器存的版本為準
      // 由匯入檔控制的環節：表單上對應的欄位停用
      const locks = s.locked_stages?.length ? (await api.stages(s.id)).stages.flatMap((x) => (x.locked ? [x.locked] : [])) : [];
      setEditor({ form: formFromSetting(cat, fresh), editing: fresh, key: Date.now(), locks });
    } catch (err) {
      setError(err);
    }
  }

  /** 不改設定直接送出，送出後進入該次訓練頁。 */
  async function submit(s: TrainingSetting) {
    setError(null);
    try {
      const run = await api.submit(s.id, 'template');
      navigate(`/training/runs/${run.id}`, { state: { submitted: s.name } });
    } catch (err) {
      setError(err);
    }
  }

  function copy(s: TrainingSetting) {
    void act(async () => {
      const fresh = await api.setting(s.id);
      const out = await api.createSetting(`${fresh.name}（複本）`.slice(0, 128), fresh.config);
      settings.reload();
      return `已複製為「${out.name}」。`;
    });
  }

  function apply(s: TrainingSetting, tf: TargetFeature) {
    void act(async () => {
      const config = { ...s.config, tabular: { ...s.config.tabular!, target: tf.config.target, features: [...tf.config.features], steps: tf.config.steps,
        ...(tf.config.missing ? { missing: tf.config.missing } : {}) } };
      await api.updateSetting(s.id, s.name, config);
      settings.reload();
      return `已把資料集目前的欄位與前處理套用到「${s.name}」。`;
    });
  }

  function remove() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    void act(async () => {
      await api.deleteSetting(target.id);
      if (editor?.editing?.id === target.id) setEditor(null);
      settings.reload();
      return `已刪除訓練設定「${target.name}」。`;
    });
  }

  return (
    <div className="stack">
      <section className="card section stack" aria-labelledby="settings-title">
        <div className="training-head">
          <h2 id="settings-title">已存設定</h2>
          <div className="row-actions">
          <button type="button" className="btn btn--secondary" onClick={() => { setNotice(''); setEditor({ form: emptyForm(cat), editing: null, key: Date.now() }); }}>
            新增訓練設定
          </button>
          <Link className="btn btn--secondary" to="/training/new">
            建立訓練
          </Link>
          </div>
        </div>
        <p className="text-muted">每次送出訓練時都會一併存下設定。按「套用」會開啟建立訓練，帶入這份設定，確認後送出。</p>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <ApiErrorAlert error={error ?? settings.error} />
        <div className="row-actions">
          <div className="field">
            <label htmlFor="settings-search">搜尋設定</label>
            <input id="settings-search" className="input" type="search" value={query} placeholder="名稱、建立者或任務" onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            只看我建立的
          </label>
          {mineOnly && others > 0 ? <span className="text-muted">（另有 {others} 份其他人的設定）</span> : null}
        </div>
        {settings.data && all.length === 0 ? (
          <p className="text-muted">還沒有已存設定。按「建立訓練」送出第一次訓練，設定會自動存在這裡。</p>
        ) : null}
        {settings.data && all.length > 0 && visible.length === 0 ? <p className="text-muted">沒有符合條件的設定。</p> : null}
        {visible.length > 0 ? (
          <div className="table-wrap">
            <table className="table" aria-label="訓練設定清單">
              <thead>
                <tr>
                  <th scope="col">名稱</th>
                  <th scope="col">任務</th>
                  <th scope="col">資料</th>
                  <th scope="col">最後修改</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const locked = s.locked_stages ?? [];
                  // 標註或前處理由匯入檔控制時，不提供套用資料集設定（資料集的設定不影響這份訓練設定）
                  const diff = locked.includes('labels') || locked.includes('preprocess') ? null : outdated(s, saved.data ?? {});
                  return (
                    <tr key={s.id}>
                      <th scope="row">
                        {s.name}
                        {locked.length ? (
                          <span className="badge status-badge status-badge--info" data-testid="locked-stages">匯入控制：{stageNames(locked)}</span>
                        ) : null}
                      </th>
                      <td>{KIND_NAMES[s.kind]}</td>
                      <td>
                        {s.config.source.type === 'tabular' ? datasetName(s.config.source.dataset_id) : '影像'}
                        {diff ? (
                          <span className="stack">
                            <span className="badge status-badge status-badge--warning">與資料集設定不同</span>
                            <span className="field__hint" data-testid="setting-difference">{diff.text}</span>
                            <button type="button" className="btn btn--small btn--secondary" onClick={() => apply(s, diff.tf)}>
                              套用資料集設定到「{s.name}」
                            </button>
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {s.updated_by}，{formatTime(s.updated_at)}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => void submit(s)}>
                          送出訓練「{s.name}」
                        </button>
                        <Link className="btn btn--small btn--secondary" to={`/training/new?setting=${s.id}`}>
                          套用「{s.name}」
                        </Link>
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => copy(s)}>
                          複製「{s.name}」
                        </button>
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => void edit(s)}>
                          修改「{s.name}」
                        </button>
                          <Link className="btn btn--small" to={`/training/code?setting=${s.id}`}>
                            流程程式碼「{s.name}」
                          </Link>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setDeleting(s)}>
                          刪除「{s.name}」
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {editor ? (
        <SettingForm
          key={editor.key}
          api={api}
          catalogue={cat}
          initial={editor.form}
          editing={editor.editing}
          locks={editor.locks}
          onCancel={() => setEditor(null)}
          onSaved={(s) => {
            setNotice(editor.editing ? `已儲存訓練設定「${s.name}」的修改。` : `已新增訓練設定「${s.name}」。`);
            setEditor(null);
            settings.reload();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog title="刪除訓練設定" confirmLabel="刪除" onConfirm={remove} onCancel={() => setDeleting(null)}>
          確定要刪除訓練設定「{deleting.name}」嗎？已送出的訓練與模型不受影響。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
