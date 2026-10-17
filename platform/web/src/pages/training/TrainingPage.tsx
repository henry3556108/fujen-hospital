// 建模管理（B-05）：訓練設定（5 種）、送出訓練與狀態、指標、模型匯出。需要目前專案的 Training 權限（入口規則）。
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { featureCountText, missingText, stepLabel } from '../tabular/columnOverview';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { KIND_NAMES } from '../inference/api';
import { useTrainingApi, type Catalogue, type RunStatus, type StageLock, type TrainingApi, type TrainingRun, type TrainingSetting } from './api';
import { SettingForm } from './SettingForm';
import { StagesPanel } from './StagesPanel';
import { PackageImport, mappingText } from './PackageImport';
import { useHasPermission } from './ModelExport';
import { stageNames } from './stages';
import { emptyForm, formFromSetting, settingDifference, suggestKind, type FormState } from './settingForm';
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
  if (tf) Object.assign(form, { target, features: [...tf.config.features], steps: tf.config.steps, missing: tf.config.missing ?? form.missing });
  const kindName = cat.kinds.find((k) => k.kind === kind)?.name ?? kind;
  const notice = tf
    ? `已帶入資料集「${dataset.name}」的設定：要預測的結果 ${target}；用來預測的資料 ${featureCountText(tf.config.features, dataset.columns.map((c) => c.name), tf.config.steps)}` +
      `${missingText(tf.config.missing) ? `；${missingText(tf.config.missing)}` : ''}` +
      `${tf.config.steps.length ? `；前處理 ${tf.config.steps.length} 個步驟（${tf.config.steps.map(stepLabel).join(' → ')}）` : ''}。` +
      `並依目標欄位預選「${kindName}」。請確認後按「儲存設定」。`
    : `已選好資料集「${dataset.name}」。這個資料集還沒有設定 Target 與 Feature，請在下方選擇。`;
  return { form, notice };
}

/** 結構式設定與資料集目前的設定真的不同時，回傳資料集的設定（可套用）與一句話說明差在哪裡。 */
function outdated(s: TrainingSetting, saved: Record<number, TargetFeature | null>): { tf: TargetFeature; text: string } | null {
  if (s.config.source.type !== 'tabular' || !s.config.tabular) return null;
  const tf = saved[s.config.source.dataset_id];
  if (!tf) return null;
  const text = settingDifference(s.config.tabular, tf.config);
  return text ? { tf, text } : null;
}

/** 剛送出的訓練：頂端的訊息跟著狀態更新，不會在完成後還寫「目前排隊中」。 */
export function submittedNotice(id: number, name: string, status: RunStatus): { text: string; tone: 'success' | 'info' | 'error' } {
  switch (status) {
    case 'running':
      return { text: `訓練 #${id}（${name}）訓練中，完成後下方會顯示結果。`, tone: 'info' };
    case 'succeeded':
      return { text: `訓練 #${id}（${name}）已完成，結果在下方「訓練紀錄」。`, tone: 'success' };
    case 'failed':
      return { text: `訓練 #${id}（${name}）失敗，原因在下方「訓練紀錄」。`, tone: 'error' };
    case 'cancelled':
      return { text: `訓練 #${id}（${name}）已取消。`, tone: 'info' };
    default:
      return { text: `已送出訓練 #${id}（${name}），目前排隊中。`, tone: 'success' };
  }
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
  const [editor, setEditor] = useState<{ form: FormState; editing: TrainingSetting | null; key: number; locks?: StageLock[] } | null>(null);
  // 流程程式碼（錄製巨集）：目前開啟的訓練設定
  const [flow, setFlow] = useState<TrainingSetting | null>(null);
  // 匯入整個流程（專案包）：需要 Coding 與 Training
  const canCode = useHasPermission('coding');
  const [importing, setImporting] = useState(false);
  const [notice, setNoticeText] = useState('');
  // 剛送出的訓練與它目前的狀態（其他訊息出現時清掉）
  const [submitted, setSubmitted] = useState<{ id: number; name: string; status: RunStatus } | null>(null);
  const setNotice = (text: string) => {
    setSubmitted(null);
    setNoticeText(text);
  };
  const onRuns = useCallback((runs: TrainingRun[]) => {
    setSubmitted((s) => {
      const run = s && runs.find((r) => r.id === s.id);
      return s && run && run.status !== s.status ? { ...s, status: run.status } : s;
    });
  }, []);
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
      // 由匯入檔控制的環節：表單上對應的欄位停用
      const locks = s.locked_stages?.length
        ? (await api.stages(s.id)).stages.flatMap((x) => (x.locked ? [x.locked] : []))
        : [];
      setEditor({ form: formFromSetting(cat, fresh), editing: fresh, key: Date.now(), locks });
    } catch (err) {
      setError(err);
    }
  }

  async function submit(s: TrainingSetting) {
    setError(null);
    setNotice('');
    try {
      const run = await api.submit(s.id, executor);
      setSubmitted({ id: run.id, name: s.name, status: 'queued' });
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
      const config = { ...s.config, tabular: { ...s.config.tabular!, target: tf.config.target, features: [...tf.config.features], steps: tf.config.steps,
        ...(tf.config.missing ? { missing: tf.config.missing } : {}) } };
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
      if (flow?.id === deleting.id) setFlow(null);
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
          <div className="row-actions">
            <button type="button" className="btn btn--primary"
              onClick={() => { setNotice(''); setEditor({ form: emptyForm(cat), editing: null, key: Date.now() }); }}>
              新增訓練設定
            </button>
            {canCode ? (
              <button type="button" className="btn btn--secondary" onClick={() => { setNotice(''); setError(null); setImporting(true); }}>
                匯入專案包
              </button>
            ) : null}
          </div>
        </div>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {submitted ? (
          <Alert tone={submittedNotice(submitted.id, submitted.name, submitted.status).tone}>
            {submittedNotice(submitted.id, submitted.name, submitted.status).text}
          </Alert>
        ) : null}
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
                            <button type="button" className="btn btn--small btn--secondary" onClick={() => void apply(s, diff.tf)}>
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
                        <button type="button" className="btn btn--small btn--secondary"
                          onClick={() => { setNotice(''); setError(null); setFlow(s); }}>
                          流程程式碼「{s.name}」
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
          locks={editor.locks}
          onCancel={() => setEditor(null)}
          onSaved={(s) => {
            setNotice(editor.editing ? `已儲存訓練設定「${s.name}」的修改。` : `已新增訓練設定「${s.name}」。`);
            setEditor(null);
            settings.reload();
          }}
        />
      ) : null}

      {importing ? (
        <PackageImport api={api} onClose={() => setImporting(false)}
          onImported={(out) => {
            setImporting(false);
            setNotice(`已匯入專案包，建立訓練設定「${out.setting.name}」。${mappingText(out.mapping)}` +
              (out.locked.length ? `由匯入檔控制的環節：${stageNames(out.locked)}。` : '') +
              (out.problem ? `需要處理：${out.problem}` : '可以送出訓練。'));
            settings.reload();
          }} />
      ) : null}

      {flow ? (
        <StagesPanel key={flow.id} api={api} setting={flow} onClose={() => setFlow(null)}
          onChanged={() => { setEditor(null); settings.reload(); }} />
      ) : null}

      <Runs key={runsNonce} api={api} selected={selectedRun} onSelect={setSelectedRun} settings={all} onRuns={onRuns}
        onSettingSaved={() => settings.reload()} />

      {deleting ? (
        <ConfirmDialog title="刪除訓練設定" confirmLabel="刪除" onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
          確定要刪除訓練設定「{deleting.name}」嗎？已送出的訓練與模型不受影響。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
