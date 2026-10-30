import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { startScenario } from './kit';
import { FHIR_PROJECT, ensureFhirProject, fhirData } from './ops-common';

// F1 把院內資料轉成 FHIR（admin01）：示範租戶「手冊-FHIR資料交換」。
// 加入內建對應規則 → 新增 HL7 V2、CSV 來源 → 執行轉換 → 看不合格原因 → 設定排程並等第一次執行。
test('F1 把院內資料轉成 FHIR', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const pid = ensureFhirProject();
  // 上一輪的來源、規則、排程、執行紀錄清掉（只動示範租戶）
  psql(
    `delete from fhir_runs where project_id=${pid}; delete from fhir_schedules where project_id=${pid}; ` +
      `delete from fhir_sources where project_id=${pid}; delete from fhir_mappings where project_id=${pid}`,
  );
  const files = fhirData();

  const s = await startScenario(browser, { id: 'F1', title: '把院內資料轉成 FHIR', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;
  s.section('目的', '把院內 HL7 V2 入院訊息、CSV 門診紀錄等不同格式的資料，轉成 FHIR R4 標準格式寫進平台的 FHIR Server，並設定排程定期轉換。');
  s.section(
    '開始前準備',
    [
      '- 使用系統管理者帳號登入。',
      `- 決定要寫入哪個專案（每個專案是一個獨立的 FHIR 租戶）。本節以「${FHIR_PROJECT}」示範。`,
      '- 準備來源檔案：HL7 V2 訊息檔（.hl7，可多則訊息放在同一檔）、CSV（第一列是欄位名稱）或 JSON（物件陣列）。SQL 來源則準備資料庫連線字串與 SELECT 查詢。',
    ].join('\n'),
  );

  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.step('按左側選單的「資料交換」', sideNav(p).getByRole('link', { name: '資料交換', exact: true }), 'click');
  await s.step(`在「租戶專案」選擇 ${FHIR_PROJECT}`, p.locator('#fhir-tenant'), { select: { label: FHIR_PROJECT } });
  await expect(p.getByText(`目前租戶：${FHIR_PROJECT}`)).toBeVisible();
  const tabs = p.getByRole('navigation', { name: 'FHIR 分頁' });
  await s.step('按「來源與對應」分頁', tabs.getByRole('link', { name: '來源與對應' }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: 'FHIR 來源與對應' })).toBeVisible();

  // 對應規則：加入內建規則
  const builtin = p.locator('#builtin-mapping');
  const addRule = p.getByRole('button', { name: '加入', exact: true });
  const rules = p.getByRole('table', { name: '對應規則列表' });
  await s.step('在「內建規則」選擇 hl7v2-adt', builtin, { select: 'hl7v2-adt' }, {
    detail: 'hl7v2-adt 把 HL7 V2 入院訊息（ADT）轉成 Patient 與 Encounter。',
  });
  await s.step('按「加入」', addRule, 'click');
  await expect(p.getByText('已加入對應規則「hl7v2-adt」')).toBeVisible();
  await s.step('再選擇 csv-encounter 並按「加入」', builtin, { select: 'csv-encounter' }, {
    detail: 'csv-encounter 把 CSV 門診紀錄轉成 Encounter；json-lab-observation 可把 JSON 檢驗結果轉成 Observation。',
  });
  await addRule.click();
  await expect(rules.getByRole('rowheader', { name: 'csv-encounter' })).toBeVisible();
  await builtin.selectOption('json-lab-observation');
  await addRule.click();
  await expect(rules.getByRole('rowheader', { name: 'json-lab-observation' })).toBeVisible();
  await s.step('「對應規則」列出已加入的規則', rules, undefined, { zoom: false });

  // 來源：HL7 V2
  const form = p.getByRole('form', { name: '新增來源' });
  await s.step('在「來源名稱」輸入 手冊-入院訊息HL7', form.getByLabel('來源名稱（必填）'), { fill: '手冊-入院訊息HL7' });
  await s.step('在「來源類型」選擇 HL7 V2', form.getByLabel('來源類型'), { select: 'hl7v2' });
  await s.step('按「選擇檔案」，選 HL7 訊息檔', form.getByRole('button', { name: '選擇檔案' }), { upload: files.hl7 }, {
    detail: '選好後檔案內容會帶進「內容」欄，也可以直接把訊息貼在「內容」欄。',
  });
  await expect(form.locator('#src-content')).not.toHaveValue('');
  await s.step('按「新增來源」', form.getByRole('button', { name: '新增來源' }), 'click');
  await expect(p.getByText('已新增來源「手冊-入院訊息HL7」')).toBeVisible();

  // 來源：CSV
  await s.step('再新增 CSV 來源 手冊-門診紀錄CSV', form.getByLabel('來源名稱（必填）'), { fill: '手冊-門診紀錄CSV' });
  await form.getByLabel('來源類型').selectOption('csv');
  await form.locator('#src-file').setInputFiles(files.csv);
  await expect(form.locator('#src-content')).not.toHaveValue('');
  await s.step('選好 CSV 檔後按「新增來源」', form.getByRole('button', { name: '新增來源' }), 'click');
  await expect(p.getByText('已新增來源「手冊-門診紀錄CSV」')).toBeVisible();
  // 錯誤示範用的來源（鏡頭外建立）
  await form.getByLabel('來源名稱（必填）').fill('手冊-錯誤示範HL7');
  await form.getByLabel('來源類型').selectOption('hl7v2');
  await form.locator('#src-file').setInputFiles(files.hl7Bad);
  await expect(form.locator('#src-content')).not.toHaveValue('');
  await form.getByRole('button', { name: '新增來源' }).click();
  await expect(p.getByText('已新增來源「手冊-錯誤示範HL7」')).toBeVisible();
  await s.step('「資料來源」列出新增的來源', p.getByRole('table', { name: '來源列表' }), undefined, { zoom: false });

  // 執行轉換：HL7 V2
  await p.evaluate(() => window.scrollTo(0, 0));
  const run = p.getByRole('form', { name: '執行轉換' });
  const result = p.getByText(/^執行 #\d+ 成功：/);
  await s.step('在「來源」選擇 手冊-入院訊息HL7', run.locator('#run-source'), { select: { label: '手冊-入院訊息HL7' } });
  await s.step('在「對應規則」選擇 hl7v2-adt', run.locator('#run-mapping'), { select: { label: 'hl7v2-adt' } });
  await s.step('按「執行轉換」', run.getByRole('button', { name: '執行轉換' }), 'click');
  await s.wait('「轉換結果」顯示讀取與寫入筆數', () => expect(result).toBeVisible({ timeout: 60_000 }));
  await expect(result).toContainText('讀取 20 筆');

  // 執行轉換：CSV
  await s.step('改選 手冊-門診紀錄CSV 與 csv-encounter', run.locator('#run-source'), { select: { label: '手冊-門診紀錄CSV' } });
  await run.locator('#run-mapping').selectOption({ label: 'csv-encounter' });
  await s.step('按「執行轉換」', run.getByRole('button', { name: '執行轉換' }), 'click');
  await s.wait('CSV 的 20 筆門診紀錄也轉換成功', () => expect(p.getByText(/^執行 #\d+ 成功：讀取 20 筆，寫入 Encounter/)).toBeVisible({ timeout: 60_000 }));

  // JSON 檢驗結果（鏡頭外，讓 F2 的關聯圖有觀察值）
  await p.getByRole('form', { name: '新增來源' }).getByLabel('來源名稱（必填）').fill('手冊-檢驗結果JSON');
  await form.getByLabel('來源類型').selectOption('json');
  await form.locator('#src-file').setInputFiles(files.json);
  await expect(form.locator('#src-content')).not.toHaveValue('');
  await form.getByRole('button', { name: '新增來源' }).click();
  await expect(p.getByText('已新增來源「手冊-檢驗結果JSON」')).toBeVisible();
  await p.evaluate(() => window.scrollTo(0, 0));
  await run.locator('#run-source').selectOption({ label: '手冊-檢驗結果JSON' });
  await run.locator('#run-mapping').selectOption({ label: 'json-lab-observation' });
  await run.getByRole('button', { name: '執行轉換' }).click();
  await expect(p.getByText(/^執行 #\d+ 成功：讀取 20 筆，寫入 Observation/)).toBeVisible({ timeout: 60_000 });

  // 不合格資料：整批不寫入，列出原因
  await s.step('選擇 手冊-錯誤示範HL7 與 hl7v2-adt', run.locator('#run-source'), { select: { label: '手冊-錯誤示範HL7' } });
  await run.locator('#run-mapping').selectOption({ label: 'hl7v2-adt' });
  await s.step('按「執行轉換」', run.getByRole('button', { name: '執行轉換' }), 'click');
  const bad = p.getByRole('table', { name: /^失敗資料/ });
  await s.wait('有不合格訊息時整批不寫入', () => expect(bad).toBeVisible({ timeout: 60_000 }));
  await s.step('「失敗資料」列出每則訊息的原因', bad, undefined, {
    detail: '修正來源檔案中列出的訊息後，重新新增來源再執行。',
  });
  await s.step('「執行紀錄」列出每次轉換的結果', p.getByRole('table', { name: '執行紀錄' }), undefined, { zoom: false });

  // 排程
  await s.step('按「排程」分頁', tabs.getByRole('link', { name: '排程' }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: 'FHIR 轉換排程' })).toBeVisible();
  const sch = p.getByRole('form', { name: '新增排程' });
  await s.step('在「排程名稱」輸入 手冊-門診定時轉換', sch.getByLabel('排程名稱（必填）'), { fill: '手冊-門診定時轉換' });
  await s.step('「來源」選擇 手冊-門診紀錄CSV', sch.locator('#sch-source'), { select: { label: '手冊-門診紀錄CSV' } });
  await s.step('「對應規則」選擇 csv-encounter', sch.locator('#sch-mapping'), { select: { label: 'csv-encounter' } });
  await s.step('「間隔」輸入 1（每 1 分鐘）', sch.locator('#sch-interval'), { fill: '1' }, {
    detail: '示範用 1 分鐘；實際使用可設 60（每 1 小時）或 1440（每天）。',
  });
  await s.step('按「新增排程」', sch.getByRole('button', { name: '新增排程' }), 'click');
  await expect(p.getByText('已新增排程「手冊-門診定時轉換」')).toBeVisible();
  const row = p.getByRole('table', { name: '排程列表' }).getByRole('row', { name: /手冊-門診定時轉換/ });
  await s.step('排程清單顯示「下次執行」時間', row, undefined, { zoom: false });
  await s.wait('到時間後自動執行，「最近結果」顯示成功', async () => {
    await expect(async () => {
      await p.reload();
      await expect(row.getByText('成功')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 180_000, intervals: [5000] });
  });
  await s.step('不需要時關閉「啟用」開關', row.getByRole('switch', { name: /啟用 手冊-門診定時轉換/ }), 'click');
  await expect(p.getByText('已停用排程「手冊-門診定時轉換」')).toBeVisible();

  s.section(
    '完成後的樣子',
    '「來源與對應」的「執行紀錄」列出每次轉換（手動或排程）的讀取筆數、寫入的 FHIR 資源與結果；排程清單的「最近結果」顯示「成功」。轉出的資料可到「資源」分頁查詢，見下一節。',
  );
  s.section(
    '常見問題',
    [
      '- 執行後顯示「失敗資料」：只要有一筆不合格，整批都不會寫進 FHIR（畫面註明「整批寫入：任何一筆不合格或寫入中斷，整批都不會寫進 FHIR。」）。依「原因」欄修正來源資料再執行。',
      '- 對應規則旁出現「與所選來源類型不同，執行時會被擋下」：規則的適用來源要與來源類型相同，例如 HL7 V2 來源要選 hl7v2-adt。',
      '- 排程畫面出現「還沒有來源或對應規則，請先到「來源與對應」建立。」：先完成來源與規則再建立排程。',
      '- 目前只能加入內建規則；自訂、編輯與刪除規則尚未開放。',
      '- SQL 來源的查詢只能是 SELECT；連線字串的密碼存入後不會再顯示。',
    ].join('\n'),
  );
  await s.finish();
  fs.rmSync(path.dirname(files.hl7), { recursive: true, force: true });
});
