// 二元分類的「陽性類別的機率」（修正缺陷 1）：畫面上一律顯示陽性類別（例如 diagnosis＝1）的機率，
// 不是「預測類別的機率」（後者會被讀成「94% 會確診」）。陽性類別＝訓練資料的類別排序後的第二個（0／1 時是「1」），
// 與訓練結果的 ROC、敏感度相同。
import type { Model } from './api';

/** 二元分類的陽性類別；推論結果帶 positive_label 時以它為準，否則用模型卡的 classes[1]。不是二元分類時為 null。 */
export function positiveLabel(model: Pick<Model, 'kind' | 'card'>, result?: { positive_label?: string | null } | null): string | null {
  if (model.kind !== 'tabular_classification') return null;
  if (result?.positive_label) return result.positive_label;
  const classes = model.card.classes ?? [];
  return classes.length === 2 ? String(classes[1]) : null;
}

/** 「1」與「1.0」視為同一類 */
export const sameLabel = (a: string, b: string) => a === b || (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(Number(a)) && Number(a) === Number(b));

/**
 * 一列的陽性類別機率（0～1）：有 `{p}_positive_probability` 欄時用它；舊的紀錄沒有這一欄，
 * 由預測類別與其機率換算（預測為陽性時 p，否則 1 − p）。沒有預測時為 null。
 */
export function positiveChance(row: string[], columns: string[], predictionColumn: string, positive: string): number | null {
  const own = columns.indexOf(`${predictionColumn}_positive_probability`);
  if (own >= 0) return row[own] === '' || row[own] === undefined ? null : Number(row[own]);
  const at = columns.indexOf(predictionColumn);
  const prob = columns.indexOf(`${predictionColumn}_probability`);
  if (at < 0 || prob < 0 || (row[at] ?? '') === '' || (row[prob] ?? '') === '') return null;
  const p = Number(row[prob]);
  return sameLabel(row[at], positive) ? p : Math.round((1 - p) * 10000) / 10000;
}

export const percent = (v: number) => `${Math.round(v * 100)}%`;

/** 說明欄的機率前綴（新格式「diagnosis＝1 的機率 6%」或舊格式「預測為「0」的機率 94%」）之後的補值說明；沒有前綴時是整段。 */
export function noteRest(note: string): string {
  const match = /^(?:預測為「.*?」|\S+＝\S+ )的機率 \d+%(?:（(.*)）)?$/.exec(note);
  return match ? (match[1] ?? '') : note;
}

/** 二元分類的說明欄：一律寫陽性類別的機率，後面附上補值說明（舊紀錄的「預測為「0」的機率 94%」也換掉）。 */
export function positiveNote(note: string, target: string, positive: string, chance: number | null): string {
  if (chance === null) return note;
  const rest = noteRest(note);
  return `${target}＝${positive} 的機率 ${percent(chance)}` + (rest ? `（${rest}）` : '');
}
