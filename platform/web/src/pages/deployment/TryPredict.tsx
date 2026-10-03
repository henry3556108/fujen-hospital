// 試用預測：在部署頁填一位病人的資料，立即看模型的預測與陽性類別的機率（結構式模型）。
// 經「上傳推論」API 執行（需要 Prediction），結果與稽核都記在推論歷史。
import { useState, type FormEvent } from 'react';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { displayName, useInferenceApi, type Model, type ModelInput } from '../inference/api';
import { noteRest, percent, positiveLabel, sameLabel } from '../inference/positive';

function inputsOf(model: Model): ModelInput[] {
  if (model.card.inputs?.length) return model.card.inputs;
  return (model.card.features ?? []).map((name) => ({ name, type: 'number', min: null, max: null }));
}

type TryResult = { prediction: string; probability: string; note: string; positive?: string };

/**
 * 試用預測的結果句。二元分類一律說陽性類別的機率（「diagnosis＝1 的機率 6%（模型預測為「0」）」），
 * 多類別說預測類別的機率；補過缺值時說補了什麼。
 */
export function resultText(model: Model, result: TryResult): string {
  if (result.prediction === '') return result.note || '無法預測';
  const target = model.card.target ?? '結果';
  const filled = noteRest(result.note);
  const positive = positiveLabel(model);
  let text: string;
  if (result.probability !== '' && positive !== null) {
    const p = Number(result.probability);
    const chance = result.positive !== undefined && result.positive !== '' ? Number(result.positive) : sameLabel(result.prediction, positive) ? p : 1 - p;
    text = `${target}＝${positive} 的機率 ${percent(chance)}（模型預測為「${result.prediction}」）`;
  } else if (result.probability !== '') {
    text = `${target} 預測為「${result.prediction}」的機率 ${percent(Number(result.probability))}`;
  } else {
    text = `${target} 的預測值：${result.prediction}`;
  }
  return filled ? `${text}。${filled}。` : `${text}。`;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * fixed：模型已選好（推論服務管理的「一位病人」），不顯示模型選單，標題改為「一位病人」。
 * onDone：預測完成後通知（例如重新載入預測紀錄）。
 */
export function TryPredict({ models, initial, fixed = false, onDone }: { models: Model[]; initial?: number; fixed?: boolean; onDone?: () => void }) {
  const api = useInferenceApi();
  const tabular = models.filter((m) => m.kind.startsWith('tabular_'));
  const [modelId, setModelId] = useState(String(tabular.find((m) => m.id === initial)?.id ?? tabular[0]?.id ?? ''));
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!api || tabular.length === 0) return null;
  const model = tabular.find((m) => String(m.id) === modelId) ?? tabular[0];
  const inputs = inputsOf(model);
  // 補值的模型：沒有的資料可以留白，會用訓練資料的中位數或最常見的值補上
  const fills = model.card.missing === 'impute';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    const empty = inputs.filter((i) => !(values[i.name] ?? '').trim()).map((i) => i.name);
    if (empty.length && !fills) return setError(new Error(`請填寫：${empty.join('、')}`));
    if (empty.length === inputs.length) return setError(new Error('請至少填一個欄位'));
    setBusy(true);
    try {
      const csv = `${inputs.map((i) => csvCell(i.name)).join(',')}\n${inputs.map((i) => csvCell((values[i.name] ?? '').trim())).join(',')}\n`;
      const record = await api!.upload(model.id, [new File([csv], 'try.csv', { type: 'text/csv' })], 'try');
      const table = record.result && 'rows' in record.result ? record.result : null;
      if (!table || !table.rows.length) throw new Error('推論服務沒有回傳結果');
      const at = (name: string) => table.columns.indexOf(name);
      const col = table.prediction_column;
      const row = table.rows[0];
      const cell = (name: string) => (at(name) >= 0 ? row[at(name)] ?? '' : '');
      setResult({ prediction: cell(col), probability: cell(`${col}_probability`), positive: cell(`${col}_positive_probability`), note: cell(`${col}_note`) });
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={fixed ? '一位病人' : '試用預測'} className="card section stack" onSubmit={submit} noValidate>
      <h2>{fixed ? '一位病人' : '試用預測'}</h2>
      <p className="text-muted">
        {fixed ? '填這位病人的資料後按「預測」。' : '填一位病人的資料，看模型會怎麼預測。結果會記在「推論服務管理」的預測紀錄。'}
        {fills ? '沒有的資料可以留白，會用訓練資料的中位數（類別用最常見的值）補上。' : ''}
      </p>
      {fixed ? null : (
        <div className="field">
          <label htmlFor="try-model">模型</label>
          <select id="try-model" className="select" value={String(model.id)} onChange={(e) => { setModelId(e.target.value); setValues({}); setResult(null); }}>
            {tabular.map((m) => (
              <option key={m.id} value={m.id}>
                {displayName(m)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="form-grid">
        {inputs.map((i) => (
          <div key={i.name} className="field">
            <label htmlFor={`try-${i.name}`}>{i.name}</label>
            {i.type === 'category' ? (
              <select id={`try-${i.name}`} className="select" value={values[i.name] ?? ''} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
                <option value="">請選擇</option>
                {i.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`try-${i.name}`} type="number" inputMode="decimal" step="any" className="input" value={values[i.name] ?? ''}
                aria-describedby={i.min !== null ? `try-${i.name}-hint` : undefined}
                onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} />
            )}
            {i.type === 'number' && i.min !== null ? (
              <span id={`try-${i.name}-hint`} className="field__hint">
                訓練資料的範圍：{i.min}～{i.max}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <ApiErrorAlert error={error} />
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '預測中…' : '預測'}
        </button>
      </div>
      {result ? (
        <Alert tone="info" title="預測結果">
          <span className="try-result" data-testid="try-result">
            {resultText(model, result)}
          </span>
        </Alert>
      ) : null}
    </form>
  );
}
