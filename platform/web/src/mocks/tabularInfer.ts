// 模擬 platform/libs/tabular/tabular/infer.py：由 CSV 推斷欄位結構（規則與門檻相同，訊息相同）。
import type { InferColumn, SchemaColumn } from '../pages/tabular/types';

export const DEFAULT_MISSING_VALUES = ['NA', 'N/A', 'null', 'NaN', 'none', '-'];
const THRESHOLD = 0.9;
const MAX_CATEGORIES = 20;
const RARE_MIN_VALUES = 20;
const RARE_MIN_COUNT = 3;
const RARE_SHARE = 0.005;
const IDENTIFIER_DISTINCT = 0.9;

export const TYPE_ZH: Record<string, string> = { int: '整數', float: '小數', category: '類別', str: '文字', date: '日期', bool: '是否' };

const BOOL = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 't', 'f', '是', '否']);
const ID_NAME = /(^|[_\s-])id$|^id([_\s-]|$)|病歷|編號|身分證|身份證|識別|代號/i;

const CLINICAL_RANGES: [string[], number, number][] = [
  [['age', '年齡', '年紀'], 0, 120],
  [['bmi'], 10, 80],
  [['sbp', 'systolic', 'systolicbp', '收縮壓'], 40, 300],
  [['dbp', 'diastolic', 'diastolicbp', '舒張壓'], 20, 200],
  [['hr', 'heartrate', 'pulse', '心跳', '心率', '脈搏'], 20, 300],
  [['temp', 'temperature', 'bt', '體溫'], 30, 45],
  [['spo2', '血氧', '血氧飽和度'], 50, 100],
  [['rr', 'respiratoryrate', '呼吸', '呼吸速率', '呼吸次數'], 0, 80],
  [['height', '身高'], 20, 250],
  [['weight', '體重'], 0.2, 400],
];

function clinicalRange(name: string): [number, number] | null {
  const key = name
    .replace(/[（(\[【].*?[)）\]】]/g, '')
    .replace(/[\s_\-.]/g, '')
    .toLowerCase();
  const hit = CLINICAL_RANGES.find(([names]) => names.includes(key));
  return hit ? [hit[1], hit[2]] : null;
}

const isInt = (v: string) => /^[+-]?\d+$/.test(v);
const asFloat = (v: string) => {
  if (v.trim() === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?$/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10)));
const CHECKS: [string, (v: string) => boolean][] = [
  ['bool', (v) => BOOL.has(v.toLowerCase())],
  ['int', isInt],
  ['float', (v) => asFloat(v) !== null],
  ['date', isDate],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function digitPattern(values: string[]): string | null {
  const shape = (v: string) => v.replace(/\d+/g, '\0');
  const counts = new Map<string, number>();
  for (const v of values) counts.set(shape(v), (counts.get(shape(v)) ?? 0) + 1);
  const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top.includes('\0') || count / values.length < THRESHOLD) return null;
  const runs = values.filter((v) => shape(v) === top).map((v) => v.match(/\d+/g) ?? []);
  const parts = top.split('\0');
  let out = escape(parts[0]);
  parts.slice(1).forEach((literal, i) => {
    const lengths = new Set(runs.map((r) => r[i].length));
    out += lengths.size === 1 ? `\\d{${[...lengths][0]}}` : '\\d+';
    out += escape(literal);
  });
  return `^${out}$`;
}

export function inferColumn(name: string, values: string[], missingValues: string[]): { spec: SchemaColumn; summary: InferColumn } {
  const tokens = new Set(missingValues.map((v) => v.toLowerCase()));
  const present = values.filter((v) => v !== '' && !tokens.has(v.toLowerCase()));
  const n = present.length;
  const missing = values.length - n;
  const distinct = new Map<string, number>();
  for (const v of present) distinct.set(v, (distinct.get(v) ?? 0) + 1);
  const spec: SchemaColumn = { name, type: 'str', required: missing === 0, min: null, max: null, allowed: null, unique: false, pattern: null, missing_values: [...missingValues] };
  const summary: InferColumn = {
    name,
    type: 'str',
    required: missing === 0,
    missing,
    distinct: distinct.size,
    examples: [...distinct.keys()].slice(0, 3),
    non_conforming: 0,
    observed_min: null,
    observed_max: null,
    rare_values: [],
    identifier: false,
    range_source: null,
    notes: [],
    binary01: false,
  };
  const notes = summary.notes;
  const done = () => {
    if (missing && n) notes.push(`有 ${missing} 格空白或缺值，設為選填；如果這欄不該空白，請勾選「必填」`);
    summary.type = spec.type;
    summary.required = spec.required ?? false;
    return { spec, summary };
  };
  if (n === 0) {
    spec.required = false;
    notes.push('這欄全部空白或缺值');
    return done();
  }
  for (const [type, check] of CHECKS) {
    const fits = present.filter(check);
    if (fits.length / n >= THRESHOLD) {
      spec.type = type;
      const bad = present.filter((v) => !check(v));
      if (bad.length) {
        summary.non_conforming = bad.length;
        notes.push(`有 ${bad.length} 格不是${TYPE_ZH[type]}（例如「${bad[0]}」），上傳時這些列會被拒絕；如果這些值是正確的，請把型態改成「文字」`);
      }
      break;
    }
  }
  if (spec.type === 'int' || spec.type === 'float') {
    const check = spec.type === 'int' ? isInt : (v: string) => asFloat(v) !== null;
    const numbers = present.filter(check).map(Number);
    summary.observed_min = Math.min(...numbers);
    summary.observed_max = Math.max(...numbers);
    if (spec.type === 'int' && new Set(numbers).size === 2 && numbers.every((x) => x === 0 || x === 1)) {
      summary.binary01 = true;
      notes.push('只有 0、1 兩種值：視為「整數（0／1，是／否）」，1＝是；存的值仍是 0 與 1');
    }
    const bounds = clinicalRange(name);
    const share = (pred: (x: number) => boolean) => numbers.filter(pred).length / numbers.length;
    if (bounds && share((x) => x >= bounds[0] && x <= bounds[1]) >= THRESHOLD) {
      [spec.min, spec.max] = bounds;
      summary.range_source = 'name';
      notes.push(`依欄名建議合理範圍 ${bounds[0]}–${bounds[1]}，超出的列會被拒絕；可自行修改`);
    } else if (share((x) => x >= 0) >= THRESHOLD) {
      spec.min = 0;
      summary.range_source = 'nonnegative';
      if (Math.min(...numbers) < 0) notes.push('幾乎都不是負數，最小值設為 0，負數的列會被拒絕；如果負數是正確的，請清空最小值');
    }
    if (spec.type === 'int' && ID_NAME.test(name) && missing === 0 && distinct.size / n >= IDENTIFIER_DISTINCT) {
      spec.unique = true;
      summary.identifier = true;
      notes.push('像是識別碼（每列都不同）：設為不可重複，重複的列會被拒絕');
    }
  } else if (spec.type === 'date') {
    const dates = present.filter(isDate).map((v) => v.slice(0, 10)).sort();
    summary.observed_min = dates[0];
    summary.observed_max = dates[dates.length - 1];
  } else if (spec.type === 'str') {
    inferText(name, present, missing, distinct, spec, summary);
  }
  return done();
}

function inferText(name: string, present: string[], missing: number, distinct: Map<string, number>, spec: SchemaColumn, summary: InferColumn) {
  const n = present.length;
  const notes = summary.notes;
  const pattern = digitPattern(present);
  const few = distinct.size <= MAX_CATEGORIES && distinct.size <= n / 2;
  if (pattern) {
    spec.pattern = pattern;
    const re = new RegExp(pattern);
    const example = present.find((v) => re.test(v));
    const bad = present.filter((v) => !re.test(v));
    summary.non_conforming = bad.length;
    notes.push(`格式固定（如「${example}」），格式不符的列會被拒絕${bad.length ? `；目前有 ${bad.length} 格不符（例如「${bad[0]}」）` : ''}`);
  }
  if ((pattern !== null || ID_NAME.test(name)) && missing === 0 && distinct.size / n >= IDENTIFIER_DISTINCT) {
    spec.unique = true;
    summary.identifier = true;
    notes.push('幾乎每列都不同，像是病歷號等識別碼：設為不可重複，重複的列會被拒絕');
    return;
  }
  if (!few) return;
  spec.type = 'category';
  if (pattern) return;
  let allowed: string[];
  let rare: string[] = [];
  const sorted = [...distinct.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (n >= RARE_MIN_VALUES) {
    const floor = Math.max(RARE_MIN_COUNT, Math.ceil(RARE_SHARE * n));
    allowed = sorted.filter(([, c]) => c >= floor).map(([v]) => v);
    rare = sorted.filter(([, c]) => c < floor).map(([v]) => v);
  } else allowed = sorted.map(([v]) => v);
  if (allowed.length === 0) {
    spec.type = 'str';
    return;
  }
  spec.allowed = allowed;
  summary.rare_values = rare;
  if (rare.length) {
    const shown = rare.slice(0, 5).map((v) => `「${v}」`).join('、') + (rare.length > 5 ? '等' : '');
    notes.push(`${shown}出現次數很少，沒有列入允許的值，上傳時這些列會被拒絕；如果是正確的值，請加到「允許的值」`);
  }
}

export class InferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** table：parseCsv 的結果（已去除空白行）。回傳推斷的結構與每欄摘要；預檢由呼叫端以 validateCsv 執行。 */
export function inferFromTable(table: string[][], missingValues: string[] = DEFAULT_MISSING_VALUES) {
  if (table.length === 0) throw new InferError('empty_file', '檔案是空的，沒有任何欄位或資料');
  const header = table[0].map((h) => h.trim());
  const blank = header.map((h, i) => (h ? 0 : i + 1)).filter(Boolean);
  if (blank.length) throw new InferError('blank_column_name', `第 ${blank.join('、')} 欄沒有欄名，請在檔案第一列補上欄名後再上傳`);
  const dupes = [...new Set(header.filter((h, i) => header.indexOf(h) !== i))];
  if (dupes.length) {
    const where = dupes.map((h) => `${h}（第 ${header.flatMap((x, i) => (x === h ? [i + 1] : [])).join('、')} 欄）`).join('；');
    throw new InferError('duplicate_columns', `欄名重複：${where}，請改成不同名稱後再上傳`);
  }
  if (table.length === 1) throw new InferError('empty_file', '檔案只有標題列，沒有任何資料列');
  const body = table.slice(1).filter((r) => r.length === header.length);
  const tokens = missingValues.map((v) => v.trim()).filter(Boolean);
  const results = header.map((name, j) => inferColumn(name, body.map((r) => r[j].trim()), tokens));
  return { row_count: table.length - 1, missing_values: tokens, schema: { columns: results.map((r) => r.spec) }, columns: results.map((r) => r.summary) };
}
