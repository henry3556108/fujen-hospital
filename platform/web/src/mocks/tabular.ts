// 模擬 platform/api 的結構式資料 API（app/tabular_api）。
// 上傳驗證、描述性統計、分布、預覽、相關係數、Scatter Chart 都在瀏覽器內實算；
// 4 種統計模型回傳從真實 API 擷取的固定結果（只把欄位名稱換成請求的欄位），前處理只實作常用幾種，其餘原樣通過。
import { http } from 'msw';
import type {
  CatalogueItem,
  Cell,
  ColumnInfo,
  ColumnKind,
  Dataset,
  DescribeColumn,
  SchemaColumn,
  Step,
  TargetFeature,
  ValidationReport,
} from '../pages/tabular/types';
import { CATALOGUE, COHORT_CSV, COHORT_SCHEMA, STATS_FIXTURES } from './tabularData';
import { DEFAULT_MISSING_VALUES, InferError, inferFromTable } from './tabularInfer';
import { API, detail, isoNow, json, jsonBody, moduleState, noContent, requireProject, tabularError, validation } from './support';

interface Frame {
  columns: string[];
  kinds: Record<string, ColumnKind>;
  dtypes: Record<string, string>;
  rows: Cell[][];
}

interface StoredDataset extends Dataset {
  frame: Frame;
  report: ValidationReport;
  targetFeature: TargetFeature | null;
}

interface State {
  datasets: StoredDataset[];
  nextId: number;
  /** TC-B04-02 欄位顯示設定：`${datasetId}:${username}` → 隱藏的欄位 */
  columnViews?: Record<string, string[]>;
}

class MockError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const catalogue = CATALOGUE as unknown as CatalogueItem[];

// ---------- CSV 與驗證 ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const DTYPES: Record<string, [string, ColumnKind]> = {
  int: ['Int64', 'numeric'],
  float: ['float64', 'numeric'],
  str: ['object', 'categorical'],
  category: ['category', 'categorical'],
  bool: ['boolean', 'boolean'],
  date: ['datetime64[ns]', 'datetime'],
};

function convert(spec: SchemaColumn, text: string): Cell {
  if (spec.type === 'int') {
    if (!/^[+-]?\d+$/.test(text)) throw new Error(`「${text}」不是整數`);
    return Number(text);
  }
  if (spec.type === 'float') {
    if (text.trim() === '' || Number.isNaN(Number(text))) throw new Error(`「${text}」不是數值`);
    return Number(text);
  }
  if (spec.type === 'bool') {
    const low = text.toLowerCase();
    if (['true', '1', 'yes', 'y', 't', '是'].includes(low)) return true;
    if (['false', '0', 'no', 'n', 'f', '否'].includes(low)) return false;
    throw new Error(`「${text}」不是布林值（true/false）`);
  }
  return text;
}

function checkCell(spec: SchemaColumn, text: string): Cell {
  const value = convert(spec, text);
  if (spec.pattern && !new RegExp(spec.pattern).test(text)) throw new Error(`「${text}」格式不符（應符合 ${spec.pattern}）`);
  if (spec.allowed && !spec.allowed.includes(text)) throw new Error(`「${text}」不在允許值（${spec.allowed.join('、')}）之內`);
  if (typeof value === 'number') {
    if (spec.min !== null && spec.min !== undefined && value < spec.min) throw new Error(`「${text}」小於最小值 ${spec.min}`);
    if (spec.max !== null && spec.max !== undefined && value > spec.max) throw new Error(`「${text}」大於最大值 ${spec.max}`);
  }
  return value;
}

export function validateCsv(text: string, schema: { columns: SchemaColumn[] }): { report: ValidationReport; frame: Frame } {
  const table = parseCsv(text);
  const header = table[0] ?? [];
  const report: ValidationReport = {
    valid_rows: 0,
    total_rows: Math.max(0, table.length - 1),
    rejected_row_count: 0,
    rejected: [],
    columns: header,
    errors: [],
    warnings: [],
  };
  const frame: Frame = { columns: [], kinds: {}, dtypes: {}, rows: [] };
  if (header.length === 0) {
    report.errors.push({ code: 'empty_file', message: '檔案是空的，沒有任何欄位或資料' });
    return { report, frame };
  }
  const missing = schema.columns.filter((c) => c.required && !header.includes(c.name)).map((c) => c.name);
  if (missing.length) {
    report.total_rows = 0;
    report.errors.push({ code: 'missing_required_columns', message: `缺少必要欄位：${missing.join('、')}` });
    return { report, frame };
  }
  if (table.length < 2) {
    report.errors.push({ code: 'no_data_rows', message: '檔案只有標題列，沒有任何資料列' });
    return { report, frame };
  }
  const unknown = header.filter((h) => !schema.columns.some((c) => c.name === h));
  if (unknown.length) report.warnings = [{ code: 'unknown_columns', message: `結構定義中沒有下列欄位，將忽略：${unknown.join('、')}` }];
  const specs = schema.columns.filter((c) => header.includes(c.name));
  frame.columns = specs.map((c) => c.name);
  for (const c of specs) [frame.dtypes[c.name], frame.kinds[c.name]] = DTYPES[c.type] ?? ['object', 'categorical'];
  const seen: Record<string, Map<string, number>> = {};
  table.slice(1).forEach((cells, index) => {
    const reject = (column: string, reason: string) => report.rejected.push({ row: index, column, reason });
    if (cells.length !== header.length) return reject('', `欄位數不符：應為 ${header.length} 欄，實際 ${cells.length} 欄`);
    const out: Cell[] = [];
    for (const spec of specs) {
      const text = cells[header.indexOf(spec.name)].trim();
      const token = text !== '' && (spec.missing_values ?? []).some((m) => m.trim().toLowerCase() === text.toLowerCase());
      if (text === '' || token) {
        if (spec.required) return reject(spec.name, text === '' ? '必填欄位為空值' : `必填欄位為缺值（「${text}」）`);
        out.push(null);
        continue;
      }
      try {
        out.push(checkCell(spec, text));
      } catch (e) {
        return reject(spec.name, (e as Error).message);
      }
      if (spec.unique) {
        const index0 = (seen[spec.name] ??= new Map()).get(text);
        if (index0 !== undefined) return reject(spec.name, `值「${text}」重複（與第 ${index0 + 1} 列相同），此欄位不可重複`);
      }
    }
    for (const spec of specs.filter((s) => s.unique)) seen[spec.name].set(cells[header.indexOf(spec.name)], index);
    frame.rows.push(out);
    return undefined;
  });
  report.valid_rows = frame.rows.length;
  report.rejected_row_count = report.rejected.length;
  return { report, frame };
}

// ---------- 統計 ----------

const round = (v: number) => Number(v.toPrecision(12));

function column(frame: Frame, name: string): Cell[] {
  const i = frame.columns.indexOf(name);
  if (i < 0) throw new MockError('column_not_found', `資料中找不到欄位：${name}`, { columns: [name] });
  return frame.rows.map((r) => r[i]);
}

function numeric(frame: Frame, name: string): (number | null)[] {
  const values = column(frame, name);
  if (frame.kinds[name] !== 'numeric') {
    throw new MockError('column_not_numeric', `欄位「${name}」不是數值欄位，無法進行數值分析`, { column: name });
  }
  return values as (number | null)[];
}

function requireColumns(frame: Frame, names: string[]): void {
  const missing = names.filter((n) => !frame.columns.includes(n));
  if (missing.length) throw new MockError('column_not_found', `資料中找不到欄位：${missing.join('、')}`, { columns: missing });
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function columnInfo(frame: Frame): ColumnInfo[] {
  return frame.columns.map((name, i) => ({
    name,
    dtype: frame.dtypes[name],
    kind: frame.kinds[name],
    missing: frame.rows.filter((r) => r[i] === null).length,
    unique: new Set(frame.rows.map((r) => r[i]).filter((v) => v !== null)).size,
  }));
}

export function describe(frame: Frame): { row_count: number; columns: DescribeColumn[] } {
  const columns = columnInfo(frame).map((info): DescribeColumn => {
    const values = column(frame, info.name).filter((v): v is Exclude<Cell, null> => v !== null);
    const base = { ...info, count: values.length, unique: new Set(values).size };
    if (info.kind === 'numeric') {
      const nums = (values as number[]).slice().sort((a, b) => a - b);
      if (nums.length === 0) return base;
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const std = nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)) : 0;
      return {
        ...base,
        mean: round(mean),
        std: round(std),
        min: nums[0],
        p25: round(quantile(nums, 0.25)),
        p50: round(quantile(nums, 0.5)),
        p75: round(quantile(nums, 0.75)),
        max: nums.at(-1)!,
      };
    }
    const counts = new Map<Cell, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? { ...base, top: top[0], freq: top[1] } : base;
  });
  return { row_count: frame.rows.length, columns };
}

function histogram(frame: Frame, name: string, bins: number) {
  if (!Number.isInteger(bins) || bins < 1) throw new MockError('invalid_argument', '分組數（bins）必須是大於 0 的整數');
  const all = numeric(frame, name);
  const values = all.filter((v): v is number => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  // 與 numpy.histogram 相同：先以比例估計分箱，再用邊界值校正（邊界上的值歸到右邊的箱，最後一箱含右端點）
  const raw = Array.from({ length: bins + 1 }, (_, i) => (i === bins ? lo + span : lo + (span / bins) * i));
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    let i = Math.min(bins - 1, Math.floor(((v - lo) * bins) / span));
    if (v < raw[i]) i--;
    else if (i !== bins - 1 && v >= raw[i + 1]) i++;
    counts[i]++;
  }
  const edges = raw.map(round);
  return {
    column: name,
    counts,
    edges,
    missing: all.length - values.length,
    bins: counts.map((count, i) => ({ start: edges[i], end: edges[i + 1], count })),
  };
}

function valueCounts(frame: Frame, name: string, limit: number) {
  const values = column(frame, name);
  const counts = new Map<Cell, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  return { column: name, missing: values.filter((v) => v === null).length, distinct: items.length, items: items.slice(0, limit) };
}

function preview(frame: Frame, offset: number, limit: number, columns: string[] | null) {
  if (offset < 0) throw new MockError('invalid_argument', '起始列（offset）不可為負數');
  if (limit < 1 || limit > 500) throw new MockError('invalid_argument', '筆數（limit）必須介於 1 到 500');
  const cols = columns ?? frame.columns;
  requireColumns(frame, cols);
  const index = cols.map((c) => frame.columns.indexOf(c));
  return {
    total_rows: frame.rows.length,
    offset,
    limit,
    columns: cols,
    rows: frame.rows.slice(offset, offset + limit).map((r) => index.map((i) => r[i])),
  };
}

function pearson(a: (number | null)[], b: (number | null)[]): number | null {
  const pairs = a.map((x, i) => [x, b[i]] as const).filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
  if (pairs.length < 2) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : round(sxy / Math.sqrt(sxx * syy));
}

function correlation(frame: Frame, columns: string[] | null, method: string) {
  if (!['pearson', 'spearman', 'kendall'].includes(method)) {
    throw new MockError('invalid_argument', `不支援的相關係數方法「${method}」，可用：pearson、spearman、kendall`);
  }
  const cols = columns ?? frame.columns.filter((c) => frame.kinds[c] === 'numeric' && column(frame, c).some((v) => v !== null));
  if (cols.length < 2) throw new MockError('invalid_argument', 'Correlation Matrix 至少需要 2 個數值欄位');
  requireColumns(frame, cols);
  const data = cols.map((c) => numeric(frame, c));
  return { method, columns: cols, matrix: data.map((a, i) => data.map((b, j) => (i === j ? 1 : pearson(a, b)))) };
}

function scatter(frame: Frame, x: string, y: string, limit: number) {
  const xs = numeric(frame, x);
  const ys = numeric(frame, y);
  const points = xs.map((v, i) => [v, ys[i]]).filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
  const sampled = points.length > limit;
  const stride = sampled ? points.length / limit : 1;
  const kept = sampled ? Array.from({ length: limit }, (_, i) => points[Math.floor(i * stride)]) : points;
  return { x, y, total: points.length, returned: kept.length, sampled, points: kept };
}

// ---------- 前處理 ----------

export function validateSteps(steps: unknown): Step[] {
  if (!Array.isArray(steps)) throw new MockError('invalid_steps', '前處理步驟必須是清單');
  return steps.map((raw, i): Step => {
    if (!raw || typeof raw !== 'object' || !('id' in raw)) throw new MockError('invalid_steps', `第 ${i + 1} 個前處理步驟缺少 id`);
    const r = raw as { id: string; columns?: unknown; params?: Record<string, unknown> };
    const item = catalogue.find((c) => c.id === r.id);
    if (!item) throw new MockError('unknown_step', `找不到前處理方法「${r.id}」`, { id: r.id });
    const columns = (r.columns ?? []) as unknown;
    if (!Array.isArray(columns) || !columns.every((c) => typeof c === 'string')) {
      throw new MockError('invalid_steps', `「${item.name_zh}」的欄位清單格式錯誤`);
    }
    if (item.requires_columns && columns.length === 0) throw new MockError('invalid_steps', `「${item.name_zh}」必須指定欄位`);
    const params: Record<string, unknown> = {};
    const given = r.params ?? {};
    const unknown = Object.keys(given).filter((k) => !(k in item.params.properties));
    if (unknown.length) throw new MockError('invalid_params', `「${item.name_zh}」不支援參數：${unknown.join('、')}`);
    for (const [key, spec] of Object.entries(item.params.properties)) {
      const value = given[key] ?? spec.default;
      if (item.params.required.includes(key) && (value === null || value === undefined || value === '')) {
        throw new MockError('invalid_params', `「${item.name_zh}」缺少必要參數「${spec.title}」（${key}）`);
      }
      if (typeof value === 'number' && spec.minimum !== undefined && value < spec.minimum) {
        throw new MockError('invalid_params', `「${item.name_zh}」的參數「${spec.title}」不可小於 ${spec.minimum}`);
      }
      params[key] = value;
    }
    return { id: item.id, columns: columns as string[], params };
  });
}

function targets(frame: Frame, step: Step, item: CatalogueItem): string[] {
  requireColumns(frame, step.columns);
  const fits = (c: string) => item.column_types.includes('any') || item.column_types.includes(frame.kinds[c]);
  for (const c of step.columns) {
    if (!fits(c)) {
      throw new MockError(
        'column_type_mismatch',
        `「${item.name_zh}」不適用於欄位「${c}」（型別：${frame.kinds[c]}），適用型別：${item.column_types.join('、')}`,
        { column: c },
      );
    }
  }
  return step.columns.length ? step.columns : frame.columns.filter(fits);
}

function mapColumn(frame: Frame, name: string, fn: (values: Cell[]) => Cell[], dtype?: [string, ColumnKind]): void {
  const i = frame.columns.indexOf(name);
  const next = fn(frame.rows.map((r) => r[i]));
  frame.rows.forEach((r, k) => (r[i] = next[k]));
  if (dtype) [frame.dtypes[name], frame.kinds[name]] = dtype;
}

const FLOAT: [string, ColumnKind] = ['float64', 'numeric'];

export function applyPipeline(source: Frame, rawSteps: unknown): Frame {
  const steps = validateSteps(rawSteps);
  const frame: Frame = {
    columns: [...source.columns],
    kinds: { ...source.kinds },
    dtypes: { ...source.dtypes },
    rows: source.rows.map((r) => [...r]),
  };
  const drop = (names: string[]) => {
    const keep = frame.columns.map((c, i) => (names.includes(c) ? -1 : i)).filter((i) => i >= 0);
    frame.rows = frame.rows.map((r) => keep.map((i) => r[i]));
    frame.columns = keep.map((i) => frame.columns[i]);
  };
  for (const step of steps) {
    const item = catalogue.find((c) => c.id === step.id)!;
    const cols = targets(frame, step, item);
    const nums = (values: Cell[]) => values.filter((v): v is number => typeof v === 'number');
    switch (step.id) {
      case 'impute_mean':
      case 'impute_median':
        for (const c of cols) {
          mapColumn(
            frame,
            c,
            (values) => {
              const sorted = nums(values).sort((a, b) => a - b);
              if (sorted.length === 0) return values;
              const fill = step.id === 'impute_mean' ? sorted.reduce((a, b) => a + b, 0) / sorted.length : quantile(sorted, 0.5);
              return values.map((v) => (v === null ? round(fill) : v));
            },
            FLOAT,
          );
        }
        break;
      case 'impute_most_frequent':
        for (const c of cols) {
          mapColumn(frame, c, (values) => {
            const top = valueCounts({ ...frame, rows: values.map((v) => [v]), columns: [c] }, c, 1).items[0];
            return top ? values.map((v) => (v === null ? top.value : v)) : values;
          });
        }
        break;
      case 'impute_constant':
        for (const c of cols) mapColumn(frame, c, (values) => values.map((v) => (v === null ? (step.params.fill_value as Cell) : v)));
        break;
      case 'drop_missing_rows': {
        const index = cols.map((c) => frame.columns.indexOf(c));
        frame.rows = frame.rows.filter((r) => index.every((i) => r[i] !== null));
        break;
      }
      case 'scale_standard':
        for (const c of cols) {
          mapColumn(
            frame,
            c,
            (values) => {
              const n = nums(values);
              const mean = n.reduce((a, b) => a + b, 0) / n.length;
              const sd = Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / n.length) || 1;
              return values.map((v) => (typeof v === 'number' ? round((v - mean) / sd) : v));
            },
            FLOAT,
          );
        }
        break;
      case 'scale_minmax':
        for (const c of cols) {
          mapColumn(
            frame,
            c,
            (values) => {
              const n = nums(values);
              const lo = Math.min(...n);
              const span = Math.max(...n) - lo || 1;
              const a = Number(step.params.min ?? 0);
              const b = Number(step.params.max ?? 1);
              return values.map((v) => (typeof v === 'number' ? round(a + ((v - lo) / span) * (b - a)) : v));
            },
            FLOAT,
          );
        }
        break;
      case 'log1p':
        for (const c of cols) mapColumn(frame, c, (values) => values.map((v) => (typeof v === 'number' ? round(Math.log1p(v)) : v)), FLOAT);
        break;
      case 'onehot':
        for (const c of cols) {
          const values = column(frame, c);
          let levels = [...new Set(values.filter((v) => v !== null).map(String))].sort();
          if (step.params.drop_first) levels = levels.slice(1);
          const at = frame.columns.indexOf(c);
          frame.rows = frame.rows.map((r, k) => [...r.slice(0, at), ...levels.map((l) => (String(values[k]) === l ? 1 : 0)), ...r.slice(at + 1)]);
          frame.columns = [...frame.columns.slice(0, at), ...levels.map((l) => `${c}_${l}`), ...frame.columns.slice(at + 1)];
          for (const l of levels) [frame.dtypes[`${c}_${l}`], frame.kinds[`${c}_${l}`]] = ['int64', 'numeric'];
        }
        break;
      case 'cast_type':
        if (step.params.dtype === 'category' || step.params.dtype === 'str') {
          const dtype: [string, ColumnKind] = step.params.dtype === 'category' ? ['category', 'categorical'] : ['object', 'categorical'];
          for (const c of cols) mapColumn(frame, c, (values) => values.map((v) => (v === null ? null : String(v))), dtype);
        }
        break;
      case 'drop_columns':
        drop(step.columns);
        break;
      case 'select_columns':
        drop(frame.columns.filter((c) => !step.columns.includes(c)));
        break;
      default:
        // 其餘方法在模擬 API 中只驗證參數與欄位型別，資料原樣通過
        break;
    }
  }
  return frame;
}

// ---------- 狀態 ----------

function datasetOut(d: StoredDataset): Dataset {
  const { frame: _f, report: _r, targetFeature: _t, ...rest } = d;
  return rest;
}

function makeDataset(id: number, projectId: number, name: string, filename: string, user: string, text: string, schema: { columns: SchemaColumn[] }) {
  const { report, frame } = validateCsv(text, schema);
  const prefix = `projects/${projectId}/tabular/${id}/`;
  const normalised = schema.columns.map((c) => ({
    name: c.name,
    type: c.type,
    required: c.required ?? false,
    min: c.min ?? null,
    max: c.max ?? null,
    allowed: c.allowed ?? null,
    unique: c.unique ?? false,
    pattern: c.pattern ?? null,
    ...(c.missing_values ? { missing_values: c.missing_values } : {}),
  }));
  const dataset: StoredDataset = {
    id,
    project_id: projectId,
    name,
    original_filename: filename,
    object_key: `${prefix}clean.csv`,
    original_key: `${prefix}original.csv`,
    schema: { columns: normalised },
    total_rows: report.total_rows,
    valid_rows: report.valid_rows,
    rejected_rows: report.rejected_row_count,
    created_by: user,
    created_at: isoNow(),
    frame,
    report,
    targetFeature: null,
  };
  return { dataset, report };
}

function seed(): State {
  const schema = COHORT_SCHEMA as { columns: SchemaColumn[] };
  return {
    datasets: [
      makeDataset(1, 2, 'cohort_01', 'cohort_01.csv', 'admin01', COHORT_CSV, schema).dataset,
      makeDataset(2, 1, 'lung-clinical', 'cohort_01.csv', 'pi01', COHORT_CSV, schema).dataset,
    ],
    nextId: 3,
  };
}

const state = () => moduleState('tabular', seed);

function find(pid: number, id: unknown): StoredDataset | Response {
  const d = state().datasets.find((x) => x.id === Number(id) && x.project_id === pid);
  return d ?? detail(404, `找不到資料集 ${id}`);
}

function guarded(run: () => unknown, status = 200): Response {
  try {
    return json(run(), status);
  } catch (e) {
    if (e instanceof MockError) return tabularError(e.code, e.message, e.extra);
    throw e;
  }
}

function renamed<T>(fixture: T, names: string[], intercept: boolean): T {
  const f = JSON.parse(JSON.stringify(fixture)) as { coefficients: { name: string }[]; forest?: { name: string }[] };
  const template = f.coefficients.filter((c) => c.name !== 'const');
  const make = <C extends { name: string }>(rows: C[]) => names.map((name, i) => ({ ...rows[i % rows.length], name }));
  f.coefficients = [...(intercept ? f.coefficients.filter((c) => c.name === 'const') : []), ...make(template)];
  if (f.forest) f.forest = make(f.forest);
  return f as T;
}

function parseSchema(schemaText: string): { columns: SchemaColumn[] } | Response {
  let schema: { columns: SchemaColumn[] };
  try {
    schema = JSON.parse(schemaText);
  } catch (e) {
    return tabularError('schema_invalid', `結構定義不是有效的 JSON：${(e as Error).message}`);
  }
  if (!Array.isArray(schema?.columns) || schema.columns.length === 0) {
    return tabularError('schema_invalid', '結構定義必須包含至少一個欄位（columns）');
  }
  const bad = schema.columns.find((c) => !(c.type in DTYPES));
  if (bad) return tabularError('schema_invalid', `欄位「${bad.name}」的型別「${bad.type}」不支援，可用型別：${Object.keys(DTYPES).join(', ')}`);
  return schema;
}

const BASE = `${API}/projects/:pid/tabular`;
const DS = `${BASE}/datasets/:id`;

function dataset(request: Request, params: Record<string, unknown>, permission: 'project' | 'training' = 'project') {
  const ctx = requireProject(request, params.pid, permission);
  if (ctx instanceof Response) return ctx;
  const d = find(ctx.project.id, params.id);
  if (d instanceof Response) return d;
  return { ctx, d };
}

const query = (request: Request) => new URL(request.url).searchParams;
const list = (q: URLSearchParams, key: string) => (q.has(key) ? q.getAll(key) : null);

export const tabularHandlers = [
  http.get(`${BASE}/preprocessing/catalogue`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    return ctx instanceof Response ? ctx : json(catalogue);
  }),

  http.get(`${BASE}/datasets`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    return json(state().datasets.filter((d) => d.project_id === ctx.project.id).map(datasetOut));
  }),

  http.post(`${BASE}/schema/infer`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return json({ detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }] }, 422);
    let tokens = DEFAULT_MISSING_VALUES;
    const raw = form.get('missing_values');
    if (typeof raw === 'string') {
      try {
        tokens = JSON.parse(raw);
        if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string')) throw new Error('not a list');
      } catch {
        return tabularError('invalid_missing_values', '缺值寫法必須是 JSON 文字陣列，例如 ["NA", "-"]');
      }
    }
    const text = new TextDecoder().decode(await file.arrayBuffer());
    try {
      const inferred = inferFromTable(parseCsv(text), tokens);
      const { report } = validateCsv(text, inferred.schema);
      return json({ ...inferred, encoding: 'utf-8', report });
    } catch (e) {
      if (e instanceof InferError) return tabularError(e.code, e.message);
      throw e;
    }
  }),

  http.post(`${BASE}/schema/check`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const form = await request.formData();
    const file = form.get('file');
    const schemaText = form.get('schema');
    if (!file || typeof file === 'string' || typeof schemaText !== 'string') return json({ detail: [{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }] }, 422);
    const schema = parseSchema(schemaText);
    if (schema instanceof Response) return schema;
    const text = new TextDecoder().decode(await file.arrayBuffer());
    return json({ report: validateCsv(text, schema).report });
  }),

  http.post(`${BASE}/datasets`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training'); // 建立資料集需要 Training
    if (ctx instanceof Response) return ctx;
    const form = await request.formData();
    const file = form.get('file');
    const schemaText = form.get('schema');
    if (!file || typeof file === 'string') return json({ detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }] }, 422);
    if (typeof schemaText !== 'string') return json({ detail: [{ type: 'missing', loc: ['body', 'schema'], msg: 'Field required', input: null }] }, 422);
    const schema = parseSchema(schemaText);
    if (schema instanceof Response) return schema;
    const s = state();
    const name = (typeof form.get('name') === 'string' ? (form.get('name') as string).trim() : '') || file.name || 'data.csv';
    const text = new TextDecoder().decode(await file.arrayBuffer());
    const { dataset: d, report } = makeDataset(s.nextId, ctx.project.id, name, file.name || 'data.csv', ctx.user.username, text, schema);
    if (report.errors.length) return tabularError(report.errors[0].code, report.errors[0].message, { report });
    if (report.valid_rows === 0) return tabularError('no_valid_rows', '沒有任何一列通過驗證，未建立資料集', { report });
    if (s.datasets.some((x) => x.project_id === ctx.project.id && x.name === name)) return detail(409, '資料重複，請改用其他名稱');
    s.nextId++;
    s.datasets.push(d);
    return json({ dataset: datasetOut(d), report }, 201);
  }),

  http.get(DS, ({ request, params }) => {
    const r = dataset(request, params);
    return r instanceof Response ? r : json({ ...datasetOut(r.d), columns: columnInfo(r.d.frame) });
  }),

  http.get(`${DS}/report`, ({ request, params }) => {
    const r = dataset(request, params);
    return r instanceof Response ? r : json(r.d.report);
  }),

  http.delete(DS, ({ request, params }) => {
    const r = dataset(request, params, 'training'); // 刪除需要 Training
    if (r instanceof Response) return r;
    const s = state();
    s.datasets = s.datasets.filter((x) => x.id !== r.d.id);
    if (s.columnViews) s.columnViews = Object.fromEntries(Object.entries(s.columnViews).filter(([k]) => !k.startsWith(`${r.d.id}:`)));
    return noContent();
  }),

  http.get(`${DS}/describe`, ({ request, params }) => {
    const r = dataset(request, params);
    return r instanceof Response ? r : guarded(() => describe(r.d.frame));
  }),

  http.get(`${DS}/histogram`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const q = query(request);
    return guarded(() => histogram(r.d.frame, q.get('column') ?? '', Number(q.get('bins') ?? 10)));
  }),

  http.get(`${DS}/value-counts`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const q = query(request);
    return guarded(() => valueCounts(r.d.frame, q.get('column') ?? '', Number(q.get('limit') ?? 50)));
  }),

  http.get(`${DS}/preview`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const q = query(request);
    return guarded(() => preview(r.d.frame, Number(q.get('offset') ?? 0), Number(q.get('limit') ?? 50), list(q, 'columns')));
  }),

  http.get(`${DS}/correlation`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const q = query(request);
    return guarded(() => correlation(r.d.frame, list(q, 'columns'), q.get('method') ?? 'pearson'));
  }),

  http.get(`${DS}/scatter`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const q = query(request);
    return guarded(() => scatter(r.d.frame, q.get('x') ?? '', q.get('y') ?? '', Number(q.get('limit') ?? 5000)));
  }),

  http.post(`${DS}/preprocess/preview`, async ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const b = await jsonBody(request);
    return guarded(() => {
      const out = applyPipeline(r.d.frame, b.steps ?? []);
      return {
        row_count: out.rows.length,
        columns: columnInfo(out),
        preview: preview(out, Number(b.offset ?? 0), Number(b.limit ?? 50), (b.columns as string[] | null) ?? null),
      };
    });
  }),

  http.get(`${DS}/column-view`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const saved = state().columnViews?.[`${r.d.id}:${r.ctx.user.username}`];
    return json({ hidden: saved ?? [], saved: saved !== undefined });
  }),

  http.put(`${DS}/column-view`, async ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const b = await jsonBody(request);
    const hidden = b.hidden as unknown;
    if (!Array.isArray(hidden) || hidden.some((c) => typeof c !== 'string')) return validation('hidden', 'Input should be a valid list', 'list_type');
    if (new Set(hidden).size !== hidden.length) return detail(422, '隱藏欄位有重複的名稱');
    const unknown = hidden.filter((c) => !r.d.frame.columns.includes(c as string));
    if (unknown.length) return detail(422, `資料集沒有這些欄位：${unknown.join('、')}`);
    const s = state();
    s.columnViews = { ...(s.columnViews ?? {}), [`${r.d.id}:${r.ctx.user.username}`]: [...(hidden as string[])] };
    return json({ hidden, saved: true });
  }),

  http.get(`${DS}/target-feature`, ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    return r.d.targetFeature ? json(r.d.targetFeature) : detail(404, `資料集 ${r.d.id} 尚未設定 Target 與 Feature`);
  }),

  http.put(`${DS}/target-feature`, async ({ request, params }) => {
    const r = dataset(request, params, 'training');
    if (r instanceof Response) return r;
    const b = await jsonBody(request);
    return guarded(() => {
      if (typeof b.target !== 'string' || !('features' in b)) throw new MockError('invalid_config', '設定格式錯誤：必須包含 target 與 features');
      if (!b.target) throw new MockError('invalid_config', '請指定 Target 欄位（Target）');
      const features = b.features as string[];
      if (!Array.isArray(features) || features.length === 0) throw new MockError('invalid_config', '請至少選擇一個 Feature 欄位（Feature）');
      if (features.includes(b.target)) throw new MockError('invalid_config', `Target 欄位「${b.target}」不可同時作為 Feature 欄位`);
      const steps = validateSteps(b.steps ?? []);
      requireColumns(applyPipeline(r.d.frame, steps), [b.target, ...features]);
      const missing = b.missing as unknown;
      if (missing !== undefined && missing !== null && missing !== 'impute' && missing !== 'drop') {
        throw new MockError('invalid_config', '缺值處理必須是 impute（補值）或 drop（不使用有缺值的病人）');
      }
      r.d.targetFeature = {
        dataset_id: r.d.id,
        config: { version: 1, target: b.target, features: [...features], steps, ...(missing ? { missing: missing as 'impute' | 'drop' } : {}) },
        updated_by: r.ctx.user.username,
        updated_at: isoNow(),
      };
      return r.d.targetFeature;
    });
  }),

  ...(['logistic', 'linear'] as const).map((model) =>
    http.post(`${DS}/stats/${model}`, async ({ request, params }) => {
      const r = dataset(request, params);
      if (r instanceof Response) return r;
      const b = await jsonBody(request);
      return guarded(() => {
        const frame = applyPipeline(r.d.frame, b.steps ?? []);
        const target = String(b.target ?? '');
        const features = (b.features ?? []) as string[];
        if (features.length === 0) throw new MockError('invalid_argument', '請至少選擇一個 Feature 欄位');
        if (features.includes(target)) throw new MockError('invalid_argument', `欄位「${target}」不可同時作為結果與特徵`);
        const y = numeric(frame, target);
        features.forEach((f) => numeric(frame, f));
        if (model === 'logistic' && y.some((v) => v !== null && v !== 0 && v !== 1)) {
          throw new MockError('not_binary', `結果欄位「${target}」必須只包含 0 與 1`);
        }
        return { ...renamed(STATS_FIXTURES[model], features, true), target, features, n: frame.rows.length };
      });
    }),
  ),

  http.post(`${DS}/stats/kaplan-meier`, async ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const b = await jsonBody(request);
    return guarded(() => {
      const frame = applyPipeline(r.d.frame, b.steps ?? []);
      numeric(frame, String(b.duration ?? ''));
      numeric(frame, String(b.event ?? ''));
      const group = typeof b.group === 'string' && b.group ? b.group : null;
      const base = { duration: b.duration, event: b.event, group_by: group, n: frame.rows.length };
      if (!group) return { ...STATS_FIXTURES.km_all, ...base };
      const levels = [...new Set(column(frame, group).filter((v) => v !== null).map(String))].sort();
      const template = STATS_FIXTURES.km.groups;
      return { ...STATS_FIXTURES.km, ...base, groups: levels.map((g, i) => ({ ...template[i % template.length], group: g })) };
    });
  }),

  http.post(`${DS}/stats/cox`, async ({ request, params }) => {
    const r = dataset(request, params);
    if (r instanceof Response) return r;
    const b = await jsonBody(request);
    return guarded(() => {
      const frame = applyPipeline(r.d.frame, b.steps ?? []);
      numeric(frame, String(b.duration ?? ''));
      numeric(frame, String(b.event ?? ''));
      const covariates = (b.covariates ?? []) as string[];
      if (covariates.length === 0) throw new MockError('invalid_argument', '請至少選擇一個共變項');
      covariates.forEach((c) => numeric(frame, c));
      return { ...renamed(STATS_FIXTURES.cox, covariates, false), duration: b.duration, event: b.event, covariates, n: frame.rows.length };
    });
  }),
];

/** Dashboard 模擬用：每個專案的結構式資料集數。 */
export function mockDatasetCounts(): Map<number, number> {
  const out = new Map<number, number>();
  for (const d of state().datasets) out.set(d.project_id, (out.get(d.project_id) ?? 0) + 1);
  return out;
}

/** 各階段處理程式碼的專案包匯入：本專案的結構式資料集（可對應的候選）。 */
export function mockDatasetList(projectId: number): { id: number; name: string; valid_rows: number | null }[] {
  return state().datasets.filter((d) => d.project_id === projectId).map((d) => ({ id: d.id, name: d.name, valid_rows: d.valid_rows ?? null }));
}
