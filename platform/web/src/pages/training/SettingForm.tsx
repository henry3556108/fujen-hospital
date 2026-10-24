// 訓練設定表單：5 種訓練；影像範圍、Label、Resize、切分、亂數種子、6 項資料增強、超參數；結構式的資料集、Target、Feature、演算法。
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { Icon } from '../../components/Icon';
import { SegmentBar, SidePanel, SplitLayout } from '../../components/ui';
import type { ParamSpec, StageLock, TrainingApi, TrainingKind, TrainingSetting, Catalogue } from './api';
import { keepLocked, lockText } from './stages';
import { isImageKind } from './api';
import type { ColumnInfo } from '../tabular/types';
import { MissingChoiceField } from '../tabular/MissingChoiceField';
import { stepLabel } from '../tabular/columnOverview';
import {
  changeAlgorithm,
  changeKind,
  choiceChecked,
  choiceLabel,
  configFromForm,
  featureChoices,
  hyperSpecs,
  KFOLD_BELOW_ROWS,
  normaliseFeatures,
  suggestedValidation,
  toggleChoice,
  unknownFeatures,
  type FormState,
} from './settingForm';

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
  /** 由匯入檔控制的環節（流程程式碼）：對應的欄位停用 */
  locks?: StageLock[];
  /** 建立訓練精靈的第三步（設計稿 A06、B03）：不顯示種類（第一步已選），右側「送出前確認」放「開始訓練」與「儲存設定」，
   * 影像範圍、資料增強與超參數收在「進階設定」。 */
  wizard?: WizardOptions;
}

export interface WizardOptions {
  /** 送出鈕的名稱（畫面上寫「開始訓練」） */
  submitLabel: string;
  title: string;
  extra?: ReactNode;
  check?: (form: FormState) => string | null;
  /** 表單前面的小節（1. 研究目的、2. 確認資料） */
  lead?: ReactNode;
  /** 右側欄：拿到目前的表單內容與按鈕區，自己排版 */
  side?: (form: FormState, actions: ReactNode) => ReactNode;
  /** 「儲存設定」：只存設定不送出 */
  onSavedOnly?: (setting: TrainingSetting) => void;
}

export function SettingForm(props: Props) {
  return props.wizard ? <WizardSettingForm {...props} wizard={props.wizard} /> : <PlainSettingForm {...props} />;
}

/** 表單狀態與儲存（一般表單與精靈共用）。 */
function useSettingForm({ api, catalogue, initial, editing, onSaved, locks = [], wizard }: Props) {
  const lockedIds = locks.map((l) => l.stage);
  const labelsLocked = lockedIds.includes('labels');
  const preprocessLocked = lockedIds.includes('preprocess');
  const trainLocked = lockedIds.includes('train');
  const sourceLocked = lockedIds.includes('import');
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState<unknown>(null);
  // 'submit'：送出（或一般表單的儲存）中；'save'：精靈的「儲存設定」中
  const [busy, setBusy] = useState<'' | 'submit' | 'save'>('');
  const image = isImageKind(form.kind);
  const kindEntry = catalogue.kinds.find((k) => k.kind === form.kind);
  const kfold = !image && form.validationMethod === 'kfold';
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const processed = useProcessedColumns(api, image ? '' : form.datasetId, form.steps);
  // 驗證方式：新設定依資料列數預選（少於 1,000 列用 K 折）；使用者自己選過、或編輯既有設定時不自動改
  const [rows, setRows] = useState<number | null>(null);
  const [chosen, setChosen] = useState(editing !== null);
  useEffect(() => {
    if (chosen || image || rows === null) return;
    const method = suggestedValidation(rows);
    setForm((f) => (f.validationMethod === method ? f : { ...f, validationMethod: method, folds: method === 'kfold' ? '5' : f.folds }));
  }, [chosen, image, rows]);
  const suggested = !chosen && !image && rows !== null && suggestedValidation(rows) === 'kfold' && form.validationMethod === 'kfold';

  /** only：精靈的「儲存設定」（只存設定、不送出）。 */
  async function save(e?: FormEvent, only = false) {
    e?.preventDefault();
    setError(null);
    if (!form.name.trim()) return setError(new Error('請輸入設定名稱'));
    if (!image && !form.datasetId) return setError(new Error('請選擇結構式資料集'));
    const unknown = image ? [] : unknownFeatures(form.features, processed?.map((c) => c.name) ?? null);
    if (unknown.length) return setError(new Error(`Feature「${unknown.join('、')}」在資料集裡找不到，請取消勾選後再儲存。`));
    if (image && form.sourceType === 'dicom' && form.studiesMode === 'selected' && form.studies.length === 0) {
      return setError(new Error('請至少勾選一個研究，或改選「全部研究」'));
    }
    const problem = wizard?.check?.(form);
    if (problem) return setError(new Error(problem));
    setBusy(only ? 'save' : 'submit');
    try {
      const formConfig = configFromForm(catalogue, form);
      const config = editing ? keepLocked(formConfig, editing.config, lockedIds) : formConfig;
      const saved = editing ? await api.updateSetting(editing.id, form.name.trim(), config) : await api.createSetting(form.name.trim(), config);
      if (only) wizard?.onSavedOnly?.(saved);
      else onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  return {
    form, setForm, set, error, busy, image, kindEntry, kfold, processed, rows, setRows, setChosen, suggested, save,
    labelsLocked, preprocessLocked, trainLocked, sourceLocked, locks,
  };
}

type FormCtx = ReturnType<typeof useSettingForm>;

/** 驗證方式（結構式）：固定比例切分或 K 折交叉驗證。 */
function ValidationChoice({ ctx }: { ctx: FormCtx }) {
  const { form, set, kindEntry, trainLocked, setChosen, suggested, rows } = ctx;
  if (!kindEntry?.validation_methods) return null;
  return (
    <fieldset disabled={trainLocked}>
      <legend>驗證方式（怎麼檢查模型好不好）</legend>
      <div className="stack" role="radiogroup" aria-label="驗證方式">
        {kindEntry.validation_methods.map((m) => (
          <div key={m.method}>
            <label className="checkbox">
              <input type="radio" name="ts-validation" checked={form.validationMethod === m.method} aria-describedby={`ts-validation-${m.method}`}
                onChange={() => { setChosen(true); set('validationMethod', m.method); }} />
              <strong>{m.name}</strong>
            </label>
            <span id={`ts-validation-${m.method}`} className="field__hint">
              {m.help}
            </span>
          </div>
        ))}
      </div>
      {suggested ? (
        <p className="field__hint" data-testid="validation-suggestion">
          這份資料只有 {rows} 列（少於 {KFOLD_BELOW_ROWS.toLocaleString('en-US')} 列），已預選 K 折交叉驗證：每位病人都輪流當過檢查資料，分數比只切一次穩定。
        </p>
      ) : null}
    </fieldset>
  );
}

/** 切分比例欄位：K 折時只有折數與測試集。seed：一起顯示亂數種子。 */
function SplitFields({ ctx, seed, hints = true }: { ctx: FormCtx; seed: boolean; hints?: boolean }) {
  const { form, set, kfold } = ctx;
  const h = (text: string) => (hints ? text : undefined);
  return (
    <>
      {kfold ? (
        <NumberField id="ts-folds" label="交叉驗證折數（K）" value={form.folds} onChange={(v) => set('folds', v)} min={2} max={10} step="1"
          hint={h('資料平均分成幾份輪流檢查；一般用 5，資料很少時用 3。')} />
      ) : (
        <>
          <NumberField id="ts-train" label="訓練集（%）" value={form.train} onChange={(v) => set('train', v)} min={0} max={100}
            hint={h('給模型學習的資料。')} />
          <NumberField id="ts-validation" label="驗證集（%）" value={form.validation} onChange={(v) => set('validation', v)} min={0} max={100}
            hint={h('訓練時用來檢查、調整的資料。')} />
        </>
      )}
      <NumberField id="ts-test" label="測試集（%）" value={form.test} onChange={(v) => set('test', v)} min={0} max={100}
        hint={h('最後才用、模型完全沒看過的資料，用來評分。')} />
      {seed ? (
        <NumberField id="ts-seed" label="亂數種子" value={form.seed} onChange={(v) => set('seed', v)} min={0}
          hint="決定資料怎麼隨機分組的號碼。用同一個號碼重跑會得到完全相同的結果；一般不用改。" />
      ) : null}
    </>
  );
}

function PlainSettingForm(props: Props) {
  const { api, catalogue, editing, onCancel } = props;
  const ctx = useSettingForm(props);
  const { form, setForm, set, error, busy, image, kindEntry, kfold, processed, setRows, save, locks, labelsLocked, preprocessLocked, trainLocked, sourceLocked } = ctx;
  return (
    <form aria-label={editing ? `修改訓練設定「${editing.name}」` : '新增訓練設定'} className="card section stack" onSubmit={(e) => void save(e)} noValidate>
      <h2>{editing ? `修改訓練設定「${editing.name}」` : '新增訓練設定'}</h2>
      <ApiErrorAlert error={error} />
      <LocksNote locks={locks} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="ts-name">設定名稱</label>
          <input id="ts-name" className="input" value={form.name} maxLength={128} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ts-kind">訓練種類</label>
          <select id="ts-kind" className="select" value={form.kind} disabled={locks.length > 0} onChange={(e) => setForm(changeKind(catalogue, form, e.target.value as TrainingKind))}>
            {catalogue.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {image ? <ImageSource api={api} form={form} set={set} sourceTypes={kindEntry?.source_types ?? ['dicom']} labelsLocked={labelsLocked} preprocessLocked={preprocessLocked} sourceLocked={sourceLocked} /> : null}
      {!image ? <TabularSource api={api} form={form} setForm={setForm} catalogue={catalogue} processed={processed} onRows={setRows}
        disabled={labelsLocked || preprocessLocked} sourceLocked={sourceLocked} algorithmLocked={trainLocked} /> : null}

      {!image ? <ValidationChoice ctx={ctx} /> : null}

      <fieldset disabled={trainLocked}>
        <legend>資料切分與亂數種子</legend>
        <div className="form-grid">
          <SplitFields ctx={ctx} seed />
        </div>
        <p className="field__hint">
          {kfold ? '先保留測試集，其餘資料做 K 折交叉驗證。' : '訓練、驗證、測試三者合計必須是 100%。'}同一份資料、設定與亂數種子會得到相同的切分與結果。
        </p>
      </fieldset>

      <TrainingParams ctx={ctx} catalogue={catalogue} />

      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={Boolean(busy)}>
          {busy ? '儲存中…' : '儲存設定'}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 由匯入檔控制的環節（流程程式碼）：欄位已停用的說明。 */
function LocksNote({ locks }: { locks: StageLock[] }) {
  if (!locks.length) return null;
  return (
    <Alert tone="info" title="匯入控制">
      <span className="stack" data-testid="stage-locks">
        {locks.map((l) => (
          <span key={l.stage}>
            <Icon name="lock" className="stage-lock" /> {lockText(l)}
          </span>
        ))}
        <span>這些環節的欄位已停用。要修改請到訓練設定清單按「流程程式碼」，或在那裡改回用介面設定。</span>
      </span>
    </Alert>
  );
}

/** 資料增強（影像）與超參數。 */
function TrainingParams({ ctx, catalogue, extra }: { ctx: FormCtx; catalogue: Catalogue; extra?: ReactNode }) {
  const { form, set, image, preprocessLocked, trainLocked } = ctx;
  return (
    <>
      {image ? (
        <fieldset disabled={preprocessLocked}>
          <legend>資料增強（只套用在訓練資料）</legend>
          <ParamFields prefix="ts-aug" specs={catalogue.augmentation} values={form.augmentation} onChange={(v) => set('augmentation', v)} />
        </fieldset>
      ) : null}
      <fieldset disabled={trainLocked}>
        <legend>超參數（模型怎麼學）</legend>
        <p className="field__hint">每個欄位都有建議值，不確定就保留預設值。</p>
        <ParamFields prefix="ts-hp" specs={hyperSpecs(catalogue, form.kind, form.algorithm)} values={form.hyper} onChange={(v) => set('hyper', v)} />
      </fieldset>
      {extra}
    </>
  );
}

/**
 * 精靈第三步（設計稿 A06、B03、B04）：左側編號小節，右側「送出前確認」放設定名稱、「開始訓練」（送出）與「儲存設定」。
 * 影像：3. 設定資料分割比例；表格：2. 資料集、3. 目標、4. 特徵、5. 驗證方式、6. 演算法。其餘收在「進階設定」。
 */
function WizardSettingForm(props: Props & { wizard: WizardOptions }) {
  const { api, catalogue, onCancel, wizard } = props;
  const ctx = useSettingForm(props);
  const { form, setForm, set, error, busy, image, kfold, processed, setRows, save, locks, labelsLocked, preprocessLocked, trainLocked, sourceLocked } = ctx;
  const total = Number(form.train) + Number(form.validation) + Number(form.test);
  const actions = (
    <div className="trn-side-actions">
      <div className="field">
        <label htmlFor="ts-name">設定名稱</label>
        <input id="ts-name" className="input" value={form.name} maxLength={128} onChange={(e) => set('name', e.target.value)} />
      </div>
      <ApiErrorAlert error={error} />
      {/* 名稱保留「確認並送出訓練」（e2e 與既有測試），畫面上照設計稿寫「開始訓練」 */}
      <button type="submit" className="btn btn--primary" aria-label={wizard.submitLabel} disabled={Boolean(busy)}>
        {busy === 'submit' ? '送出中…' : '開始訓練'}
        {busy === 'submit' ? null : <Icon name="arrow" />}
      </button>
      {wizard.onSavedOnly ? (
        <button type="button" className="btn btn--secondary" disabled={Boolean(busy)} onClick={() => void save(undefined, true)}>
          {busy === 'save' ? '儲存中…' : '儲存設定'}
        </button>
      ) : null}
      <button type="button" className="btn btn--secondary" onClick={onCancel}>
        取消
      </button>
    </div>
  );
  const splitSection = (n: number) => (
    <section className="trn-section" aria-labelledby="ts-split-title">
      <h3 id="ts-split-title" className="trn-section__title">{n}. {image ? '設定資料分割比例' : '驗證方式'}</h3>
      <p className="trn-section__hint">{image ? '設定訓練、驗證與測試資料的比例' : '怎麼檢查模型好不好'}</p>
      {!image ? <ValidationChoice ctx={ctx} /> : null}
      <fieldset className="fieldset-plain" disabled={trainLocked}>
        <legend className="visually-hidden">資料切分</legend>
        <div className="trn-split-inputs">
          <SplitFields ctx={ctx} seed={false} hints={false} />
        </div>
        {!kfold && total > 0 ? (
          <SegmentBar label="資料分割比例" segments={[
            { label: '訓練資料', value: Number(form.train) || 0 },
            { label: '驗證資料', value: Number(form.validation) || 0 },
            { label: '測試資料', value: Number(form.test) || 0 },
          ]} />
        ) : null}
        <p className="field__hint">
          {kfold ? '先保留測試集，其餘資料做 K 折交叉驗證。' : '訓練、驗證、測試三者合計必須是 100%。'}
        </p>
      </fieldset>
    </section>
  );
  return (
    <form aria-label={wizard.title} className="trn-wizard-form" onSubmit={(e) => void save(e)} noValidate>
      <h2 className="visually-hidden">{wizard.title}</h2>
      <SplitLayout side={wizard.side ? wizard.side(form, actions) : <SidePanel title="送出前確認">{actions}</SidePanel>}>
        <div className="stack">
          <LocksNote locks={locks} />
          {wizard.lead}
          {image ? splitSection(3) : (
            <>
              <TabularSource api={api} form={form} setForm={setForm} catalogue={catalogue} processed={processed} onRows={setRows}
                disabled={labelsLocked || preprocessLocked} sourceLocked={sourceLocked} algorithmLocked={trainLocked} layout="wizard" />
              {splitSection(5)}
              <section className="trn-section" aria-labelledby="ts-algorithm-title">
                <h3 id="ts-algorithm-title" className="trn-section__title">6. 選擇演算法</h3>
                <AlgorithmField catalogue={catalogue} form={form} setForm={setForm} disabled={trainLocked} />
              </section>
            </>
          )}
          {image ? (
            <Advanced on summary="進階設定：影像範圍、Label、Resize">
              <ImageSource api={api} form={form} set={set} sourceTypes={ctx.kindEntry?.source_types ?? ['dicom']} labelsLocked={labelsLocked} preprocessLocked={preprocessLocked} sourceLocked={sourceLocked} />
            </Advanced>
          ) : null}
          <Advanced on summary="進階設定：訓練回合、學習率、資料增強與其他超參數">
            <fieldset className="fieldset-plain" disabled={trainLocked}>
              <div className="form-grid">
                <NumberField id="ts-seed" label="亂數種子" value={form.seed} onChange={(v) => set('seed', v)} min={0}
                  hint="決定資料怎麼隨機分組的號碼。用同一個號碼重跑會得到完全相同的結果；一般不用改。" />
              </div>
            </fieldset>
            <TrainingParams ctx={ctx} catalogue={catalogue} extra={wizard.extra} />
          </Advanced>
        </div>
      </SplitLayout>
    </form>
  );
}

function AlgorithmField({ catalogue, form, setForm, disabled }: {
  catalogue: Catalogue; form: FormState; setForm: (f: FormState | ((f: FormState) => FormState)) => void; disabled?: boolean;
}) {
  const entry = catalogue.kinds.find((k) => k.kind === form.kind);
  return (
    <div className="field">
      <label htmlFor="ts-algorithm">演算法</label>
      <select id="ts-algorithm" className="select" value={form.algorithm} disabled={disabled} onChange={(e) => setForm(changeAlgorithm(catalogue, form, e.target.value))}>
        {(entry?.algorithms ?? []).map((a) => (
          <option key={a.name} value={a.name}>
            {ALGORITHM_NAMES[a.name] ?? a.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** on 時收進可展開的「進階設定」，否則照原樣顯示。 */
function Advanced({ on, summary, children }: { on: boolean; summary: string; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <details className="training-details">
      <summary>{summary}</summary>
      <div className="stack">{children}</div>
    </details>
  );
}

function NumberField({ id, label, value, onChange, min, max, step, hint, disabled }: {
  id: string; label: string; value: string; onChange: (v: string) => void; min?: number | null; max?: number | null; step?: string; hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode="decimal" className="input" value={value} min={min ?? undefined} max={max ?? undefined}
        step={step ?? 'any'} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
      {hint ? (
        <span id={`${id}-hint`} className="field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function ParamFields({ prefix, specs, values, onChange }: {
  prefix: string; specs: ParamSpec[]; values: Record<string, string | boolean>; onChange: (v: Record<string, string | boolean>) => void;
}) {
  const common = specs.filter((s) => !s.advanced);
  const advanced = specs.filter((s) => s.advanced);
  return (
    <>
      <ParamGroup prefix={prefix} specs={common} values={values} onChange={onChange} />
      {!common.length ? <p className="field__hint">這個演算法使用建議值即可，不需要調整。</p> : null}
      {advanced.length ? (
        <details className="training-details">
          <summary>進階設定（一般不需要調整）</summary>
          <ParamGroup prefix={prefix} specs={advanced} values={values} onChange={onChange} />
        </details>
      ) : null}
    </>
  );
}

function ParamGroup({ prefix, specs, values, onChange }: {
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
              step={s.type === 'int' ? '1' : 'any'} hint={paramHint(s)} onChange={(v) => onChange({ ...values, [s.name]: v })} />
          ))}
        </div>
      ) : null}
      {flags.length ? (
        <div className="stack">
          {flags.map((s) => (
            <div key={s.name}>
              <label className="checkbox">
                <input type="checkbox" checked={Boolean(values[s.name])} aria-describedby={s.help ? `${prefix}-${s.name}-hint` : undefined}
                  onChange={(e) => onChange({ ...values, [s.name]: e.target.checked })} />
                {s.title}
              </label>
              {s.help ? (
                <span id={`${prefix}-${s.name}-hint`} className="field__hint">
                  {s.help}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function paramHint(s: ParamSpec): string | undefined {
  const def = s.default === null || s.default === undefined ? '不限制' : String(s.default);
  return s.help ? `${s.help}（預設 ${def}）` : undefined;
}

type Setter = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

function ImageSource({ api, form, set, sourceTypes, labelsLocked, preprocessLocked, sourceLocked }: {
  api: TrainingApi; form: FormState; set: Setter; sourceTypes: string[]; labelsLocked?: boolean; preprocessLocked?: boolean;
  /** 資料匯入環節由匯入檔控制（資料來源、影像範圍、病例） */
  sourceLocked?: boolean;
}) {
  const studies = useResource(() => (form.sourceType === 'dicom' ? api.studies() : Promise.resolve([])), [api, form.sourceType]);
  const toggle = (uid: string) => set('studies', form.studies.includes(uid) ? form.studies.filter((s) => s !== uid) : [...form.studies, uid]);
  return (
    <fieldset>
      <legend>影像範圍與 Label</legend>
      <div className="stack">
        {sourceTypes.length > 1 ? (
          <div className="field">
            <label htmlFor="ts-source">資料來源</label>
            <select id="ts-source" className="select" value={form.sourceType} disabled={sourceLocked} onChange={(e) => set('sourceType', e.target.value as FormState['sourceType'])}>
              <option value="dicom">DICOM 研究（Orthanc）</option>
              <option value="files">NIfTI／ITK 檔案（含遮罩）</option>
            </select>
          </div>
        ) : null}
        {form.sourceType === 'dicom' ? (
          <>
            <fieldset className="fieldset-plain stack" disabled={sourceLocked}>
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
            </fieldset>
            <div className="field">
              <label htmlFor="ts-provider">標註來源</label>
              <select id="ts-provider" className="select" value={form.labelProvider} disabled={labelsLocked} onChange={(e) => set('labelProvider', e.target.value)}>
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
          <fieldset className="fieldset-plain form-grid" disabled={sourceLocked}>
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
          </fieldset>
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ts-labels">Label（以逗號分隔）</label>
            <input id="ts-labels" className="input" value={form.labels} disabled={labelsLocked} aria-describedby="ts-labels-hint" onChange={(e) => set('labels', e.target.value)} />
            <span id="ts-labels-hint" className="field__hint">
              {form.kind === 'image_segmentation' ? '必填；順序對應遮罩值 1、2、…' : '留白代表使用標註中出現的全部 Label'}
            </span>
          </div>
          <NumberField id="ts-resize-h" label="Resize 高（像素）" value={form.resizeH} onChange={(v) => set('resizeH', v)} min={8} max={1024} step="1" disabled={preprocessLocked} />
          <NumberField id="ts-resize-w" label="Resize 寬（像素）" value={form.resizeW} onChange={(v) => set('resizeW', v)} min={8} max={1024} step="1" disabled={preprocessLocked} />
        </div>
      </div>
    </fieldset>
  );
}

/** 資料集套用前處理步驟後的欄位；還不知道（沒選資料集、載入中、失敗）時為 null。 */
function useProcessedColumns(api: TrainingApi, datasetId: string, steps: FormState['steps']): ColumnInfo[] | null {
  const [columns, setColumns] = useState<{ key: string; columns: ColumnInfo[] } | null>(null);
  const key = `${datasetId}:${JSON.stringify(steps)}`;
  useEffect(() => {
    if (!datasetId) return;
    let cancelled = false;
    api.processedColumns(Number(datasetId), steps).then(
      (cols) => !cancelled && setColumns({ key, columns: cols }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  return datasetId && columns?.key === key ? columns.columns : null;
}

function TabularSource({ api, form, setForm, catalogue, processed, onRows, disabled, sourceLocked, algorithmLocked, layout = 'form' }: {
  api: TrainingApi; form: FormState; setForm: (f: FormState | ((f: FormState) => FormState)) => void; catalogue: Catalogue;
  processed: ColumnInfo[] | null;
  /** 選到的資料集有幾列（沒選時 null），用來預選驗證方式 */
  onRows: (rows: number | null) => void;
  /** 標註或前處理由匯入檔控制 */
  disabled?: boolean;
  /** 資料匯入環節由匯入檔控制（資料集） */
  sourceLocked?: boolean;
  /** 訓練環節由匯入檔控制（演算法） */
  algorithmLocked?: boolean;
  /** wizard：精靈的編號小節（2～4），演算法另外放 */
  layout?: 'form' | 'wizard';
}) {
  const datasets = useResource(() => api.datasets(), [api]);
  const chosenRows = datasets.data?.find((d) => String(d.id) === form.datasetId)?.valid_rows ?? null;
  useEffect(() => onRows(chosenRows), [chosenRows, onRows]);
  const detail = useResource(() => (form.datasetId ? api.dataset(Number(form.datasetId)) : Promise.resolve(null)), [api, form.datasetId]);
  const [prefilled, setPrefilled] = useState<string | null>(null);

  // 選了資料集而且還沒有 Target 時，帶入資料集已存的 Target、Feature 與前處理步驟
  useEffect(() => {
    if (!form.datasetId || form.target) return;
    let cancelled = false;
    api.targetFeature(Number(form.datasetId)).then(
      (tf) => {
        if (cancelled || !tf) return;
        setForm((f) => (f.target ? f : { ...f, target: tf.config.target, features: [...tf.config.features], steps: tf.config.steps,
          missing: tf.config.missing ?? f.missing }));
        setPrefilled(form.datasetId);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, form.datasetId]);

  const processedNames = processed?.map((c) => c.name) ?? null;
  const choices = detail.data ? featureChoices(detail.data.columns.map((c) => c.name), processedNames, form.steps, form.target) : [];
  const unknown = unknownFeatures(form.features, processedNames);
  // 舊設定可能同時存原始欄位（sex）與 One-Hot 步驟：換成 One-Hot 產生的欄位，畫面上只有一種選法
  const normalised = normaliseFeatures(form.features, choices);
  useEffect(() => {
    if (processed && JSON.stringify(normalised) !== JSON.stringify(form.features)) setForm((f) => ({ ...f, features: normalised }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processed, JSON.stringify(normalised)]);
  const textFeatures = (detail.data?.columns ?? [])
    .filter((c) => form.features.includes(c.name) && ['categorical', 'text', 'boolean'].includes(c.kind))
    .filter((c) => !form.steps.some((st) => st.id === 'onehot' && (st.columns ?? []).includes(c.name)))
    .map((c) => c.name);
  const encoded = choices.filter((c) => c.encoded && choiceChecked(c, form.features));
  // 選到的 Feature 有缺值時說出來，並讓使用者選補值或不使用（One-Hot 產生的欄位以原始欄位計）
  const gaps = (processed ?? []).filter((c) => c.missing > 0 && form.features.includes(c.name));
  const gapColumns = [...new Map(gaps.map((c) => {
    const owner = choices.find((ch) => ch.columns.includes(c.name))?.name ?? c.name;
    return [owner, { name: owner, missing: c.missing }] as const;
  })).values()];

  const datasetField = (
    <div className="field">
      <label htmlFor="ts-dataset">資料集</label>
      <select id="ts-dataset" className="select" value={form.datasetId} disabled={disabled || sourceLocked}
        onChange={(e) => setForm((f) => ({ ...f, datasetId: e.target.value, target: '', features: [], steps: [] }))}>
        <option value="">請選擇</option>
        {(datasets.data ?? []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}（{d.valid_rows} 列）
          </option>
        ))}
      </select>
    </div>
  );
  const targetField = (
    <div className="field">
      <label htmlFor="ts-target">要預測的結果（Target）</label>
      <select id="ts-target" className="select" value={form.target} disabled={disabled || !detail.data}
        onChange={(e) => setForm((f) => ({ ...f, target: e.target.value, features: f.features.filter((x) => x !== e.target.value) }))}>
        <option value="">請選擇</option>
        {(detail.data?.columns ?? []).map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
  const problems = (
    <>
      <ApiErrorAlert error={datasets.error ?? detail.error} />
      {datasets.data && datasets.data.length === 0 ? (
        <Alert tone="info">這個專案還沒有結構式資料集，請先到「數據管理」上傳 CSV。</Alert>
      ) : null}
    </>
  );
  const prefillNote = prefilled === form.datasetId ? <p className="field__hint">已帶入資料集設定的要預測的結果（Target）、用來預測的資料（Feature）與前處理步驟。</p> : null;
  const featurePart = (
    <>
      {textFeatures.length ? (
        <p className="field__hint" data-testid="text-features">
          「{textFeatures.join('、')}」是文字或類別欄位，訓練時會自動轉成 0／1 欄位（One-Hot），不需要先自己處理。
        </p>
      ) : null}
      {detail.data ? (
        <div role="group" aria-label="用來預測的資料（Feature）" className={layout === 'wizard' ? 'trn-chips' : 'checkbox-row'}>
          {choices.map((c) => (
            <label key={c.name} className="checkbox">
              <input type="checkbox" checked={choiceChecked(c, form.features)} disabled={disabled}
                onChange={() => setForm((f) => ({ ...f, features: toggleChoice(c, f.features) }))} />
              {choiceLabel(c)}
            </label>
          ))}
          {unknown.map((name) => (
            <label key={name} className="checkbox">
              <input type="checkbox" checked disabled={disabled} onChange={() => setForm((f) => ({ ...f, features: f.features.filter((x) => x !== name) }))} />
              {name}（資料集裡找不到）
            </label>
          ))}
        </div>
      ) : null}
      {encoded.length ? (
        <p className="field__hint" data-testid="encoded-features">
          {encoded.map((c) => `${c.name} 已在資料集設定轉成 ${c.columns.join('、')}`).join('；')}（One-Hot：把每個類別變成一個 0／1 欄位）。勾選「{encoded[0].name}」就會用到這些欄位。
        </p>
      ) : null}
      <fieldset className="fieldset-plain" disabled={disabled}>
        <MissingChoiceField id="ts" columns={gapColumns} value={form.missing} onChange={(v) => setForm((f) => ({ ...f, missing: v }))} />
      </fieldset>
      {unknown.length ? (
        <Alert tone="warning">
          <span data-testid="feature-problems">
            Feature「{unknown.join('、')}」在資料集裡找不到（資料集的前處理可能已修改），請取消勾選，或到「數據管理」重新設定。
          </span>
        </Alert>
      ) : null}
      {form.steps.length ? (
        <p className="field__hint">
          前處理步驟 {form.steps.length} 個（在「數據管理」的資料集設定）：{form.steps.map(stepLabel).join(' → ')}
        </p>
      ) : null}
    </>
  );

  // 精靈（設計稿 B03、B04）：2. 資料集、3. 目標、4. 特徵各一個小節；演算法由外層放在第 6 節
  if (layout === 'wizard') {
    return (
      <>
        <section className="trn-section" aria-labelledby="ts-dataset-title">
          <h3 id="ts-dataset-title" className="trn-section__title">2. 選擇資料集</h3>
          {problems}
          {datasetField}
          {prefillNote}
        </section>
        <section className="trn-section" aria-labelledby="ts-target-title">
          <h3 id="ts-target-title" className="trn-section__title">3. {form.kind === 'tabular_regression' ? '設定' : '選定'}要預測的欄位（目標）</h3>
          {form.kind === 'tabular_regression' ? <p className="trn-section__hint">非數值欄位不能設為迴歸的結果。</p> : null}
          {targetField}
        </section>
        <section className="trn-section" aria-labelledby="ts-feature-title">
          <h3 id="ts-feature-title" className="trn-section__title">4. 選擇用來預測的欄位（特徵）</h3>
          {featurePart}
        </section>
      </>
    );
  }

  return (
    <fieldset>
      <legend>資料集、要預測的結果與用來預測的資料</legend>
      <div className="stack">
        {problems}
        <div className="form-grid">
          {datasetField}
          {targetField}
          <AlgorithmField catalogue={catalogue} form={form} setForm={setForm} disabled={algorithmLocked} />
        </div>
        {prefillNote}
        {featurePart}
      </div>
    </fieldset>
  );
}
