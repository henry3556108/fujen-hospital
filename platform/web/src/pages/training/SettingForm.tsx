// 訓練設定表單：5 種訓練；影像範圍、Label、Resize、切分、亂數種子、6 項資料增強、超參數；結構式的資料集、Target、Feature、演算法。
import { useEffect, useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import type { ParamSpec, TrainingApi, TrainingKind, TrainingSetting, Catalogue } from './api';
import { isImageKind } from './api';
import { changeAlgorithm, changeKind, configFromForm, hyperSpecs, type FormState } from './settingForm';

export const ALGORITHM_NAMES: Record<string, string> = {
  logistic_regression: '邏輯斯迴歸（Logistic Regression）',
  linear_regression: '線性迴歸（Linear Regression）',
  random_forest: '隨機森林（Random Forest）',
  gradient_boosting: '梯度提升（Gradient Boosting）',
};

const PROVIDERS: [string, string][] = [
  ['annotations', '影像標註平台（本專案的標註）'],
  ['makesense', 'MakeSense 匯入的標註'],
];

interface Props {
  api: TrainingApi;
  catalogue: Catalogue;
  initial: FormState;
  editing: TrainingSetting | null;
  onSaved: (setting: TrainingSetting) => void;
  onCancel: () => void;
}

export function SettingForm({ api, catalogue, initial, editing, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const image = isImageKind(form.kind);
  const kindEntry = catalogue.kinds.find((k) => k.kind === form.kind);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) return setError(new Error('請輸入設定名稱'));
    if (!image && !form.datasetId) return setError(new Error('請選擇結構式資料集'));
    if (image && form.sourceType === 'dicom' && form.studiesMode === 'selected' && form.studies.length === 0) {
      return setError(new Error('請至少勾選一個研究，或改選「全部研究」'));
    }
    setBusy(true);
    try {
      const config = configFromForm(catalogue, form);
      const saved = editing ? await api.updateSetting(editing.id, form.name.trim(), config) : await api.createSetting(form.name.trim(), config);
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={editing ? `修改訓練設定「${editing.name}」` : '新增訓練設定'} className="card section stack" onSubmit={submit} noValidate>
      <h2>{editing ? `修改訓練設定「${editing.name}」` : '新增訓練設定'}</h2>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="ts-name">設定名稱</label>
          <input id="ts-name" className="input" value={form.name} maxLength={128} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ts-kind">訓練種類</label>
          <select id="ts-kind" className="select" value={form.kind} onChange={(e) => setForm(changeKind(catalogue, form, e.target.value as TrainingKind))}>
            {catalogue.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.name}（{k.model_format.toUpperCase()}）
              </option>
            ))}
          </select>
        </div>
      </div>

      {image ? <ImageSource api={api} form={form} set={set} sourceTypes={kindEntry?.source_types ?? ['dicom']} /> : null}
      {!image ? <TabularSource api={api} form={form} setForm={setForm} catalogue={catalogue} /> : null}

      <fieldset>
        <legend>資料切分與亂數種子</legend>
        <div className="form-grid">
          <NumberField id="ts-train" label="訓練集（%）" value={form.train} onChange={(v) => set('train', v)} min={0} max={100} />
          <NumberField id="ts-validation" label="驗證集（%）" value={form.validation} onChange={(v) => set('validation', v)} min={0} max={100} />
          <NumberField id="ts-test" label="測試集（%）" value={form.test} onChange={(v) => set('test', v)} min={0} max={100} />
          <NumberField id="ts-seed" label="亂數種子" value={form.seed} onChange={(v) => set('seed', v)} min={0} />
        </div>
        <p className="field__hint">三者合計必須是 100%。同一份資料、設定與亂數種子會得到相同的切分與結果。</p>
      </fieldset>

      {image ? (
        <fieldset>
          <legend>資料增強（只套用在訓練資料）</legend>
          <ParamFields prefix="ts-aug" specs={catalogue.augmentation} values={form.augmentation} onChange={(v) => set('augmentation', v)} />
        </fieldset>
      ) : null}

      <fieldset>
        <legend>超參數</legend>
        <ParamFields prefix="ts-hp" specs={hyperSpecs(catalogue, form.kind, form.algorithm)} values={form.hyper} onChange={(v) => set('hyper', v)} />
      </fieldset>

      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '儲存中…' : editing ? '儲存修改' : '儲存設定'}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function NumberField({ id, label, value, onChange, min, max, step }: {
  id: string; label: string; value: string; onChange: (v: string) => void; min?: number | null; max?: number | null; step?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode="decimal" className="input" value={value} min={min ?? undefined} max={max ?? undefined}
        step={step ?? 'any'} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ParamFields({ prefix, specs, values, onChange }: {
  prefix: string; specs: ParamSpec[]; values: Record<string, string | boolean>; onChange: (v: Record<string, string | boolean>) => void;
}) {
  const numbers = specs.filter((s) => s.type !== 'bool');
  const flags = specs.filter((s) => s.type === 'bool');
  return (
    <>
      {numbers.length ? (
        <div className="form-grid">
          {numbers.map((s) => (
            <NumberField key={s.name} id={`${prefix}-${s.name}`} label={s.title} value={String(values[s.name] ?? '')} min={s.minimum} max={s.maximum}
              step={s.type === 'int' ? '1' : 'any'} onChange={(v) => onChange({ ...values, [s.name]: v })} />
          ))}
        </div>
      ) : null}
      {flags.length ? (
        <div className="checkbox-row">
          {flags.map((s) => (
            <label key={s.name} className="checkbox">
              <input type="checkbox" checked={Boolean(values[s.name])} onChange={(e) => onChange({ ...values, [s.name]: e.target.checked })} />
              {s.title}
            </label>
          ))}
        </div>
      ) : null}
    </>
  );
}

type Setter = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

function ImageSource({ api, form, set, sourceTypes }: { api: TrainingApi; form: FormState; set: Setter; sourceTypes: string[] }) {
  const studies = useResource(() => (form.sourceType === 'dicom' ? api.studies() : Promise.resolve([])), [api, form.sourceType]);
  const toggle = (uid: string) => set('studies', form.studies.includes(uid) ? form.studies.filter((s) => s !== uid) : [...form.studies, uid]);
  return (
    <fieldset>
      <legend>影像範圍與 Label</legend>
      <div className="stack">
        {sourceTypes.length > 1 ? (
          <div className="field">
            <label htmlFor="ts-source">資料來源</label>
            <select id="ts-source" className="select" value={form.sourceType} onChange={(e) => set('sourceType', e.target.value as FormState['sourceType'])}>
              <option value="dicom">DICOM 研究（Orthanc）</option>
              <option value="files">NIfTI／ITK 檔案（含遮罩）</option>
            </select>
          </div>
        ) : null}
        {form.sourceType === 'dicom' ? (
          <>
            <div className="checkbox-row" role="radiogroup" aria-label="影像範圍">
              <label className="checkbox">
                <input type="radio" name="ts-range" checked={form.studiesMode === 'all'} onChange={() => set('studiesMode', 'all')} />
                全部研究
              </label>
              <label className="checkbox">
                <input type="radio" name="ts-range" checked={form.studiesMode === 'selected'} onChange={() => set('studiesMode', 'selected')} />
                指定研究
              </label>
            </div>
            {form.studiesMode === 'selected' ? (
              <div role="group" aria-label="研究清單" className="training-studies">
                <ApiErrorAlert error={studies.error} />
                {studies.data && studies.data.length === 0 ? <p className="text-muted">這個專案還沒有影像研究。</p> : null}
                {(studies.data ?? []).map((s) => (
                  <label key={s.study_instance_uid} className="checkbox">
                    <input type="checkbox" checked={form.studies.includes(s.study_instance_uid)} onChange={() => toggle(s.study_instance_uid)} />
                    {s.accession_number ?? s.study_instance_uid}（{s.modalities.join('／') || '—'}，{s.study_description ?? '無說明'}）
                  </label>
                ))}
                {/* 已選但不在目前清單內的研究（例如已被刪除）仍保留在設定中 */}
                {form.studies
                  .filter((uid) => studies.data && !studies.data.some((s) => s.study_instance_uid === uid))
                  .map((uid) => (
                    <label key={uid} className="checkbox">
                      <input type="checkbox" checked onChange={() => toggle(uid)} />
                      {uid}（不在目前的研究清單）
                    </label>
                  ))}
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="ts-provider">標註來源</label>
              <select id="ts-provider" className="select" value={form.labelProvider} onChange={(e) => set('labelProvider', e.target.value)}>
                {PROVIDERS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
                {form.inlineSource ? <option value="inline">設定內附的對照表（inline，保留原設定）</option> : null}
              </select>
            </div>
          </>
        ) : (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ts-format">檔案格式</label>
              <select id="ts-format" className="select" value={form.filesFormat} onChange={(e) => set('filesFormat', e.target.value as 'nifti' | 'itk')}>
                <option value="nifti">NIfTI</option>
                <option value="itk">ITK（.mha）</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ts-cases">病例（每行一個，空白代表全部）</label>
              <textarea id="ts-cases" className="input" rows={3} value={form.cases} onChange={(e) => set('cases', e.target.value)} />
            </div>
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ts-labels">Label（以逗號分隔）</label>
            <input id="ts-labels" className="input" value={form.labels} aria-describedby="ts-labels-hint" onChange={(e) => set('labels', e.target.value)} />
            <span id="ts-labels-hint" className="field__hint">
              {form.kind === 'image_segmentation' ? '必填；順序對應遮罩值 1、2、…' : '留白代表使用標註中出現的全部 Label'}
            </span>
          </div>
          <NumberField id="ts-resize-h" label="Resize 高（像素）" value={form.resizeH} onChange={(v) => set('resizeH', v)} min={8} max={1024} step="1" />
          <NumberField id="ts-resize-w" label="Resize 寬（像素）" value={form.resizeW} onChange={(v) => set('resizeW', v)} min={8} max={1024} step="1" />
        </div>
      </div>
    </fieldset>
  );
}

function TabularSource({ api, form, setForm, catalogue }: {
  api: TrainingApi; form: FormState; setForm: (f: FormState | ((f: FormState) => FormState)) => void; catalogue: Catalogue;
}) {
  const datasets = useResource(() => api.datasets(), [api]);
  const detail = useResource(() => (form.datasetId ? api.dataset(Number(form.datasetId)) : Promise.resolve(null)), [api, form.datasetId]);
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const entry = catalogue.kinds.find((k) => k.kind === form.kind);

  // 選了資料集而且還沒有 Target 時，帶入資料集已存的 Target、Feature 與前處理步驟
  useEffect(() => {
    if (!form.datasetId || form.target) return;
    let cancelled = false;
    api.targetFeature(Number(form.datasetId)).then(
      (tf) => {
        if (cancelled || !tf) return;
        setForm((f) => (f.target ? f : { ...f, target: tf.config.target, features: [...tf.config.features], steps: tf.config.steps }));
        setPrefilled(form.datasetId);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, form.datasetId]);

  const columns = (detail.data?.columns ?? []).map((c) => c.name).filter((c) => c !== form.target);
  const toggle = (name: string) =>
    setForm((f) => ({ ...f, features: f.features.includes(name) ? f.features.filter((x) => x !== name) : [...f.features, name] }));

  return (
    <fieldset>
      <legend>資料集、Target 與 Feature</legend>
      <div className="stack">
        <ApiErrorAlert error={datasets.error ?? detail.error} />
        {datasets.data && datasets.data.length === 0 ? (
          <Alert tone="info">這個專案還沒有結構式資料集，請先到「數據管理」上傳 CSV。</Alert>
        ) : null}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ts-dataset">資料集</label>
            <select id="ts-dataset" className="select" value={form.datasetId}
              onChange={(e) => setForm((f) => ({ ...f, datasetId: e.target.value, target: '', features: [], steps: [] }))}>
              <option value="">請選擇</option>
              {(datasets.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}（{d.valid_rows} 列）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ts-target">目標欄位（Target）</label>
            <select id="ts-target" className="select" value={form.target} disabled={!detail.data}
              onChange={(e) => setForm((f) => ({ ...f, target: e.target.value, features: f.features.filter((x) => x !== e.target.value) }))}>
              <option value="">請選擇</option>
              {(detail.data?.columns ?? []).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ts-algorithm">演算法</label>
            <select id="ts-algorithm" className="select" value={form.algorithm} onChange={(e) => setForm(changeAlgorithm(catalogue, form, e.target.value))}>
              {(entry?.algorithms ?? []).map((a) => (
                <option key={a.name} value={a.name}>
                  {ALGORITHM_NAMES[a.name] ?? a.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {prefilled === form.datasetId ? <p className="field__hint">已帶入資料集設定的 Target、Feature 與前處理步驟。</p> : null}
        {detail.data ? (
          <div role="group" aria-label="特徵欄位（Feature）" className="checkbox-row">
            {columns.map((c) => (
              <label key={c} className="checkbox">
                <input type="checkbox" checked={form.features.includes(c)} onChange={() => toggle(c)} />
                {c}
              </label>
            ))}
          </div>
        ) : null}
        {form.steps.length ? (
          <p className="field__hint">
            前處理步驟 {form.steps.length} 個（在「數據管理」的資料集設定）：{form.steps.map((s) => s.id).join('、')}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
