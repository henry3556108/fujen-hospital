// 試用預測：在部署頁填一位病人的資料，立即看模型預測的類別與機率（結構式模型）。
// 經「上傳推論」API 執行（需要 Prediction），結果與稽核都記在推論歷史。
import { useState, type FormEvent } from 'react';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useInferenceApi, type Model, type ModelInput } from '../inference/api';

function inputsOf(model: Model): ModelInput[] {
  if (model.card.inputs?.length) return model.card.inputs;
  return (model.card.features ?? []).map((name) => ({ name, type: 'number', min: null, max: null }));
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function TryPredict({ models, initial }: { models: Model[]; initial?: number }) {
  const api = useInferenceApi();
  const tabular = models.filter((m) => m.kind.startsWith('tabular_'));
  const [modelId, setModelId] = useState(String(tabular.find((m) => m.id === initial)?.id ?? tabular[0]?.id ?? ''));
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ prediction: string; probability: string; note: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!api || tabular.length === 0) return null;
  const model = tabular.find((m) => String(m.id) === modelId) ?? tabular[0];
  const inputs = inputsOf(model);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    const empty = inputs.filter((i) => !(values[i.name] ?? '').trim()).map((i) => i.name);
    if (empty.length) return setError(new Error(`請填寫：${empty.join('、')}`));
    setBusy(true);
    try {
      const csv = `${inputs.map((i) => csvCell(i.name)).join(',')}\n${inputs.map((i) => csvCell(values[i.name].trim())).join(',')}\n`;
      const record = await api!.upload(model.id, [new File([csv], 'try.csv', { type: 'text/csv' })]);
      const table = record.result && 'rows' in record.result ? record.result : null;
      if (!table || !table.rows.length) throw new Error('推論服務沒有回傳結果');
      const at = (name: string) => table.columns.indexOf(name);
      const col = table.prediction_column;
      const row = table.rows[0];
      setResult({ prediction: row[at(col)] ?? '', probability: at(`${col}_probability`) >= 0 ? row[at(`${col}_probability`)] : '', note: row[at(`${col}_note`)] ?? '' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="試用預測" className="card section stack" onSubmit={submit} noValidate>
      <h2>試用預測</h2>
      <p className="text-muted">填一位病人的資料，看模型會怎麼預測。結果會記在「推論服務管理」的推論歷史。</p>
      <div className="field">
        <label htmlFor="try-model">模型</label>
        <select id="try-model" className="select" value={String(model.id)} onChange={(e) => { setModelId(e.target.value); setValues({}); setResult(null); }}>
          {tabular.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
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
            {result.prediction === ''
              ? result.note || '無法預測'
              : `${model.card.target ?? '結果'}：${result.prediction}` +
                (result.probability !== '' ? `（模型認為的機率 ${Math.round(Number(result.probability) * 100)}%）` : '')}
          </span>
        </Alert>
      ) : null}
    </form>
  );
}
