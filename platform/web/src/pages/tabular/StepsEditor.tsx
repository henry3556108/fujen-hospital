import { useState, type FormEvent } from 'react';
import { Alert } from '../../components/Alert';
import type { CatalogueItem, ColumnInfo, ParamSpec, Step } from './types';

function fits(item: CatalogueItem, column: ColumnInfo): boolean {
  return item.column_types.includes('any') || item.column_types.includes(column.kind);
}

const types = (spec: ParamSpec) => (Array.isArray(spec.type) ? spec.type : [spec.type]);

/** 表單文字 → 參數值（依 JSON Schema 的 type）；空字串代表使用預設值 */
export function parseParam(spec: ParamSpec, text: string): unknown {
  if (text === '') return undefined;
  const t = types(spec);
  if (t.includes('object')) return JSON.parse(text);
  if ((t.includes('integer') || t.includes('number')) && text.trim() !== '' && !Number.isNaN(Number(text))) return Number(text);
  if (t.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  return text;
}

/** 一般不需要調整的參數：收在「進階」，用預設值。 */
const ADVANCED_PARAMS: Record<string, Record<string, string>> = {
  onehot: { drop_first: '只有部分統計模型（例如沒有正則化的線性迴歸）需要；一般保留預設「否」。' },
};

/** 步驟的一行摘要；與預設值相同的參數不列出（例如 One-Hot 的「移除第一個類別」＝否）。 */
export function stepSummary(step: Step, catalogue: CatalogueItem[]): string {
  const item = catalogue.find((c) => c.id === step.id);
  const name = item?.name_zh ?? step.id;
  const cols = step.columns.length ? step.columns.join('、') : '所有適用欄位';
  const params = Object.entries(step.params ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .filter(([k, v]) => !item || item.params.properties[k]?.default === undefined || item.params.properties[k]?.default !== v)
    .map(([k, v]) => `${item?.params.properties[k]?.title ?? k}＝${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return `${name}：${cols}${params.length ? `（${params.join('，')}）` : ''}`;
}

function ParamField({ id, name, spec, value, onChange }: { id: string; name: string; spec: ParamSpec; value: string; onChange: (v: string) => void }) {
  const t = types(spec);
  const fallback = spec.default === null || spec.default === undefined ? '' : String(spec.default);
  if (spec.enum) {
    return (
      <div className="field">
        <label htmlFor={id}>{spec.title}</label>
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">請選擇</option>
          {spec.enum.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (t.length === 1 && t[0] === 'boolean') {
    return (
      <div className="field">
        <label htmlFor={id}>{spec.title}</label>
        <select id={id} className="select" value={value || fallback} onChange={(e) => onChange(e.target.value)}>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      </div>
    );
  }
  const numeric = t.every((x) => x === 'integer' || x === 'number' || x === 'null');
  return (
    <div className="field">
      <label htmlFor={id}>{spec.title}</label>
      <input
        id={id}
        className="input"
        type={numeric ? 'number' : 'text'}
        step={t.includes('integer') ? 1 : 'any'}
        value={value}
        placeholder={fallback ? `預設 ${fallback}` : t.includes('object') ? '{"舊名": "新名"}' : ''}
        onChange={(e) => onChange(e.target.value)}
        data-param={name}
      />
    </div>
  );
}

/** 前處理步驟編輯器：依序套用；方法清單來自 API（TC-B04-06）。 */
export function StepsEditor({
  catalogue,
  columns,
  steps,
  onChange,
  readOnly = false,
}: {
  catalogue: CatalogueItem[];
  /** 原始資料集的欄位（步驟產生的新欄位可在欄位清單手動輸入） */
  columns: ColumnInfo[];
  steps: Step[];
  onChange: (steps: Step[]) => void;
  readOnly?: boolean;
}) {
  const categories = [...new Map(catalogue.map((c) => [c.category, c.category_zh])).entries()];
  const [category, setCategory] = useState(categories[0]?.[0] ?? '');
  const inCategory = catalogue.filter((c) => c.category === category);
  const [methodId, setMethodId] = useState(inCategory[0]?.id ?? '');
  const method = catalogue.find((c) => c.id === methodId) ?? inCategory[0];
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  function chooseCategory(next: string) {
    setCategory(next);
    chooseMethod(catalogue.find((c) => c.category === next)?.id ?? '');
  }

  function chooseMethod(next: string) {
    setMethodId(next);
    setPicked([]);
    setParams({});
    setError(null);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!method) return;
    const cols = [...picked, ...extra.split(/[,，\s]+/).filter(Boolean)];
    if (method.requires_columns && cols.length === 0) return setError(`「${method.name_zh}」必須指定欄位`);
    const values: Record<string, unknown> = {};
    try {
      for (const [key, spec] of Object.entries(method.params.properties)) {
        const v = parseParam(spec, params[key] ?? '');
        if (v !== undefined) values[key] = v;
        else if (method.params.required.includes(key)) return setError(`請填寫「${spec.title}」`);
      }
    } catch {
      return setError('參數格式錯誤：請輸入有效的 JSON');
    }
    onChange([...steps, { id: method.id, columns: [...new Set(cols)], params: values }]);
    setPicked([]);
    setExtra('');
    setParams({});
    setError(null);
    return undefined;
  }

  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };

  const candidates = method ? columns.filter((c) => fits(method, c)) : [];

  return (
    <section aria-label="前處理步驟">
      <h3>前處理步驟</h3>
      {steps.length === 0 ? (
        <p className="text-muted">尚未加入步驟。</p>
      ) : (
        <ol className="step-list" aria-label="已加入的步驟">
          {steps.map((s, i) => (
            <li key={`${s.id}-${i}`}>
              <span>{stepSummary(s, catalogue)}</span>
              {!readOnly && (
                <span className="row-actions">
                  <button type="button" className="btn btn--secondary btn--small" disabled={i === 0} aria-label={`第 ${i + 1} 步上移`} onClick={() => move(i, -1)}>
                    上移
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    disabled={i === steps.length - 1}
                    aria-label={`第 ${i + 1} 步下移`}
                    onClick={() => move(i, 1)}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    aria-label={`移除第 ${i + 1} 步`}
                    onClick={() => onChange(steps.filter((_, k) => k !== i))}
                  >
                    移除
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {!readOnly && method && (
        <form aria-label="加入前處理步驟" className="card section" onSubmit={add} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="step-category">類別</label>
              <select id="step-category" className="select" value={category} onChange={(e) => chooseCategory(e.target.value)}>
                {categories.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}（{catalogue.filter((c) => c.category === id).length}）
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="step-method">方法</label>
              <select id="step-method" className="select" value={method.id} onChange={(e) => chooseMethod(e.target.value)}>
                {inCategory.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name_zh}
                  </option>
                ))}
              </select>
            </div>
            {Object.entries(method.params.properties)
              .filter(([key]) => !ADVANCED_PARAMS[method.id]?.[key])
              .map(([key, spec]) => (
                <ParamField
                  key={`${method.id}-${key}`}
                  id={`step-param-${key}`}
                  name={key}
                  spec={spec}
                  value={params[key] ?? ''}
                  onChange={(v) => setParams((p) => ({ ...p, [key]: v }))}
                />
              ))}
          </div>
          {Object.keys(method.params.properties).some((key) => ADVANCED_PARAMS[method.id]?.[key]) ? (
            <details className="step-advanced">
              <summary>進階（一般不需要調整）</summary>
              {Object.entries(method.params.properties)
                .filter(([key]) => ADVANCED_PARAMS[method.id]?.[key])
                .map(([key, spec]) => (
                  <div key={`${method.id}-${key}`}>
                    <ParamField id={`step-param-${key}`} name={key} spec={spec} value={params[key] ?? ''}
                      onChange={(v) => setParams((p) => ({ ...p, [key]: v }))} />
                    <p className="field__hint">{ADVANCED_PARAMS[method.id][key]}</p>
                  </div>
                ))}
            </details>
          ) : null}
          <fieldset>
            <legend>
              套用欄位{method.requires_columns ? '（必選）' : '（不選＝所有適用欄位）'}
            </legend>
            <div className="col-picker">
              {candidates.map((c) => (
                <label key={c.name} className="checkbox">
                  <input
                    type="checkbox"
                    checked={picked.includes(c.name)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, c.name] : picked.filter((p) => p !== c.name))}
                  />
                  {c.name}
                </label>
              ))}
              {candidates.length === 0 && <span className="text-muted">原始資料沒有適用這個方法的欄位</span>}
            </div>
            <div className="field">
              <label htmlFor="step-extra">其他欄位（前面步驟產生的新欄位，以逗號分隔）</label>
              <input id="step-extra" className="input" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </div>
          </fieldset>
          <div className="row-actions">
            <button type="submit" className="btn btn--secondary">
              加入步驟
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
