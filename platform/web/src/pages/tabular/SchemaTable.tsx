import { useState } from 'react';
import type { InferColumn, SchemaColumn } from './types';
import { binaryLabel } from './columnOverview';

/** 型態的中文名稱（結構定義 type → 畫面文字） */
export const TYPE_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'int', label: '整數', hint: '例如年齡、人數' },
  { value: 'float', label: '小數', hint: '例如 BMI、檢驗值' },
  { value: 'category', label: '類別', hint: '少數幾種固定值，例如性別、吸菸狀態' },
  { value: 'str', label: '文字', hint: '自由文字或編號' },
  { value: 'date', label: '日期', hint: '格式 2024-01-31' },
  { value: 'bool', label: '是否', hint: '是／否、true／false' },
];

export const typeLabel = (t: string) => TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;

const NUMERIC = ['int', 'float'];

/** 只有 0 與 1 的整數欄（伺服器的 binary01；舊版 API 沒有時看觀察到的最小、最大值與不同值數） */
const isBinary = (s: InferColumn | undefined) =>
  !!s && (s.binary01 ?? (s.type === 'int' && s.observed_min === 0 && s.observed_max === 1 && s.distinct === 2));

function patternExample(pattern: string, examples: string[]): string {
  const re = new RegExp(pattern);
  return examples.find((e) => re.test(e)) ?? pattern;
}

function parseBound(type: string, text: string): number | string | null {
  if (text.trim() === '') return null;
  if (type === 'date') return text.trim();
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const splitValues = (text: string) => text.split(/[、,，]/).map((v) => v.trim()).filter(Boolean);

/** 允許的值：以頓號或逗號分隔；留白代表不限定。打字時保留原文，離開欄位才整理。 */
function AllowedInput({ name, value, onChange }: { name: string; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="input"
      aria-label={`${name} 允許的值`}
      placeholder="留白＝不限定"
      value={draft ?? (value ?? []).join('、')}
      onChange={(e) => {
        setDraft(e.target.value);
        const values = splitValues(e.target.value);
        onChange(values.length ? values : null);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** 上傳前的欄位確認表：使用者確認或修改推斷的結構（型態、必填、不可重複、範圍、允許的值）。 */
export function SchemaTable({
  columns,
  summaries,
  onChange,
}: {
  columns: SchemaColumn[];
  summaries: InferColumn[];
  onChange: (columns: SchemaColumn[]) => void;
}) {
  const update = (i: number, patch: Partial<SchemaColumn>) => onChange(columns.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  return (
    <div className="table-wrap">
      <table aria-label="欄位確認" className="schema-table">
        <thead>
          <tr>
            <th scope="col">欄名</th>
            <th scope="col">型態</th>
            <th scope="col">必填</th>
            <th scope="col">不可重複</th>
            <th scope="col">範圍（選填）</th>
            <th scope="col">允許的值</th>
            <th scope="col">檔案內容與提示</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => {
            const s = summaries.find((x) => x.name === c.name);
            const ranged = NUMERIC.includes(c.type) || c.type === 'date';
            return (
              <tr key={c.name}>
                <th scope="row">{c.name}</th>
                <td>
                  <select
                    className="select"
                    aria-label={`${c.name} 的型態`}
                    aria-describedby={c.type === 'int' && isBinary(s) ? `schema-binary-${i}` : undefined}
                    value={c.type}
                    onChange={(e) => {
                      const type = e.target.value;
                      const text = type === 'str' || type === 'category';
                      update(i, {
                        type,
                        allowed: type === 'category' ? c.allowed : null,
                        pattern: text ? c.pattern : null,
                        min: NUMERIC.includes(type) === NUMERIC.includes(c.type) && (type === 'date') === (c.type === 'date') ? c.min : null,
                        max: NUMERIC.includes(type) === NUMERIC.includes(c.type) && (type === 'date') === (c.type === 'date') ? c.max : null,
                      });
                    }}
                  >
                    {TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value} title={o.hint}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {c.type === 'int' && isBinary(s) ? (
                    // 與資料頁同一個名稱「整數（0／1，是／否）」；放在選單下方，選單不加寬，表格不必橫向捲動
                    <span id={`schema-binary-${i}`} className="field__hint schema-table__binary" data-testid={`schema-binary-${c.name}`}>
                      {binaryLabel('int').replace(/^整數/, '')}
                    </span>
                  ) : null}
                </td>
                <td>
                  <input type="checkbox" aria-label={`${c.name} 必填`} checked={!!c.required} onChange={(e) => update(i, { required: e.target.checked })} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`${c.name} 不可重複`} checked={!!c.unique} onChange={(e) => update(i, { unique: e.target.checked })} />
                </td>
                <td>
                  {ranged ? (
                    <span className="schema-table__range">
                      <input
                        className="input input--narrow"
                        aria-label={`${c.name} 最小值`}
                        type={c.type === 'date' ? 'date' : 'number'}
                        step="any"
                        value={c.min ?? ''}
                        onChange={(e) => update(i, { min: parseBound(c.type, e.target.value) as number | null })}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        className="input input--narrow"
                        aria-label={`${c.name} 最大值`}
                        type={c.type === 'date' ? 'date' : 'number'}
                        step="any"
                        value={c.max ?? ''}
                        onChange={(e) => update(i, { max: parseBound(c.type, e.target.value) as number | null })}
                      />
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  {c.type === 'category' ? (
                    <AllowedInput name={c.name} value={c.allowed ?? null} onChange={(allowed) => update(i, { allowed })} />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="schema-table__summary">
                  {s && (
                    <>
                      <span>
                        缺值 {s.missing}、不同值 {s.distinct}
                      </span>
                      {s.observed_min !== null && (
                        <span>
                          目前 {String(s.observed_min)}–{String(s.observed_max)}
                        </span>
                      )}
                      {s.examples.length > 0 && <span className="text-muted">例：{s.examples.join('、')}</span>}
                    </>
                  )}
                  <ul className="schema-table__notes">
                    {c.pattern && !s?.notes.some((n) => n.startsWith('格式固定')) && <li>格式需與「{patternExample(c.pattern, s?.examples ?? [])}」相同</li>}
                    {s?.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
