import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { parseParam, stepSummary } from '../../src/pages/tabular/StepsEditor';
import type { CatalogueItem } from '../../src/pages/tabular/types';
import { CATALOGUE } from '../../src/mocks/tabularData';
import { renderApp } from '../render';
import { bodyRows, cellsOf } from '../table';

type User = Awaited<ReturnType<typeof renderApp>>['user'];
const catalogue = CATALOGUE as unknown as CatalogueItem[];

async function addStep(user: User, category: string, method: string, columns: string[], params: Record<string, string> = {}) {
  const form = await screen.findByRole('form', { name: '加入前處理步驟' });
  await user.selectOptions(within(form).getByLabelText('類別'), within(form).getByRole('option', { name: new RegExp(`^${category}`) }));
  await user.selectOptions(within(form).getByLabelText('方法'), method);
  for (const c of columns) await user.click(within(form).getByRole('checkbox', { name: c }));
  for (const [label, value] of Object.entries(params)) {
    const field = within(form).getByLabelText(label);
    if (field instanceof HTMLSelectElement) await user.selectOptions(field, value);
    else await user.type(field, value);
  }
  await user.click(within(form).getByRole('button', { name: '加入步驟' }));
}

describe('前處理', () => {
  it('TC-B04-06 lists every method of the catalogue: at least 50, same as the API', async () => {
    await renderApp('/data/tabular/2/preprocess', 'vw01');
    expect(await screen.findByText(/^共 66 種前處理方法/)).toBeInTheDocument();
    const rows = bodyRows(screen.getByRole('table', { name: '前處理方法清單', hidden: true }));
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(rows.map((r) => r[1])).toEqual(catalogue.map((c) => c.id));
    expect(rows.map((r) => r[0])).toEqual(catalogue.map((c) => c.name_zh));
  });

  it('TC-B04-04 mean imputation then One-Hot: preview shows the new columns and no missing glucose', async () => {
    const { user } = await renderApp('/data/tabular/2/preprocess', 'vw01');
    await addStep(user, '缺值處理', '平均數補值', ['glucose']);
    await addStep(user, '類別編碼', 'One-Hot 編碼', ['sex'], { '移除第一個類別（避免共線）': 'false' });
    expect(within(screen.getByRole('list', { name: '已加入的步驟' })).getAllByRole('listitem').map((l) => l.firstChild?.textContent)).toEqual([
      '平均數補值：glucose',
      'One-Hot 編碼：sex（移除第一個類別（避免共線）＝false）',
    ]);
    await user.click(screen.getByRole('button', { name: '預覽套用結果' }));
    const result = await screen.findByRole('region', { name: '前處理預覽結果' });
    const table = within(result).getByRole('table', { name: '前處理後的資料預覽' });
    const head = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(head.slice(0, 5)).toEqual(['列', 'patient_id', 'age', 'sex_F', 'sex_M']);
    expect(bodyRows(table)[1].slice(3, 5)).toEqual(['1', '0']);
    expect(bodyRows(table)[1][head.indexOf('glucose')]).not.toBe('（空）');
    expect(within(result).getByRole('status')).toHaveTextContent('套用 2 個步驟後：100 列、13 欄，缺值合計 88 筆');
  });

  it('only offers columns the method applies to, and steps can be reordered and removed', async () => {
    const { user } = await renderApp('/data/tabular/2/preprocess', 'vw01');
    const form = await screen.findByRole('form', { name: '加入前處理步驟' });
    await user.selectOptions(within(form).getByLabelText('類別'), within(form).getByRole('option', { name: /^縮放與數值轉換/ }));
    await user.selectOptions(within(form).getByLabelText('方法'), '標準化（Z 分數）');
    expect(within(form).queryByRole('checkbox', { name: 'sex' })).toBeNull();
    expect(within(form).getByRole('checkbox', { name: 'age' })).toBeInTheDocument();
    await addStep(user, '縮放與數值轉換', '標準化（Z 分數）', ['age']);
    await addStep(user, '缺值處理', '中位數補值', ['glucose']);
    const steps = () => within(screen.getByRole('list', { name: '已加入的步驟' })).getAllByRole('listitem').map((l) => l.firstChild?.textContent);
    expect(steps()).toEqual(['標準化（Z 分數）：age', '中位數補值：glucose']);
    await user.click(screen.getByRole('button', { name: '第 2 步上移' }));
    expect(steps()).toEqual(['中位數補值：glucose', '標準化（Z 分數）：age']);
    await user.click(screen.getByRole('button', { name: '移除第 1 步' }));
    expect(steps()).toEqual(['標準化（Z 分數）：age']);
  });

  it('required columns and required parameters are checked before adding; 422 from the API is shown', async () => {
    const { user } = await renderApp('/data/tabular/2/preprocess', 'vw01');
    const form = await screen.findByRole('form', { name: '加入前處理步驟' });
    await user.selectOptions(within(form).getByLabelText('類別'), within(form).getByRole('option', { name: /^資料清理/ }));
    await user.selectOptions(within(form).getByLabelText('方法'), '刪除欄位');
    await user.click(within(form).getByRole('button', { name: '加入步驟' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('「刪除欄位」必須指定欄位');
    await user.selectOptions(within(form).getByLabelText('方法'), '取代特定值');
    await user.click(within(form).getByRole('button', { name: '加入步驟' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('請填寫「原值」');

    // 指定不存在的欄位 → API 回 422
    await user.selectOptions(within(form).getByLabelText('類別'), within(form).getByRole('option', { name: /^缺值處理/ }));
    await user.type(within(form).getByLabelText(/^其他欄位/), 'no_such_column');
    await user.click(within(form).getByRole('button', { name: '加入步驟' }));
    await user.click(screen.getByRole('button', { name: '預覽套用結果' }));
    expect(await screen.findByText('資料中找不到欄位：no_such_column')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '前處理預覽結果' })).toBeNull();
  });

  it('parseParam follows the JSON Schema type; stepSummary is readable', () => {
    const p = (id: string, key: string) => catalogue.find((c) => c.id === id)!.params.properties[key];
    expect(parseParam(p('impute_knn', 'n_neighbors'), '7')).toBe(7);
    expect(parseParam(p('impute_knn', 'n_neighbors'), '')).toBeUndefined();
    expect(parseParam(p('impute_constant', 'fill_value'), '0')).toBe(0);
    expect(parseParam(p('impute_constant', 'fill_value'), 'unknown')).toBe('unknown');
    expect(parseParam(p('onehot', 'drop_first'), 'true')).toBe(true);
    expect(parseParam(p('rename_columns', 'mapping'), '{"a":"b"}')).toEqual({ a: 'b' });
    expect(() => parseParam(p('rename_columns', 'mapping'), '{oops')).toThrow();
    expect(stepSummary({ id: 'impute_mean', columns: [], params: {} }, catalogue)).toBe('平均數補值：所有適用欄位');
    expect(stepSummary({ id: 'kbins_uniform', columns: ['age'], params: { n_bins: 4 } }, catalogue)).toBe('等寬分箱：age（分箱數＝4）');
  });
});

describe('Target 與 Feature', () => {
  async function save(user: User, target: string, features: string[]) {
    const form = await screen.findByRole('form', { name: '設定 Target 與 Feature' });
    await user.click(await within(form).findByRole('radio', { name: `以 ${target} 為 Target` }));
    for (const box of within(within(form).getByRole('table', { name: '欄位總覽' })).getAllByRole('checkbox')) {
      const wanted = features.includes(box.getAttribute('aria-label')!);
      if ((box as HTMLInputElement).checked !== wanted) await user.click(box);
    }
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
  }

  it('TC-B04-03 saves 3 different settings; each reload shows exactly what was saved', async () => {
    const settings: [string, string[]][] = [
      ['diagnosis', ['age', 'bmi', 'sbp']],
      ['event', ['age', 'dbp', 'glucose', 'time_to_event']],
      ['sbp', ['age']],
    ];
    for (const [target, features] of settings) {
      const first = await renderApp('/data/tabular/2/target', 'ra01');
      await save(first.user, target, features);
      expect(await screen.findByText(`已儲存：Target ${target}，${features.length} 個 Feature，0 個前處理步驟`)).toBeInTheDocument();
      first.unmount();

      const again = await renderApp('/data/tabular/2/target', 'ra01');
      expect(await screen.findByTestId('saved-target')).toHaveTextContent(target);
      expect(screen.getByTestId('saved-features')).toHaveTextContent(features.join('、'));
      const form = screen.getByRole('form', { name: '設定 Target 與 Feature' });
      expect(within(form).getByRole('radio', { name: `以 ${target} 為 Target` })).toBeChecked();
      const checked = within(form).getAllByRole('checkbox').filter((b) => (b as HTMLInputElement).checked);
      expect(checked.map((b) => b.getAttribute('aria-label'))).toEqual(features);
      again.unmount();
    }
  });

  it('preprocessing steps built in the 前處理 tab are saved with the settings and restored', async () => {
    const first = await renderApp('/data/tabular/2/preprocess', 'ra01');
    await addStep(first.user, '缺值處理', '中位數補值', ['glucose']);
    await first.user.click(within(screen.getByRole('navigation', { name: '資料集分頁' })).getByRole('link', { name: 'Target／Feature' }));
    await save(first.user, 'diagnosis', ['age', 'glucose']);
    expect(await screen.findByText('已儲存：Target diagnosis，2 個 Feature，1 個前處理步驟')).toBeInTheDocument();
    first.unmount();

    await renderApp('/data/tabular/2/target', 'ra01');
    expect(await screen.findByTestId('saved-steps')).toHaveTextContent('中位數補值：glucose');
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: '已加入的步驟' })).getAllByRole('listitem')[0]).toHaveTextContent('中位數補值：glucose'),
    );
  });

  it('the target cannot be a feature; 422 from the API is shown', async () => {
    const { user } = await renderApp('/data/tabular/2/target', 'ra01');
    const form = await screen.findByRole('form', { name: '設定 Target 與 Feature' });
    await user.click(within(form).getByRole('radio', { name: '以 diagnosis 為 Target' }));
    expect(within(form).queryByRole('checkbox', { name: 'diagnosis' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('請至少選擇一個特徵欄位（Feature）');
    await user.click(within(form).getByText('進階：其他 Feature'));
    await user.type(within(form).getByLabelText(/^其他 Feature/), 'sex_M');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('資料中找不到欄位：sex_M'));
    expect(screen.getByText('這個資料集尚未設定 Target 與 Feature。')).toBeInTheDocument();
  });

  it('column overview: types, missing and distinct counts, warnings for identifiers and text features', async () => {
    const { user } = await renderApp('/data/tabular/2/target', 'ra01');
    const table = await screen.findByRole('table', { name: '欄位總覽' });
    const row = (name: string) => within(table).getByRole('row', { name: new RegExp(`^${name} `) });
    await waitFor(() => expect(cellsOf(row('diagnosis')).slice(0, 4)).toEqual(['diagnosis', '是／否（0／1）', '0', '2']));
    expect(cellsOf(row('patient_id')).slice(0, 4)).toEqual(['patient_id', '識別碼', '0', '100']);
    expect(cellsOf(row('glucose')).slice(0, 4)).toEqual(['glucose', '小數', '5', '88']);
    await user.click(within(row('patient_id')).getByRole('checkbox'));
    expect(row('patient_id')).toHaveTextContent('像是病歷號等識別碼，建議不要當 Feature');
    await user.click(within(row('sex')).getByRole('checkbox'));
    expect(row('sex')).toHaveTextContent('要先轉成 One-Hot');
    expect(screen.getByText('有 Feature 還不能用來訓練', { exact: false })).toBeInTheDocument();
    await user.click(within(table).getByRole('radio', { name: '以 smoker 為 Target' }));
    expect(row('smoker')).not.toHaveTextContent('缺值');
  });

  it('One-Hot replaces the original column in the saved features; 當作類別 casts number codes first', async () => {
    const { user } = await renderApp('/data/tabular/2/target', 'ra01');
    const form = await screen.findByRole('form', { name: '設定 Target 與 Feature' });
    await user.click(within(form).getByRole('radio', { name: '以 diagnosis 為 Target' }));
    for (const f of ['age', 'sex', 'smoker', 'event']) await user.click(within(form).getByRole('checkbox', { name: f }));
    await user.click(within(form).getByRole('button', { name: '全部轉成 One-Hot' }));
    await user.click(within(form).getByRole('switch', { name: 'event 當作類別' }));
    expect(within(form).getByRole('switch', { name: 'sex 當作類別' })).toBeChecked();
    expect(within(screen.getByRole('list', { name: '已加入的步驟' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('One-Hot 編碼：sex、smoker'),
      expect.stringContaining('轉換資料型別：event'),
      expect.stringContaining('One-Hot 編碼：event'),
    ]);
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByText('已儲存：Target diagnosis，8 個 Feature，3 個前處理步驟')).toBeInTheDocument();
    expect(screen.getByTestId('saved-features')).toHaveTextContent('age、sex_F、sex_M、smoker_current、smoker_former、smoker_never、event_0、event_1');
    // 表上仍顯示原始欄位被勾選
    expect(within(form).getByRole('checkbox', { name: 'sex' })).toBeChecked();
    expect(within(form).queryByText('有 Feature 還不能用來訓練', { exact: false })).toBeNull();
    await user.click(within(form).getByRole('switch', { name: 'event 當作類別' }));
    expect(within(screen.getByRole('list', { name: '已加入的步驟' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('TC-A03-05 without Training permission the settings are read-only', async () => {
    const owner = await renderApp('/data/tabular/2/target', 'ra01');
    await save(owner.user, 'diagnosis', ['age']);
    await screen.findByText(/^已儲存：Target diagnosis/);
    owner.unmount();
    await renderApp('/data/tabular/2/target', 'vw01');
    expect(await screen.findByTestId('saved-target')).toHaveTextContent('diagnosis');
    expect(screen.getByText('你在專案「P1-lung-ct」沒有 Training 權限，無法儲存 Target 與 Feature 設定。')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('相關矩陣與散佈圖', () => {
  it('TC-B04-05 produces the correlation matrix for the chosen columns', async () => {
    const { user } = await renderApp('/data/tabular/2/correlation', 'vw01');
    const form = await screen.findByRole('form', { name: '相關矩陣' });
    for (const c of ['dbp', 'glucose', 'diagnosis', 'time_to_event', 'event']) await user.click(within(form).getByRole('checkbox', { name: c }));
    await user.click(within(form).getByRole('button', { name: '產生相關矩陣' }));
    const table = await within(form).findByRole('table', { name: '相關矩陣（pearson）' });
    // 與真實 API 相同：age–bmi −0.0123、age–sbp 0.5645、bmi–sbp −0.0281
    expect(bodyRows(table)).toEqual([
      ['age', '1.00', '-0.01', '0.56'],
      ['bmi', '-0.01', '1.00', '-0.03'],
      ['sbp', '0.56', '-0.03', '1.00'],
    ]);
  });

  it('fewer than 2 columns is rejected with a clear message', async () => {
    const { user } = await renderApp('/data/tabular/2/correlation', 'vw01');
    const form = await screen.findByRole('form', { name: '相關矩陣' });
    for (const box of within(form).getAllByRole('checkbox').slice(1)) await user.click(box);
    await user.click(within(form).getByRole('button', { name: '產生相關矩陣' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('相關矩陣至少需要 2 個數值欄位');
  });

  it('TC-B04-05 produces a scatter plot; TC-B04-08 a text column gives a clear error', async () => {
    const { user } = await renderApp('/data/tabular/2/correlation', 'vw01');
    const form = await screen.findByRole('form', { name: '散佈圖' });
    await user.selectOptions(within(form).getByLabelText('橫軸'), 'age');
    await user.selectOptions(within(form).getByLabelText('縱軸'), 'glucose');
    await user.click(within(form).getByRole('button', { name: '產生散佈圖' }));
    const fig = await within(form).findByRole('figure', { name: 'age 與 glucose' });
    expect(fig.querySelectorAll('circle')).toHaveLength(95);
    expect(within(form).getByRole('status')).toHaveTextContent('95 筆兩欄都有值的資料');

    await user.selectOptions(within(form).getByLabelText('縱軸'), 'smoker');
    await user.click(within(form).getByRole('button', { name: '產生散佈圖' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('欄位「smoker」不是數值欄位，無法進行數值分析');
    expect(within(form).queryByRole('figure')).toBeNull();
  });
});

describe('統計分析', () => {
  async function run(user: User, model: string, fill: (form: HTMLElement) => Promise<void>) {
    const form = await screen.findByRole('form', { name: '統計分析' });
    await user.selectOptions(within(form).getByLabelText('模型'), model);
    await fill(form);
    await user.click(within(form).getByRole('button', { name: '執行分析' }));
    return form;
  }

  it('TC-B04-07 Logistic: coefficients with odds ratios, statistics and a ROC curve', async () => {
    const { user } = await renderApp('/data/tabular/2/stats', 'vw01');
    await run(user, 'Logistic 迴歸', async (form) => {
      await user.selectOptions(within(form).getByLabelText('結果欄位'), 'diagnosis');
      await user.click(within(form).getByRole('checkbox', { name: 'age' }));
      await user.click(within(form).getByRole('checkbox', { name: 'bmi' }));
    });
    const result = await screen.findByRole('region', { name: '分析結果' });
    expect(within(result).getByRole('status')).toHaveTextContent('Logistic 迴歸：結果 diagnosis，樣本 100 筆，事件 41 筆');
    const rows = bodyRows(within(result).getByRole('table', { name: '係數' }));
    expect(rows.map((r) => r[0])).toEqual(['截距（const）', 'age', 'bmi']);
    expect(rows[1]).toEqual(['age', '0.07692', '0.01567', '4.91', '9.12e-7', '0.04622 – 0.1076', '1.08', '1.047 – 1.114']);
    expect(within(result).getByRole('list', { name: '統計量' })).toHaveTextContent('AUC0.8369');
    expect(within(result).getByRole('figure', { name: 'ROC 曲線（AUC 0.8369）' })).toBeInTheDocument();
  });

  it('TC-B04-07 Linear: R², coefficients and a residual plot', async () => {
    const { user } = await renderApp('/data/tabular/2/stats', 'vw01');
    await run(user, 'Linear 迴歸', async (form) => {
      await user.selectOptions(within(form).getByLabelText('結果欄位'), 'sbp');
      await user.click(within(form).getByRole('checkbox', { name: 'age' }));
      await user.click(within(form).getByRole('checkbox', { name: 'bmi' }));
    });
    const result = await screen.findByRole('region', { name: '分析結果' });
    expect(within(result).getByRole('list', { name: '統計量' })).toHaveTextContent('R²0.3191');
    const head = within(within(result).getByRole('table', { name: '係數' })).getAllByRole('columnheader').map((h) => h.textContent);
    expect(head).toEqual(['變項', '係數', '標準誤', 't', 'p 值', '95% CI']);
    expect(within(result).getByRole('figure', { name: '殘差圖' }).querySelectorAll('circle')).toHaveLength(100);
  });

  it('TC-B04-07 Kaplan-Meier: one curve per group with a legend, summary table and log-rank test', async () => {
    const { user } = await renderApp('/data/tabular/2/stats', 'vw01');
    await run(user, 'Kaplan-Meier 存活分析', async (form) => {
      expect(within(form).getByLabelText('存活時間欄位')).toHaveValue('time_to_event');
      expect(within(form).getByLabelText('事件欄位（0／1）')).toHaveValue('event');
      await user.selectOptions(within(form).getByLabelText('分組欄位'), 'sex');
    });
    const result = await screen.findByRole('region', { name: '分析結果' });
    expect(bodyRows(within(result).getByRole('table', { name: '各組存活摘要' }))).toEqual([
      ['F', '49', '36', '400'],
      ['M', '51', '35', '661'],
    ]);
    expect(within(result).getByRole('list', { name: '統計量' })).toHaveTextContent('Log-rank p 值0.3754');
    const fig = within(result).getByRole('figure', { name: '存活曲線' });
    expect(within(within(fig).getByRole('list', { name: '圖例' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['F', 'M']);
  });

  it('TC-B04-07 Cox: hazard ratios and a forest plot', async () => {
    const { user } = await renderApp('/data/tabular/2/stats', 'vw01');
    await run(user, 'Cox 比例風險模型', async (form) => {
      await user.click(within(form).getByRole('checkbox', { name: 'age' }));
      await user.click(within(form).getByRole('checkbox', { name: 'bmi' }));
    });
    const result = await screen.findByRole('region', { name: '分析結果' });
    const table = within(result).getByRole('table', { name: '係數' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(-2)).toEqual(['Hazard Ratio', 'Hazard Ratio 95% CI']);
    expect(cellsOf(within(table).getByRole('row', { name: /^age/ })).slice(-2)).toEqual(['1.042', '1.028 – 1.057']);
    expect(within(result).getByRole('list', { name: '統計量' })).toHaveTextContent('Concordance0.7119');
    const forest = within(result).getByRole('figure', { name: 'Hazard Ratio 森林圖' });
    expect(within(forest).getByRole('img', { name: /^age：HR 1\.04/ })).toBeInTheDocument();
  });

  it('TC-B04-08 text and empty columns give a clear message instead of a server error', async () => {
    const { user } = await renderApp('/data/tabular/2/stats', 'vw01');
    const form = await run(user, 'Linear 迴歸', async (f) => {
      await user.selectOptions(within(f).getByLabelText('結果欄位'), 'sbp');
      await user.click(within(f).getByRole('checkbox', { name: 'smoker' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('資料驗證失敗');
    expect(alert).toHaveTextContent('欄位「smoker」不是數值欄位，無法進行數值分析');
    expect(screen.queryByRole('region', { name: '分析結果' })).toBeNull();

    await user.click(within(form).getByRole('checkbox', { name: 'smoker' }));
    await user.click(within(form).getByRole('checkbox', { name: 'age' }));
    await user.selectOptions(within(form).getByLabelText('模型'), 'Logistic 迴歸');
    await user.click(within(form).getByRole('button', { name: '執行分析' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('結果欄位「sbp」必須只包含 0 與 1');
  });
});
