// 欄位總覽（Target 與 Feature 分頁、描述統計）共用的判斷：白話型態、提示、One-Hot 步驟與 Feature 展開。
import type { ColumnInfo, DescribeColumn, MissingChoice, SchemaColumn, Step } from './types';

export const HIGH_MISSING = 0.3;
const FEW_CODES = 10;

export interface ColumnFacts {
  name: string;
  kind: ColumnInfo['kind'];
  schemaType?: string;
  missing: number;
  unique: number;
  rows: number;
  min?: number;
  max?: number;
}

export function facts(columns: ColumnInfo[], rows: number, schema: SchemaColumn[] = [], describe: DescribeColumn[] = []): ColumnFacts[] {
  return columns.map((c) => {
    const d = describe.find((x) => x.name === c.name);
    return {
      name: c.name,
      kind: c.kind,
      schemaType: schema.find((s) => s.name === c.name)?.type,
      missing: c.missing,
      unique: c.unique ?? d?.unique ?? 0,
      rows,
      min: typeof d?.min === 'number' ? d.min : undefined,
      max: typeof d?.max === 'number' ? d.max : undefined,
    };
  });
}

/** 只有 0 與 1 的數字欄（例如 diagnosis、event） */
export const isBinary01 = (f: ColumnFacts) => f.kind === 'numeric' && f.unique > 0 && f.unique <= 2 && f.min !== undefined && f.min >= 0 && f.max !== undefined && f.max <= 1 && Number.isInteger(f.min) && Number.isInteger(f.max);

/** 每列都不同（例如病歷號）：不適合當 Feature */
export const isIdentifier = (f: ColumnFacts) => f.rows > 1 && f.missing === 0 && f.unique === f.rows && (f.kind !== 'numeric' || f.schemaType === 'int' || f.schemaType === undefined) && f.kind !== 'datetime';

/** 數字只有少數幾種，可能是代碼（0、1、2） */
export const looksLikeCodes = (f: ColumnFacts) => f.kind === 'numeric' && !isBinary01(f) && f.unique > 2 && f.unique <= FEW_CODES && f.schemaType !== 'float';

export const isTextual = (f: ColumnFacts) => f.kind === 'categorical' || f.kind === 'text';

export function typeLabel(f: ColumnFacts): string {
  if (isIdentifier(f)) return '識別碼';
  if (isBinary01(f)) return '是／否（0／1）';
  if (f.kind === 'boolean') return '是／否';
  if (f.kind === 'datetime') return '日期';
  if (f.kind === 'numeric') return f.schemaType === 'int' ? '整數' : f.schemaType === 'float' ? '小數' : '數值';
  if (f.schemaType === 'category' || f.kind === 'categorical') return f.unique <= 20 ? '類別' : '文字';
  return '文字';
}

export interface Hint {
  text: string;
  warn: boolean;
}

export function hints(f: ColumnFacts, role: 'target' | 'feature' | 'none', encoded: boolean): Hint[] {
  const out: Hint[] = [];
  if (role === 'target') {
    if (f.missing > 0) out.push({ text: `Target 有 ${f.missing} 列缺值，這些列無法用來訓練；可在「前處理」刪除缺值的列`, warn: true });
    if (f.unique <= 1) out.push({ text: 'Target 只有一種值，無法訓練模型', warn: true });
  }
  if (role === 'feature') {
    if (isIdentifier(f)) out.push({ text: '每列都不同，像是病歷號等識別碼，建議不要當 Feature', warn: true });
    if (f.rows && f.missing / f.rows >= HIGH_MISSING) out.push({ text: `缺值 ${Math.round((f.missing / f.rows) * 100)}%，建議在「前處理」補值或不要使用`, warn: true });
    if (isTextual(f) && !encoded) out.push({ text: '文字或類別欄位要先轉成 One-Hot 才能訓練：請打開「當作類別」', warn: true });
  }
  if (role !== 'target' && looksLikeCodes(f) && !encoded) out.push({ text: `只有 ${f.unique} 種數字；若是代碼（例如 0、1、2 代表不同分類），請打開「當作類別」`, warn: false });
  if (role === 'none' && isIdentifier(f)) out.push({ text: '識別碼（每列都不同）', warn: false });
  return out;
}

// ---------- One-Hot 步驟 ----------

/** 前處理步驟中做 One-Hot 的欄位 */
export const encodedColumns = (steps: Step[]) => new Set(steps.filter((s) => s.id === 'onehot').flatMap((s) => s.columns));

function withColumn(steps: Step[], id: string, params: Record<string, unknown>, column: string, matches: (s: Step) => boolean): Step[] {
  const at = steps.findIndex((s) => s.id === id && matches(s) && s.columns.length > 0);
  if (at >= 0) return steps.map((s, i) => (i === at && !s.columns.includes(column) ? { ...s, columns: [...s.columns, column] } : s));
  return [...steps, { id, columns: [column], params }];
}

const isCategoryCast = (s: Step) => s.id === 'cast_type' && s.params.dtype === 'category';

/**
 * 「當作類別」打開：數字欄先「轉換資料型別→類別」，再 One-Hot；文字欄直接 One-Hot。
 * 轉型步驟一定放在 One-Hot 之前。
 */
export function encode(steps: Step[], column: string, numeric: boolean): Step[] {
  let next = steps;
  if (numeric) {
    next = withColumn(next, 'cast_type', { dtype: 'category' }, column, isCategoryCast);
    const cast = next.findIndex((s) => isCategoryCast(s) && s.columns.includes(column));
    const hot = next.findIndex((s) => s.id === 'onehot' && s.columns.length > 0);
    if (hot >= 0 && hot < cast) {
      // 既有的 One-Hot 在轉型之前：另外加一個在後面的 One-Hot
      return [...next, { id: 'onehot', columns: [column], params: { drop_first: false } }];
    }
  }
  return withColumn(next, 'onehot', { drop_first: false }, column, () => true);
}

/** 「當作類別」關閉：從轉型與 One-Hot 步驟移除這一欄，步驟空了就刪掉（空欄位清單代表「全部欄位」）。 */
export function unencode(steps: Step[], column: string): Step[] {
  return steps
    .map((s) => (s.id === 'onehot' || isCategoryCast(s) ? { ...s, columns: s.columns.filter((c) => c !== column) } : s))
    .filter((s) => !((s.id === 'onehot' || isCategoryCast(s)) && s.columns.length === 0));
}

// ---------- Feature 展開 ----------

/** 前處理後不存在的 Feature 換成它產生的欄位（例如 sex → sex_F、sex_M）。 */
export function expandFeatures(chosen: string[], before: string[], after: string[]): { features: string[]; unresolved: string[] } {
  const created = after.filter((c) => !before.includes(c));
  const features: string[] = [];
  const unresolved: string[] = [];
  for (const f of chosen) {
    if (after.includes(f)) features.push(f);
    else {
      const derived = created.filter((c) => c.startsWith(`${f}_`));
      if (derived.length) features.push(...derived);
      else unresolved.push(f);
    }
  }
  return { features: [...new Set(features)], unresolved };
}

/** 已儲存的 Feature 對回原始欄位：sex_F、sex_M → sex；對不回去的（例如 PCA 產生的）另外列出。 */
export function collapseFeatures(saved: string[], original: string[], encoded: Set<string>): { columns: string[]; other: string[] } {
  const columns: string[] = [];
  const other: string[] = [];
  for (const f of saved) {
    if (original.includes(f)) columns.push(f);
    else {
      const source = [...encoded].filter((c) => f.startsWith(`${c}_`)).sort((a, b) => b.length - a.length)[0];
      if (source) columns.push(source);
      else other.push(f);
    }
  }
  return { columns: [...new Set(columns)], other };
}

// ---------- 給人看的數目（使用者勾了幾欄，而不是 One-Hot 之後的欄數） ----------

/** 例如「7 個欄位（sex、smoker 自動拆成 5 欄）」：以使用者勾的原始欄位計數，One-Hot 拆出的欄位另外說明。 */
export function featureCountText(features: string[], original: string[], steps: Step[]): string {
  const encoded = encodedColumns(steps);
  const back = collapseFeatures(features, original, encoded);
  const columns = [...new Set([...back.columns, ...back.other])];
  const split = [...new Set(back.columns.filter((c) => encoded.has(c) && !features.includes(c)))];
  const derived = features.filter((f) => !original.includes(f) && split.some((c) => f.startsWith(`${c}_`)));
  return `${columns.length} 個欄位` + (split.length ? `（${split.join('、')} 自動拆成 ${derived.length} 欄）` : '');
}

/** 缺值處理的一句話；沒有設定（舊設定）時為空字串。 */
export function missingText(missing: MissingChoice | undefined): string {
  if (missing === 'impute') return '有缺值的病人：補上缺值後使用';
  if (missing === 'drop') return '有缺值的病人：不使用';
  return '';
}

const STEP_NAMES: Record<string, string> = { onehot: 'One-Hot 編碼', cast_type: '轉換資料型別' };

/** 沒有前處理方法清單時（例如建模管理）用的步驟名稱：常用的寫中文，其他保留代號。 */
export function stepLabel(step: Step): string {
  return `${STEP_NAMES[step.id] ?? step.id}：${step.columns.length ? step.columns.join('、') : '所有適用欄位'}`;
}
