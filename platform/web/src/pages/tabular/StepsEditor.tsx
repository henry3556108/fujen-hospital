import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../../components/Alert';
import { Icon } from '../../components/Icon';
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

/** 參數值 → 表單文字（修改步驟時帶入目前的值） */
export function paramText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** 一般不需要調整的參數：收在「進階」，用預設值。 */
const ADVANCED_PARAMS: Record<string, Record<string, string>> = {
  onehot: { drop_first: '只有部分統計模型（例如沒有正則化的 Linear Regression）需要；一般保留預設「否」。' },
};

/** 步驟的一行摘要；與預設值相同的參數不列出（例如 One Hot Encoding 的「移除第一個類別」＝否）。 */
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

/** 依表單內容組出步驟；有錯時回錯誤訊息。 */
export function buildStep(method: CatalogueItem, columns: string[], texts: Record<string, string>): Step | string {
  if (method.requires_columns && columns.length === 0) return `「${method.name_zh}」必須指定欄位`;
  const values: Record<string, unknown> = {};
  try {
    for (const [key, spec] of Object.entries(method.params.properties)) {
      const v = parseParam(spec, texts[key] ?? '');
      if (v !== undefined) values[key] = v;
      else if (method.params.required.includes(key)) return `請填寫「${spec.title}」`;
    }
  } catch {
    return '參數格式錯誤：請輸入有效的 JSON';
  }
  return { id: method.id, columns: [...new Set(columns)], params: values };
}

const splitColumns = (text: string) => text.split(/[,，\s]+/).filter(Boolean);

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

/** 方法的參數欄位；ADVANCED_PARAMS 列的參數收在「進階」。 */
function ParamFields({ idPrefix, method, values, onChange }: { idPrefix: string; method: CatalogueItem; values: Record<string, string>; onChange: (key: string, v: string) => void }) {
  const entries = Object.entries(method.params.properties);
  const advanced = entries.filter(([key]) => ADVANCED_PARAMS[method.id]?.[key]);
  return (
    <>
      {entries
        .filter(([key]) => !ADVANCED_PARAMS[method.id]?.[key])
        .map(([key, spec]) => (
          <ParamField key={`${method.id}-${key}`} id={`${idPrefix}-${key}`} name={key} spec={spec} value={values[key] ?? ''} onChange={(v) => onChange(key, v)} />
        ))}
      {advanced.length > 0 ? (
        <details className="step-advanced">
          <summary>進階（一般不需要調整）</summary>
          {advanced.map(([key, spec]) => (
            <div key={`${method.id}-${key}`}>
              <ParamField id={`${idPrefix}-${key}`} name={key} spec={spec} value={values[key] ?? ''} onChange={(v) => onChange(key, v)} />
              <p className="field__hint">{ADVANCED_PARAMS[method.id][key]}</p>
            </div>
          ))}
        </details>
      ) : null}
    </>
  );
}

/** 套用欄位：適用的原始欄位勾選＋其他欄位（前面步驟產生的新欄位）。 */
function ColumnPicker({
  idPrefix,
  method,
  candidates,
  picked,
  onPicked,
  extra,
  onExtra,
}: {
  idPrefix: string;
  method: CatalogueItem;
  candidates: ColumnInfo[];
  picked: string[];
  onPicked: (cols: string[]) => void;
  extra: string;
  onExtra: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend>套用欄位{method.requires_columns ? '（必選）' : '（不選＝所有適用欄位）'}</legend>
      <div className="col-picker">
        {candidates.map((c) => (
          <label key={c.name} className="checkbox">
            <input
              type="checkbox"
              checked={picked.includes(c.name)}
              onChange={(e) => onPicked(e.target.checked ? [...picked, c.name] : picked.filter((p) => p !== c.name))}
            />
            {c.name}
          </label>
        ))}
        {candidates.length === 0 && <span className="text-muted">原始資料沒有適用這個方法的欄位</span>}
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-extra`}>其他欄位（前面步驟產生的新欄位，以逗號分隔）</label>
        <input id={`${idPrefix}-extra`} className="input" value={extra} onChange={(e) => onExtra(e.target.value)} />
      </div>
    </fieldset>
  );
}

/** F4 就地修改一個步驟：方法不變，可改參數與套用欄位。 */
function StepEdit({
  index,
  step,
  method,
  columns,
  onSave,
  onCancel,
}: {
  index: number;
  step: Step;
  method: CatalogueItem;
  columns: ColumnInfo[];
  onSave: (step: Step) => void;
  onCancel: () => void;
}) {
  const candidates = columns.filter((c) => fits(method, c));
  const known = new Set(candidates.map((c) => c.name));
  const [picked, setPicked] = useState(step.columns.filter((c) => known.has(c)));
  const [extra, setExtra] = useState(step.columns.filter((c) => !known.has(c)).join(', '));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(step.params ?? {}).map(([k, v]) => [k, paramText(v)])),
  );
  const [error, setError] = useState<string | null>(null);
  const prefix = `edit-${index}`;

  function save(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = buildStep(method, [...picked, ...splitColumns(extra)], values);
    if (typeof next === 'string') return setError(next);
    onSave(next);
    return undefined;
  }

  return (
    <form aria-label={`修改第 ${index + 1} 步`} className="rd-step__edit" onSubmit={save} noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="form-grid">
        <ParamFields idPrefix={`${prefix}-param`} method={method} values={values} onChange={(k, v) => setValues((p) => ({ ...p, [k]: v }))} />
      </div>
      <ColumnPicker idPrefix={prefix} method={method} candidates={candidates} picked={picked} onPicked={setPicked} extra={extra} onExtra={setExtra} />
      <div className="row-actions section">
        <button type="submit" className="btn btn--secondary btn--small">
          儲存修改
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 大多數使用者不需要自己加步驟：上方欄位表會自動處理類別欄位（One Hot Encoding）與缺值。 */
export const NOT_NEEDED =
  '大多數人不需要自己加步驟：類別欄位（例如 sex）在上方欄位表打開「當作類別」，缺值在「有缺值的病人怎麼處理」選擇就好。' +
  '只有要做標準化、離散化、K 近鄰補值等特別處理時才需要自己加步驟。';

/** 搜尋前處理方式：比對中文名稱、代號與分類名稱（不分大小寫）。 */
export function matchMethod(item: CatalogueItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.name_zh, item.id, item.category_zh].some((t) => t.toLowerCase().includes(q));
}

/**
 * 前處理步驟（A05 右側「前處理步驟」）：依序套用；每一步可上移、下移、修改參數（F4）、移除；
 * 「新增步驟」展開加入表單，方法清單來自 API（TC-B04-06）。
 * request：欄位表按「加步驟」時帶入的欄位（key 變了就展開表單並勾好該欄）。
 */
export function StepsEditor({
  catalogue,
  columns,
  steps,
  onChange,
  readOnly = false,
  request,
}: {
  catalogue: CatalogueItem[];
  /** 原始資料集的欄位（步驟產生的新欄位可在欄位清單手動輸入） */
  columns: ColumnInfo[];
  steps: Step[];
  onChange: (steps: Step[]) => void;
  readOnly?: boolean;
  request?: { column: string; key: number } | null;
}) {
  const categories = [...new Map(catalogue.map((c) => [c.category, c.category_zh])).entries()];
  const [category, setCategory] = useState(categories[0]?.[0] ?? '');
  const [search, setSearch] = useState('');
  // 有搜尋字時跨分類列出符合的方法；沒有時列出目前分類的方法
  const inCategory = search.trim() ? catalogue.filter((c) => matchMethod(c, search)) : catalogue.filter((c) => c.category === category);
  const [methodId, setMethodId] = useState(inCategory[0]?.id ?? '');
  const method = inCategory.find((c) => c.id === methodId) ?? inCategory[0];
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  // 還沒有步驟時先展開新增表單；已有步驟時收起，按「新增步驟」再展開
  const [addOpen, setAddOpen] = useState(steps.length === 0);
  const addRef = useRef<HTMLDetailsElement>(null);

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

  useEffect(() => {
    if (!request || readOnly) return;
    const col = columns.find((c) => c.name === request.column);
    if (!col) return;
    setSearch('');
    setAddOpen(true);
    setError(null);
    setParams({});
    const current = catalogue.find((c) => c.id === method?.id);
    if (!current || !fits(current, col)) {
      // 目前的方法不適用這一欄：有缺值先找缺值處理，否則找第一個適用的方法
      const pick =
        (col.missing > 0 ? catalogue.find((c) => c.category === 'imputation' && fits(c, col)) : undefined) ?? catalogue.find((c) => fits(c, col));
      if (pick) {
        setCategory(pick.category);
        setMethodId(pick.id);
      }
    }
    setPicked([col.name]);
    addRef.current?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.key]);

  function add(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!method) return;
    const next = buildStep(method, [...picked, ...splitColumns(extra)], params);
    if (typeof next === 'string') return setError(next);
    onChange([...steps, next]);
    setPicked([]);
    setExtra('');
    setParams({});
    setError(null);
    return undefined;
  }

  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setEditing(null);
    onChange(next);
  };

  const candidates = method ? columns.filter((c) => fits(method, c)) : [];

  return (
    <section aria-label="前處理步驟">
      {!readOnly ? (
        <p className="field__hint" data-testid="steps-not-needed">
          {NOT_NEEDED}
        </p>
      ) : null}
      {steps.length === 0 ? (
        <p className="text-muted">尚未加入步驟。</p>
      ) : (
        <ol className="rd-steps" aria-label="已加入的步驟">
          {steps.map((s, i) => {
            const item = catalogue.find((c) => c.id === s.id);
            return (
              <li key={`${s.id}-${i}`} className="rd-step">
                <span className="rd-step__title">{stepSummary(s, catalogue)}</span>
                <span className="rd-step__num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="rd-step__desc">
                  {item?.category_zh ?? '前處理方式'}・{s.columns.length ? `套用 ${s.columns.length} 個欄位` : '套用所有適用欄位'}
                </span>
                {!readOnly && (
                  <span className="rd-step__tools">
                    <button type="button" className="btn btn--ghost btn--small" disabled={i === 0} aria-label={`第 ${i + 1} 步上移`} onClick={() => move(i, -1)}>
                      上移
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      disabled={i === steps.length - 1}
                      aria-label={`第 ${i + 1} 步下移`}
                      onClick={() => move(i, 1)}
                    >
                      下移
                    </button>
                    {item && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        aria-label={`修改第 ${i + 1} 步`}
                        aria-expanded={editing === i}
                        onClick={() => setEditing(editing === i ? null : i)}
                      >
                        <Icon name="pen" /> 修改
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      aria-label={`移除第 ${i + 1} 步`}
                      onClick={() => {
                        setEditing(null);
                        onChange(steps.filter((_, k) => k !== i));
                      }}
                    >
                      <Icon name="close" /> 移除
                    </button>
                  </span>
                )}
                {!readOnly && editing === i && item && (
                  <StepEdit
                    key={`${i}-${s.id}`}
                    index={i}
                    step={s}
                    method={item}
                    columns={columns}
                    onCancel={() => setEditing(null)}
                    onSave={(next) => {
                      setEditing(null);
                      onChange(steps.map((x, k) => (k === i ? next : x)));
                    }}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}

      {!readOnly ? (
        <details ref={addRef} className="rd-add-step section" data-testid="steps-advanced" open={addOpen} onToggle={(e) => setAddOpen(e.currentTarget.open)}>
          <summary className="btn btn--secondary btn--small">＋ 新增步驟</summary>
          {form()}
        </details>
      ) : null}
    </section>
  );

  function searchField() {
    return (
      <div className="field">
        <label htmlFor="step-search">搜尋方法</label>
        <input
          id="step-search"
          type="search"
          className="input"
          placeholder="例如：補值、標準化、onehot"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPicked([]);
            setParams({});
            setError(null);
          }}
        />
      </div>
    );
  }

  function form() {
    if (!method) {
      return (
        <form aria-label="加入前處理步驟" className="card section" onSubmit={(e) => e.preventDefault()} noValidate>
          {/* 與下方表單同樣的子元素位置，打字時搜尋框不會被重建而失去焦點 */}
          {null}
          <div className="form-grid">{searchField()}</div>
          <p role="status">找不到符合「{search.trim()}」的方法，請換個關鍵字。</p>
        </form>
      );
    }
    return (
      <form aria-label="加入前處理步驟" className="card section" onSubmit={add} noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="form-grid">
          {searchField()}
          <div className="field">
            <label htmlFor="step-category">類別</label>
            <select id="step-category" className="select" value={category} disabled={!!search.trim()} onChange={(e) => chooseCategory(e.target.value)}>
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
          <ParamFields idPrefix="step-param" method={method} values={params} onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))} />
        </div>
        <ColumnPicker idPrefix="step" method={method} candidates={candidates} picked={picked} onPicked={setPicked} extra={extra} onExtra={setExtra} />
        <div className="row-actions">
          <button type="submit" className="btn btn--secondary">
            加入步驟
          </button>
        </div>
      </form>
    );
  }
}
