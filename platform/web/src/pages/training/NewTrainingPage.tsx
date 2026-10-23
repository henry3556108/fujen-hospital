// 建立訓練精靈（/training/new）：選研究目的 → 確認資料 → 確認並送出。合併原本三套表單（建模管理的訓練設定、
// 標註頁「標註後直接訓練」、資料集頁「用這份資料建立訓練」）。送出時一併儲存設定，送出後直接進入該次訓練頁。
// query：?labelDataset=<id>、?tabular=<datasetId>、?from=<runId>、?setting=<id> 帶入預設值。
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { confirmLeave, useUnsavedChanges } from '../../components/unsaved';
import { featureCountText, missingText, stepLabel } from '../tabular/columnOverview';
import type { TargetFeature } from '../tabular/types';
import { isImageKind, useTrainingApi, type Catalogue, type LabelDataset, type TrainingApi, type TrainingKind, type TrainingSetting } from './api';
import { SettingForm } from './SettingForm';
import { emptyForm, formFromSetting, suggestKind, type FormState } from './settingForm';
import '../../styles/pages.css';
import './training.css';

/** 研究目的（第一步）：白話名稱與對應的訓練種類 */
export const PURPOSES: { kind: TrainingKind; title: string; hint: string }[] = [
  { kind: 'image_classification', title: '判斷影像類別', hint: '例如：有沒有結節、正常或異常（影像分類）' },
  { kind: 'image_detection', title: '圈出位置', hint: '在影像上用方框標出病灶位置（物件偵測）' },
  { kind: 'image_segmentation', title: '標出範圍', hint: '逐像素標出器官或病灶範圍（影像分割）' },
  { kind: 'tabular_classification', title: '表格資料：分類', hint: '用表格欄位預測類別，例如是否復發（表格分類）' },
  { kind: 'tabular_regression', title: '表格資料：預測數值', hint: '用表格欄位預測數字，例如住院天數（表格迴歸）' },
];

const TASK_OF: Partial<Record<TrainingKind, LabelDataset['task']>> = {
  image_classification: 'classification',
  image_detection: 'detection',
  image_segmentation: 'segmentation',
};
const KIND_OF_TASK: Record<LabelDataset['task'], TrainingKind> = {
  classification: 'image_classification',
  detection: 'image_detection',
  segmentation: 'image_segmentation',
};

const purposeTitle = (kind: TrainingKind) => PURPOSES.find((p) => p.kind === kind)?.title ?? kind;

/** 送出時會用哪一版：內容與最新版相同就沿用，不同就建立新版。 */
export function versionText(ds: Pick<LabelDataset, 'current' | 'latest_version'>): string {
  const latest = ds.latest_version;
  if (!latest) return '將以目前內容建立第 1 版';
  const same = latest.annotations === ds.current.annotations && JSON.stringify(sorted(latest.by_class)) === JSON.stringify(sorted(ds.current.by_class));
  return same ? `內容與第 ${latest.version} 版相同，將沿用第 ${latest.version} 版` : `將以目前內容建立第 ${latest.version + 1} 版`;
}

function sorted(o: Record<string, number>) {
  return Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** 送出前檢查標註資料集；有問題回傳說明。 */
export function labelDatasetProblem(kind: TrainingKind, ds: Pick<LabelDataset, 'current'> | null): string | null {
  if (!ds) return null;
  if (ds.current.annotations === 0) return '這份標註資料集還沒有已確認的標註，請先完成標註或確認 AI 草稿。';
  const classes = Object.entries(ds.current.by_class ?? {}).filter(([, n]) => n > 0);
  if (kind === 'image_classification' && classes.length < 2) {
    return `分類至少要有 2 個類別，目前只有 ${classes.length} 個（${classes.map(([c]) => c).join('、') || '無'}）。請補上其他類別的標註。`;
  }
  return null;
}

export function NewTrainingPage() {
  const api = useTrainingApi();
  return (
    <>
      <h1>建立訓練</h1>
      {api ? <Wizard key={api.projectId} api={api} /> : <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>}
    </>
  );
}

type Step = 1 | 2 | 3;

interface Start {
  step: Step;
  form: FormState;
  editing: TrainingSetting | null;
  notice: string;
}

/** 依 query 參數決定精靈的起點與預設值。 */
async function startFrom(api: TrainingApi, cat: Catalogue, params: URLSearchParams): Promise<Start> {
  const settingId = Number(params.get('setting')) || null;
  const fromRun = Number(params.get('from')) || null;
  const labelDataset = Number(params.get('labelDataset')) || null;
  const tabular = Number(params.get('tabular') ?? params.get('dataset')) || null;
  if (settingId) {
    const s = await api.setting(settingId);
    return { step: 3, form: formFromSetting(cat, s), editing: s, notice: `已套用已存設定「${s.name}」。送出時會一併儲存修改。` };
  }
  if (fromRun) {
    const run = await api.run(fromRun);
    const pseudo = { id: 0, name: `${run.name}（重新設定）`.slice(0, 128), kind: run.kind, config: run.config } as TrainingSetting;
    return { step: 2, form: formFromSetting(cat, pseudo), editing: null, notice: `已帶入訓練 #${run.id} 的設定，確認資料後再送出。` };
  }
  if (labelDataset) {
    const all = await api.labelDatasets().catch(() => []);
    const ds = all.find((d) => d.id === labelDataset);
    const kind = ds ? KIND_OF_TASK[ds.task] : 'image_classification';
    const form = emptyForm(cat, kind);
    Object.assign(form, { labelDatasetId: String(labelDataset), name: ds ? `${ds.name} 訓練` : '', labels: ds ? classesOf(ds).join(', ') : '' });
    return { step: 2, form, editing: null, notice: ds ? `已選好標註資料集「${ds.name}」。` : '' };
  }
  if (tabular) {
    const { form, notice } = await formFromDataset(api, cat, tabular);
    return { step: 2, form, editing: null, notice };
  }
  return { step: 1, form: emptyForm(cat), editing: null, notice: '' };
}

/** 從資料集帶入：資料集、想預測的欄位、用來預測的欄位、前處理，並依欄位預選分類或預測數值。 */
export async function formFromDataset(api: TrainingApi, cat: Catalogue, datasetId: number): Promise<{ form: FormState; notice: string }> {
  const [dataset, tf] = await Promise.all([api.dataset(datasetId), api.targetFeature(datasetId)]);
  const target = tf?.config.target ?? '';
  const column = dataset.columns.find((c) => c.name === target);
  const distinct = column?.kind === 'numeric' ? await api.distinct(datasetId, target).catch(() => null) : null;
  const kind = target ? suggestKind(column?.kind, distinct) : 'tabular_classification';
  const form = emptyForm(cat, kind);
  Object.assign(form, { name: `${dataset.name} 訓練`, datasetId: String(datasetId) });
  if (tf) Object.assign(form, { target, features: [...tf.config.features], steps: tf.config.steps, missing: tf.config.missing ?? form.missing });
  const notice = tf
    ? `已帶入資料集「${dataset.name}」的設定：要預測的結果 ${target}；用來預測的資料 ${featureCountText(tf.config.features, dataset.columns.map((c) => c.name), tf.config.steps)}` +
      `${missingText(tf.config.missing) ? `；${missingText(tf.config.missing)}` : ''}` +
      `${tf.config.steps.length ? `；前處理 ${tf.config.steps.length} 個步驟（${tf.config.steps.map(stepLabel).join(' → ')}）` : ''}。`
    : `已選好資料集「${dataset.name}」。這個資料集還沒設定想預測的欄位，可以先到「整理資料」設定，或在下一步的進階設定選擇。`;
  return { form, notice };
}

function Wizard({ api }: { api: TrainingApi }) {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const catalogue = useResource(() => api.catalogue(), [api]);
  const [start, setStart] = useState<Start | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [executor, setExecutor] = useState('template');
  const [formKey, setFormKey] = useState(0);
  // 送出訓練（建立版本、排入佇列）可能要幾秒：期間鎖住表單，避免重複送出
  const [submitting, setSubmitting] = useState(false);
  const query = params.toString();
  // 已選好研究目的或資料、還沒送出：離開前提醒（送出後導到訓練頁，元件卸載即取消登記）
  useUnsavedChanges(step > 1, '建立訓練還沒送出。');

  useEffect(() => {
    if (!catalogue.data) return;
    let cancelled = false;
    startFrom(api, catalogue.data, new URLSearchParams(query)).then(
      (s) => {
        if (cancelled) return;
        setStart(s);
        setForm(s.form);
        setStep(s.step);
      },
      (err: unknown) => !cancelled && setError(err),
    );
    return () => {
      cancelled = true;
    };
  }, [api, catalogue.data, query]);

  if (catalogue.error) return <ApiErrorAlert error={catalogue.error} />;
  if (error && !form) return <ApiErrorAlert error={error} />;
  if (!catalogue.data || !form || !start) return <p role="status">載入中…</p>;
  const cat = catalogue.data;
  const purposes = PURPOSES.filter((p) => cat.kinds.some((k) => k.kind === p.kind));
  const fakeAllowed = me?.account_type === 'admin' && cat.executors.includes('fake');

  async function submitRun(setting: TrainingSetting) {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const run = await api.submit(setting.id, executor);
      navigate(`/training/runs/${run.id}`, { state: { submitted: setting.name } });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <div className="stack">
      <ol className="wizard-steps" aria-label="建立訓練的步驟">
        {['選研究目的', '確認資料', '確認並送出'].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? 'wizard-steps__current' : undefined}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      {start.notice ? <Alert tone="info">{start.notice}</Alert> : null}
      <ApiErrorAlert error={error} />

      {step === 1 ? (
        <section className="card section stack" aria-labelledby="wizard-purpose">
          <h2 id="wizard-purpose">想讓模型做什麼？</h2>
          <div className="stack" role="radiogroup" aria-label="研究目的">
            {purposes.map((p) => (
              <label key={p.kind} className="checkbox">
                <input type="radio" name="purpose" checked={form.kind === p.kind}
                  onChange={() => setForm({ ...emptyForm(cat, p.kind), name: form.name })} />
                <span>
                  <strong>{p.title}</strong>
                  <span className="field__hint">{p.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn--primary" onClick={() => setStep(2)}>
              下一步：確認資料
            </button>
            <Link className="btn btn--secondary" to="/training">
              取消
            </Link>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <DataStep api={api} cat={cat} form={form} setForm={setForm} onBack={() => setStep(1)}
          onNext={() => { setFormKey((k) => k + 1); setStep(3); }} />
      ) : null}

      {step === 3 ? (
        <>
          <section className="card section" aria-label="這次訓練">
            <p>
              研究目的：<strong>{purposeTitle(form.kind)}</strong>
              <button type="button" className="btn btn--small" onClick={() => setStep(2)}>
                回上一步
              </button>
            </p>
          </section>
          {submitting ? <p role="status">正在送出訓練，完成後會打開這次訓練的頁面…</p> : null}
          <fieldset className="fieldset-plain" disabled={submitting}>
          <SettingForm
            key={formKey}
            api={api}
            catalogue={cat}
            initial={form}
            editing={start.editing}
            onCancel={() => confirmLeave('取消建立訓練') && navigate('/training')}
            onSaved={(s) => void submitRun(s)}
            wizard={{
              title: '確認並送出',
              submitLabel: '確認並送出訓練',
              check: (f) => splitProblem(f) ?? labelsProblem(f),
              extra: fakeAllowed ? (
                <div className="field field--inline">
                  <label htmlFor="wizard-executor">執行方式（開發測試，只有管理者看得到）</label>
                  <select id="wizard-executor" className="select" value={executor} onChange={(e) => setExecutor(e.target.value)}>
                    <option value="template">平台範本訓練</option>
                    <option value="fake">快速測試（fake-trainer，不做真正訓練）</option>
                  </select>
                </div>
              ) : null,
            }}
          />
          </fieldset>
        </>
      ) : null}
    </div>
  );
}

/** 切分比例：固定比例切分時三者合計要 100%，測試集要大於 0。 */
export function splitProblem(f: Pick<FormState, 'kind' | 'validationMethod' | 'train' | 'validation' | 'test'>): string | null {
  const test = Number(f.test);
  if (!(test > 0)) return '測試集要大於 0%，才能評估模型好不好。';
  if (isImageKind(f.kind) || f.validationMethod !== 'kfold') {
    const sum = Number(f.train) + Number(f.validation) + test;
    if (Math.abs(sum - 100) > 0.05) return `訓練、驗證、測試三者合計必須是 100%（目前 ${Math.round(sum * 10) / 10}%）。`;
  }
  return null;
}

function DataStep({ api, cat, form, setForm, onBack, onNext }: {
  api: TrainingApi; cat: Catalogue; form: FormState; setForm: (f: FormState) => void; onBack: () => void; onNext: () => void;
}) {
  const image = isImageKind(form.kind);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <section className="card section stack" aria-labelledby="wizard-data">
      <h2 id="wizard-data">確認資料：{purposeTitle(form.kind)}</h2>
      {image ? <ImageData api={api} form={form} setForm={setForm} /> : <TabularData api={api} cat={cat} form={form} setForm={setForm} />}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <div className="row-actions">
        <button type="button" className="btn btn--secondary" onClick={onBack}>
          上一步
        </button>
        <button type="button" className="btn btn--primary" disabled={checking}
          onClick={() => {
            setProblem(null);
            setChecking(true);
            dataProblem(api, form)
              .then((p) => (p ? setProblem(p) : onNext()))
              .catch(() => onNext())
              .finally(() => setChecking(false));
          }}>
          下一步：確認並送出
        </button>
      </div>
    </section>
  );
}

/** 第二步的檢查：結構式要選資料集，分類至少 2 類；影像分類的標註資料集至少 2 類。 */
async function dataProblem(api: TrainingApi, form: FormState): Promise<string | null> {
  if (isImageKind(form.kind)) {
    if (!form.labelDatasetId) return null;
    const ds = (await api.labelDatasets()).find((d) => String(d.id) === form.labelDatasetId) ?? null;
    return labelDatasetProblem(form.kind, ds);
  }
  if (!form.datasetId) return '請選擇資料集。';
  if (form.kind === 'tabular_classification' && form.target) {
    const n = await api.distinct(Number(form.datasetId), form.target);
    if (n < 2) return `想預測的欄位「${form.target}」只有 ${n} 種值，分類至少要有 2 類。請到「整理資料」換一個欄位。`;
  }
  return null;
}

function ImageData({ api, form, setForm }: { api: TrainingApi; form: FormState; setForm: (f: FormState) => void }) {
  const datasets = useResource(() => api.labelDatasets(), [api]);
  const task = TASK_OF[form.kind];
  const list = (datasets.data ?? []).filter((d) => d.task === task);
  const chosen = list.find((d) => String(d.id) === form.labelDatasetId) ?? null;
  if (datasets.error) {
    return (
      <Alert tone="info">
        目前無法讀取標註資料集，將使用本專案全部已確認的標註；要指定影像範圍與 Label，請在下一步的進階設定調整。
      </Alert>
    );
  }
  if (!datasets.data) return <p role="status">載入中…</p>;
  if (list.length === 0) {
    return (
      <Alert tone="info">
        這個專案還沒有這類任務的標註資料集。可以先到<Link to="/labeling/datasets">標註資料集</Link>建立，或直接下一步使用全部已確認的標註。
      </Alert>
    );
  }
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="wizard-label-dataset">標註資料集</label>
        <select id="wizard-label-dataset" className="select" value={form.labelDatasetId}
          onChange={(e) => {
            const ds = list.find((d) => String(d.id) === e.target.value);
            setForm({ ...form, labelDatasetId: e.target.value, name: form.name || (ds ? `${ds.name} 訓練` : ''),
              labels: ds ? classesOf(ds).join(', ') || form.labels : form.labels });
          }}>
          <option value="">不指定（使用全部已確認的標註）</option>
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}（{d.current.annotations} 筆標註）
            </option>
          ))}
        </select>
      </div>
      {chosen ? (
        <dl className="training-facts" data-testid="label-dataset-summary">
          <dt>版本</dt>
          <dd>{versionText(chosen)}</dd>
          <dt>研究數</dt>
          <dd>{chosen.current.studies}</dd>
          <dt>類別分布</dt>
          <dd>
            {Object.entries(chosen.current.by_class).map(([c, n]) => `${c} ${n} 筆`).join('、') || '—'}
          </dd>
          <dt>待確認</dt>
          <dd>{chosen.current.drafts_excluded ? `${chosen.current.drafts_excluded} 筆 AI 草稿還沒確認，不會用在這次訓練` : '沒有待確認的標註'}</dd>
        </dl>
      ) : null}
    </div>
  );
}

function TabularData({ api, cat, form, setForm }: { api: TrainingApi; cat: Catalogue; form: FormState; setForm: (f: FormState) => void }) {
  const datasets = useResource(() => api.datasets(), [api]);
  const tf = useResource<TargetFeature | null>(() => (form.datasetId ? api.targetFeature(Number(form.datasetId)) : Promise.resolve(null)), [api, form.datasetId]);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="stack">
      <ApiErrorAlert error={datasets.error ?? error} />
      {datasets.data && datasets.data.length === 0 ? (
        <Alert tone="info">
          這個專案還沒有表格資料集，請先到<Link to="/data/tabular">研究資料的表格</Link>加入 CSV。
        </Alert>
      ) : null}
      <div className="field">
        <label htmlFor="wizard-dataset">資料集</label>
        <select id="wizard-dataset" className="select" value={form.datasetId}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (!id) return setForm({ ...form, datasetId: '', target: '', features: [], steps: [] });
            setError(null);
            formFromDataset(api, cat, id).then(
              ({ form: next }) => setForm({ ...next, kind: form.kind, algorithm: form.kind === next.kind ? next.algorithm : form.algorithm,
                hyper: form.kind === next.kind ? next.hyper : form.hyper }),
              setError,
            );
          }}>
          <option value="">請選擇</option>
          {(datasets.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}（{d.valid_rows} 列）
            </option>
          ))}
        </select>
      </div>
      {form.datasetId && !tf.loading ? (
        tf.data ? (
          <dl className="training-facts" data-testid="tabular-summary">
            <dt>想預測的欄位</dt>
            <dd>{form.target || '—'}</dd>
            <dt>用來預測的欄位</dt>
            <dd>{form.features.length} 欄</dd>
            <dt>前處理</dt>
            <dd>{form.steps.length ? form.steps.map(stepLabel).join(' → ') : '沒有'}</dd>
          </dl>
        ) : (
          <Alert tone="warning">
            這個資料集還沒設定想預測的欄位。請先到<Link to={`/data/tabular/${form.datasetId}/prepare`}>整理資料</Link>設定，或在下一步的進階設定選擇。
          </Alert>
        )
      ) : null}
      <p className="field__hint">已存的欄位設定會帶進來；在下一步修改只影響這次訓練的設定，不會改到資料集。</p>
    </div>
  );
}

/** 標註資料集的類別：有指定就用指定的，否則用目前標註出現的類別（後端要求 image.labels 必填）。 */
export function classesOf(ds: Pick<LabelDataset, 'classes' | 'current'>): string[] {
  return ds.classes.length ? ds.classes : Object.keys(ds.current.by_class ?? {}).filter((c) => (ds.current.by_class[c] ?? 0) > 0);
}

/** 影像訓練要有類別（Label）：分類至少 2 類。選了標註資料集會自動帶入。 */
export function labelsProblem(f: Pick<FormState, 'kind' | 'labels'>): string | null {
  if (!isImageKind(f.kind)) return null;
  const labels = f.labels.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean);
  if (f.kind === 'image_classification' && labels.length < 2) return '分類至少要有 2 個類別。請選標註資料集，或在「進階設定」的 Label 填入類別（以逗號分隔）。';
  if (labels.length === 0) return '請選標註資料集，或在「進階設定」的 Label 填入類別。';
  return null;
}
