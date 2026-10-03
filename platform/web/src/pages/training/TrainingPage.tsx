// 建模管理（B-05）：訓練設定（5 種）、送出訓練與狀態、指標、模型匯出。需要目前專案的 Training 權限（入口規則）。
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { KIND_NAMES } from '../inference/api';
import { useTrainingApi, type Catalogue, type TrainingApi, type TrainingSetting } from './api';
import { SettingForm } from './SettingForm';
import { emptyForm, formFromSetting, suggestKind, type FormState } from './settingForm';
import type { TargetFeature } from '../tabular/types';
import { Runs } from './Runs';
import '../../styles/pages.css';
import './training.css';

export function TrainingPage() {
  const api = useTrainingApi();
  return (
    <>
      <h1>建模管理</h1>
      {api ? <Training key={api.projectId} api={api} /> : <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>}
      <section className="section" aria-labelledby="training-jobs">
        <h2 id="training-jobs">排程</h2>
        <Link to="/training/jobs" className="card link-card">
          <span className="link-card__title">專案工作</span>
          <span>查看訓練在 GPU 佇列的排隊與執行狀態、送出其他排程工作</span>
        </Link>
      </section>
    </>
  );
}

/** 從資料集頁「用這份資料建立訓練」進來（/training?dataset=ID）：帶入資料集、Target、Feature、前處理並預選種類。 */
async function formFromDataset(api: TrainingApi, cat: Catalogue, datasetId: number): Promise<{ form: FormState; notice: string }> {
  const [dataset, tf] = await Promise.all([api.dataset(datasetId), api.targetFeature(datasetId)]);
  const target = tf?.config.target ?? '';
  const column = dataset.columns.find((c) => c.name === target);
  const distinct = column?.kind === 'numeric' ? await api.distinct(datasetId, target).catch(() => null) : null;
  const kind = target ? suggestKind(column?.kind, distinct) : 'tabular_classification';
  const form = emptyForm(cat, kind);
  Object.assign(form, { name: `${dataset.name} 訓練`, datasetId: String(datasetId) });
  if (tf) Object.assign(form, { target, features: [...tf.config.features], steps: tf.config.steps });
  const kindName = cat.kinds.find((k) => k.kind === kind)?.name ?? kind;
  const notice = tf
    ? `已帶入資料集「${dataset.name}」的 Target（${target}）、${tf.config.features.length} 個 Feature 與 ${tf.config.steps.length} 個前處理步驟，並依目標欄位預選「${kindName}」。請確認後按「儲存設定」。`
    : `已選好資料集「${dataset.name}」。這個資料集還沒有設定 Target 與 Feature，請在下方選擇。`;
  return { form, notice };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 結構式設定與資料集目前的 Target／Feature／前處理不同時，回傳資料集的設定（可套用）。 */
function outdated(s: TrainingSetting, saved: Record<number, TargetFeature | null>): TargetFeature | null {
  if (s.config.source.type !== 'tabular' || !s.config.tabular) return null;
  const tf = saved[s.config.source.dataset_id];
  if (!tf) return null;
  const t = s.config.tabular;
  return same([t.target, t.features, t.steps], [tf.config.target, tf.config.features, tf.config.steps]) ? null : tf;
}

function Training({ api }: { api: TrainingApi }) {
  const { me } = useSession();
  const catalogue = useResource(() => api.catalogue(), [api]);
  const settings = useResource(() => api.settings(), [api]);
  const datasets = useResource(() => api.datasets().catch(() => []), [api]);
  const datasetIds = [...new Set((settings.data ?? []).flatMap((s) => (s.config.source.type === 'tabular' ? [s.config.source.dataset_id] : [])))];
  const saved = useResource(
    async () => Object.fromEntries(await Promise.all(datasetIds.map(async (id) => [id, await api.targetFeature(id).catch(() => null)] as const))),
    [api, datasetIds.join(','), settings.data],
  );
  const [params, setParams] = useSearchParams();
  const fromDataset = Number(params.get('dataset')) || null;
  const [mineOnly, setMineOnly] = useState(true);
  const [editor, setEditor] = useState<{ form: FormState; editing: TrainingSetting | null; key: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<TrainingSetting | null>(null);
  const [executor, setExecutor] = useState('template');
  const [runsNonce, setRunsNonce] = useState(0);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);

  useEffect(() => {
    if (!fromDataset || !catalogue.data) return;
    let cancelled = false;
    formFromDataset(api, catalogue.data, fromDataset).then(
      ({ form, notice: text }) => {
        if (cancelled) return;
        setEditor({ form, editing: null, key: Date.now() });
        setNotice(text);
        setParams({}, { replace: true });
      },
      (err: unknown) => !cancelled && setError(err),
    );
    return () => {
      cancelled = true;
    };
  }, [api, fromDataset, catalogue.data, setParams]);

  if (catalogue.error) return <ApiErrorAlert error={catalogue.error} />;
  if (!catalogue.data) return <p role="status">載入中…</p>;
  const cat: Catalogue = catalogue.data;
  const all = settings.data ?? [];
  const visible = all.filter((s) => !mineOnly || s.created_by === me?.username || s.updated_by === me?.username);
  const hidden = all.length - visible.length;
  const datasetName = (id: number) => datasets.data?.find((d) => d.id === id)?.name ?? `資料集 #${id}`;

  async function edit(s: TrainingSetting) {
    setError(null);
    setNotice('');
    try {
      const fresh = await api.setting(s.id); // 以伺服器存的版本為準
      setEditor({ form: formFromSetting(cat, fresh), editing: fresh, key: Date.now() });
    } catch (err) {
      setError(err);
    }
  }

  async function submit(s: TrainingSetting) {
    setError(null);
    setNotice('');
    try {
      const run = await api.submit(s.id, executor);
      setNotice(`已送出訓練 #${run.id}（${s.name}），目前排隊中。`);
      setSelectedRun(run.id);
      setRunsNonce((n) => n + 1);
    } catch (err) {
      setError(err);
    }
  }

  async function apply(s: TrainingSetting, tf: TargetFeature) {
    setError(null);
    setNotice('');
    try {
      const config = { ...s.config, tabular: { ...s.config.tabular!, target: tf.config.target, features: [...tf.config.features], steps: tf.config.steps } };
      await api.updateSetting(s.id, s.name, config);
      setNotice(`已把資料集目前的 Target、Feature 與前處理套用到「${s.name}」。`);
      settings.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await api.deleteSetting(deleting.id);
      setNotice(`已刪除訓練設定「${deleting.name}」。`);
      if (editor?.editing?.id === deleting.id) setEditor(null);
      settings.reload();
    } catch (err) {
      setError(err);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="stack">
      <section className="card section" aria-labelledby="settings-title">
        <div className="training-head">
          <h2 id="settings-title">訓練設定</h2>
          <button type="button" className="btn btn--primary"
            onClick={() => { setNotice(''); setEditor({ form: emptyForm(cat), editing: null, key: Date.now() }); }}>
            新增訓練設定
          </button>
        </div>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <ApiErrorAlert error={error ?? settings.error} />
        {settings.data && settings.data.length === 0 ? <p className="text-muted">還沒有訓練設定。按「新增訓練設定」開始，或從數據管理的資料集按「用這份資料建立訓練」。</p> : null}
        {settings.data && settings.data.length > 0 ? (
          <>
            <div className="row-actions">
              <label className="checkbox">
                <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
                只看我建立的
              </label>
              {mineOnly && hidden ? <span className="text-muted">（另有 {hidden} 份其他人的設定）</span> : null}
            </div>
            {me?.account_type === 'admin' && cat.executors.includes('fake') ? (
              <details className="training-details">
                <summary>開發測試選項（只有管理者看得到）</summary>
                <div className="field field--inline">
                  <label htmlFor="ts-executor">執行方式</label>
                  <select id="ts-executor" className="select" value={executor} onChange={(e) => setExecutor(e.target.value)}>
                    <option value="template">平台範本訓練</option>
                    <option value="fake">快速測試（fake-trainer，不做真正訓練）</option>
                  </select>
                </div>
              </details>
            ) : null}
            <div className="table-wrap">
              <table className="table" aria-label="訓練設定清單">
                <thead>
                  <tr>
                    <th scope="col">名稱</th>
                    <th scope="col">種類</th>
                    <th scope="col">資料</th>
                    <th scope="col">最後修改</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => {
                    const tf = outdated(s, saved.data ?? {});
                    return (
                    <tr key={s.id}>
                      <th scope="row">{s.name}</th>
                      <td>{KIND_NAMES[s.kind]}</td>
                      <td>
                        {s.config.source.type === 'tabular' ? datasetName(s.config.source.dataset_id) : '影像'}
                        {tf ? (
                          <span className="stack">
                            <span className="badge status-badge status-badge--warning">資料集設定已更新</span>
                            <button type="button" className="btn btn--small btn--secondary" onClick={() => void apply(s, tf)}>
                              套用資料集設定到「{s.name}」
                            </button>
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {s.updated_by}，{formatTime(s.updated_at)}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="btn btn--small btn--primary" onClick={() => void submit(s)}>
                          送出訓練「{s.name}」
                        </button>
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => void edit(s)}>
                          編輯「{s.name}」
                        </button>
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
          </>
        ) : null}
      </section>

      {editor ? (
        <SettingForm
          key={editor.key}
          api={api}
          catalogue={cat}
          initial={editor.form}
          editing={editor.editing}
          onCancel={() => setEditor(null)}
          onSaved={(s) => {
            setNotice(editor.editing ? `已儲存訓練設定「${s.name}」的修改。` : `已新增訓練設定「${s.name}」。`);
            setEditor(null);
            settings.reload();
          }}
        />
      ) : null}

      <Runs key={runsNonce} api={api} selected={selectedRun} onSelect={setSelectedRun} settings={all} />

      {deleting ? (
        <ConfirmDialog title="刪除訓練設定" confirmLabel="刪除" onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
          確定要刪除訓練設定「{deleting.name}」嗎？已送出的訓練與模型不受影響。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
