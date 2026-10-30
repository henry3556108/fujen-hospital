import { expect, test, type Locator } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { startScenario, type Scenario } from './kit';
import { COLS, DS, TAB_PROJECT, datasetTabs, optionValue } from './tab-common';

// C3 醫學統計分析（pi01，手冊 02-計畫主持人；影片 2 第 3 段）。四種分析：Logistic、Linear、Kaplan-Meier、Cox。
test('C3 醫學統計分析', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'C3', title: '醫學統計分析', role: 'pi01', manual: '02-計畫主持人', project: TAB_PROJECT });
  const p = s.page;
  s.section(
    '目的',
    '用同一份臨床資料做論文或報告常用的統計：邏輯斯迴歸（Logistic）、線性迴歸（Linear）、Kaplan-Meier 存活分析、Cox 比例風險模型，看統計量、係數、p 值、信賴區間與圖表。',
  );
  s.section('開始前準備', `專案裡有資料集「${DS}」（研究助理已上傳並整理，見研究助理手冊「上傳表格並看懂資料」「清洗與前處理」）。`);

  await s.step('按左側選單的「研究資料」', sideNav(p).getByRole('link', { name: SIDE.data, exact: true }), 'click');
  await s.step('點上方分頁「表格資料」', p.getByRole('navigation', { name: '研究資料分頁' }).getByRole('link', { name: '表格資料', exact: true }), 'click');
  const list = p.getByRole('table', { name: '資料集列表' });
  await expect(list.getByRole('link', { name: DS, exact: true })).toBeVisible({ timeout: 30_000 });
  await s.step(`點資料集名稱「${DS}」`, list.getByRole('link', { name: DS, exact: true }), 'click');
  await expect(p.getByRole('heading', { name: `資料集：${DS}` })).toBeVisible();
  await s.step('點上方分頁「統計分析」', datasetTabs(p).getByRole('link', { name: '統計分析', exact: true }), 'click');
  const form = p.getByRole('form', { name: '統計分析' });
  await expect(form).toBeVisible();

  const model = form.locator('#stats-model');
  const vars = () => form.getByRole('group', { name: /特徵欄位|共變項/ });
  const result = p.getByRole('region', { name: '分析結果' });
  /** 只勾 want：先取消前一個分析留下、這次不要的欄位，再勾選還沒勾的 */
  const pickVars = async (want: string[]) => {
    let changed = false;
    for (const c of COLS) {
      const box = vars().getByRole('checkbox', { name: c, exact: true });
      if ((await box.count()) && (await box.isChecked()) && !want.includes(c)) {
        await s.step(`取消勾選 ${c}`, box, 'click');
        changed = true;
      }
    }
    for (const c of want) {
      const box = vars().getByRole('checkbox', { name: c, exact: true });
      if (!(await box.isChecked())) {
        await s.step(`勾選 ${c}`, box, 'click');
        changed = true;
      }
    }
    if (!changed) await s.step(`特徵欄位沿用已勾選的 ${want.join('、')}`, vars());
  };
  const select = async (sc: Scenario, caption: string, sel: Locator, text: string) => sc.step(caption, sel, { select: await optionValue(sel, text) });
  const run = async (what: string) => {
    await s.step('按「執行分析」', form.getByRole('button', { name: '執行分析' }), 'click');
    await s.wait(`等待${/^[A-Za-z]/.test(what) ? " " : ""}${what}結果`, () => expect(result).toBeVisible({ timeout: 120_000 }), { manual: false });
  };

  // 1. Logistic 迴歸：哪些因素和確診（0／1）有關
  await select(s, '「模型」選 Logistic 迴歸', model, 'Logistic 迴歸');
  await select(s, '「結果欄位」選 diagnosis（是否確診）', form.locator('#stats-target'), 'diagnosis');
  await pickVars(['age', 'bmi', 'sbp']);
  await run('Logistic 迴歸');
  await s.step('上方統計量：AUC、Pseudo R²、p 值', result.getByRole('list', { name: '統計量' }), undefined, {
    detail: 'AUC 越接近 1 表示這些因素越能區分確診與未確診；LLR p 值小於 0.05 表示整體模型有統計意義。',
  });
  await s.step('係數表列出勝算比、p 值與信賴區間', result.getByRole('table', { name: '係數' }), undefined, { zoom: false });

  // 2. Linear 迴歸：連續數值結果
  await select(s, '「模型」改選 Linear 迴歸', model, 'Linear 迴歸');
  await select(s, '「結果欄位」選 sbp（收縮壓）', form.locator('#stats-target'), 'sbp');
  await pickVars(['age', 'bmi']);
  await run('Linear 迴歸');
  await s.step('統計量：R²、調整後 R²、F 檢定', result.getByRole('list', { name: '統計量' }));
  await result.getByText('殘差圖').first().scrollIntoViewIfNeeded();
  await s.note('下方係數表與殘差圖');

  // 3. Kaplan-Meier：依性別比較存活曲線
  await select(s, '「模型」改選 Kaplan-Meier 存活分析', model, 'Kaplan-Meier 存活分析');
  await s.step('存活時間與事件欄位已自動帶入', form.locator('#stats-duration'), undefined, {
    detail: '「存活時間欄位」帶入 time_to_event（追蹤天數），「事件欄位（0／1）」帶入 event；欄名不同時請自行選擇。',
  });
  await select(s, '「分組欄位」選 sex，比較男女', form.locator('#stats-group'), 'sex');
  await run('存活分析');
  await result.locator('svg').first().scrollIntoViewIfNeeded();
  await s.note('畫面顯示兩組存活曲線與 log-rank 檢定');
  await s.step('「各組存活摘要」列出人數與中位存活', result.getByRole('table', { name: '各組存活摘要' }));

  // 4. Cox 比例風險模型
  await select(s, '「模型」改選 Cox 比例風險模型', model, 'Cox 比例風險模型');
  await pickVars(['age', 'diagnosis']);
  await run('Cox 模型');
  await s.step('統計量：Concordance 等', result.getByRole('list', { name: '統計量' }));
  await s.step('係數表列出風險比與信賴區間', result.getByRole('table', { name: '係數' }).first(), undefined, { zoom: false });

  s.section(
    '完成後的樣子',
    '每次按「執行分析」，下方「分析結果」顯示統計量、係數表（含 p 值與 95% 信賴區間）與圖表：Logistic 有 ROC 曲線、Linear 有殘差圖、Kaplan-Meier 有各組存活曲線。換模型或欄位後再按一次即可重算，不會改動資料。',
  );
  s.section(
    '常見問題',
    [
      '- 出現「欄位「smoker」不是數值欄位，無法進行數值分析」：迴歸的特徵欄位要是數值。文字欄位請先在「整理資料」拆成 0／1 欄位，再勾選「先套用前處理步驟」，並在「其他欄位」填入拆出的欄名（例如 sex_M）。',
      '- 出現「欄位「…」全部是空值，無法進行分析」：這欄沒有任何資料，請取消勾選。',
      '- 統計分析和建立模型有什麼不同：統計分析是找出哪些因素和結果有關（附 p 值與信賴區間），不會產生可以拿來預測的模型。',
      '- 結果要放進報告：目前畫面沒有下載按鈕，請直接選取表格文字複製，或用瀏覽器列印／截圖保存。',
    ].join('\n'),
  );
  await s.finish();
});
