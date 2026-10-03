// 有缺值的 Feature：說出哪些欄位缺幾位，一鍵選擇補上缺值或不使用這些病人。
// 資料集的 Target／Feature 分頁與建模管理的訓練設定共用。
import type { MissingChoice } from './types';

export interface MissingColumn {
  name: string;
  missing: number;
}

export function missingSummary(columns: MissingColumn[]): string {
  return columns.map((c) => `${c.name} 有 ${c.missing} 位`).join('、');
}

export function MissingChoiceField({ id, columns, value, onChange }: {
  id: string;
  columns: MissingColumn[];
  value: MissingChoice;
  onChange: (v: MissingChoice) => void;
}) {
  if (!columns.length) return null;
  return (
    <fieldset className="missing-choice" data-testid={`${id}-missing`}>
      <legend>有缺值的病人怎麼處理</legend>
      <p>
        選的 Feature 中，{missingSummary(columns)}病人沒有資料（缺值）。請選擇：
      </p>
      <div className="stack" role="radiogroup" aria-label="有缺值的病人怎麼處理">
        <label className="checkbox">
          <input type="radio" name={`${id}-missing`} checked={value === 'impute'} onChange={() => onChange('impute')} />
          補上缺值，所有病人都使用（建議）：數字補訓練資料的中位數，類別補最常見的值；預測時也照樣補上
        </label>
        <label className="checkbox">
          <input type="radio" name={`${id}-missing`} checked={value === 'drop'} onChange={() => onChange('drop')} />
          不使用這些病人：訓練時跳過他們，預測時有缺值的病人不會有結果
        </label>
      </div>
    </fieldset>
  );
}
