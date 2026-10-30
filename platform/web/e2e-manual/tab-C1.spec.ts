import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { startScenario } from './kit';
import { CSV, DS, TAB_PROJECT, datasetTabs, optionValue } from './tab-common';

// C1 上傳表格並看懂資料（ra01，手冊 04-研究助理；影片 2 結構式資料主線第 1 段）。
// 可重跑：同名資料集已存在時，鏡頭外選「取代舊的」。
test('C1 上傳表格並看懂資料', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'C1', title: '上傳表格並看懂資料', role: 'ra01', manual: '04-研究助理', project: TAB_PROJECT });
  const p = s.page;
  s.section('目的', '把臨床數值資料（檢驗值、病歷欄位）上傳到專案，確認每一欄的型態與缺值，並看懂資料的分布。');
  s.section(
    '開始前準備',
    [
      `- 帳號已加入專案「${TAB_PROJECT}」，角色為研究助理（有上傳資料的權限）。`,
      '- 準備一份 CSV 檔：一列一位病人，第一列是欄名，欄名不可空白或重複；日期寫成 2024-01-31。',
      '- 先移除姓名、身分證字號等可直接識別個人的欄位。Excel 另存的 CSV（UTF-8 或 Big5）都可以。',
      '- 本節示範檔為 cohort_01.csv（100 位病人、12 個欄位的合成資料）。',
    ].join('\n'),
  );

  // 進入表格資料
  await s.step('按左側選單的「研究資料」', sideNav(p).getByRole('link', { name: SIDE.data, exact: true }), 'click');
  await s.step('點上方分頁「表格資料」', p.getByRole('navigation', { name: '研究資料分頁' }).getByRole('link', { name: '表格資料', exact: true }), 'click');
  const list = p.getByRole('table', { name: '資料集列表' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('status').filter({ hasText: '載入中…' })).toHaveCount(0, { timeout: 30_000 });
  await s.note('畫面列出專案裡的資料集');

  // 選檔、欄位確認
  const form = p.getByRole('form', { name: '上傳 CSV' });
  await s.step('按右上角「上傳 CSV」', p.locator('main').getByRole('link', { name: /上傳 CSV/ }), 'click');
  await s.step('按「選擇檔案」，選 cohort_01.csv', form.getByRole('button', { name: '選擇檔案' }).first(), { upload: CSV });
  const schema = form.getByRole('table', { name: '欄位確認' });
  await s.wait('平台自動判斷每一欄的型態', () => expect(schema).toBeVisible({ timeout: 60_000 }));
  await s.step('在「欄位確認」表檢查型態與提示', schema, undefined, {
    zoom: false,
    detail: '每一欄列出平台判斷的型態（整數、小數、類別、文字、日期、是否），以及缺值數、不同值數、範例與提示。型態不對時可在「型態」下拉選單修改。',
  });
  await s.step('glucose 不該空白：勾選「必填」', schema.getByRole('checkbox', { name: 'glucose 必填' }), 'click');
  await s.step('按「重新預檢」', form.getByRole('button', { name: '重新預檢' }), 'click');
  const pre = form.getByRole('region', { name: '預檢結果（尚未上傳）' });
  await expect(pre).toContainText(/拒絕 [1-9]\d* 列/);
  await s.step('預檢結果列出會被拒絕的列與原因', pre, undefined, { zoom: false });
  await s.step('這次保留缺值：取消勾選「必填」', schema.getByRole('checkbox', { name: 'glucose 必填' }), 'click');
  await s.step('再按「重新預檢」', form.getByRole('button', { name: '重新預檢' }), 'click');
  await expect(pre).toContainText('拒絕 0 列');
  await s.step('預檢結果：100 列全部通過', pre);

  // 上傳
  await s.step(`在「資料集名稱」輸入 ${DS}`, form.getByLabel('資料集名稱', { exact: true }), { fill: DS });
  const replace = form.getByRole('radio', { name: /^取代舊的/ });
  if (await replace.count()) await replace.check(); // 重跑時同名資料集已存在（鏡頭外）
  await s.step('按「上傳並驗證」', form.getByRole('button', { name: '上傳並驗證', exact: true }), 'click');
  const result = p.getByRole('region', { name: `「${DS}」的上傳結果` });
  await s.wait('等待上傳與驗證完成', () => expect(result).toBeVisible({ timeout: 120_000 }));
  await s.step('上傳結果：通過與拒絕的列數', result);

  // 開啟資料集：欄位統計、分布
  await s.step('按下方的「開啟資料集」連結', p.getByRole('link', { name: `開啟資料集「${DS}」` }), 'click');
  await expect(p.getByRole('heading', { name: `資料集：${DS}` })).toBeVisible();
  await expect(datasetTabs(p)).toBeVisible();
  await s.note('資料集頁上方顯示筆數與欄位數');
  const sections = p.getByRole('group', { name: '查看資料的段落' });
  await s.step('按「欄位統計」', sections.getByRole('button', { name: '欄位統計', exact: true }), 'click');
  const desc = p.getByRole('table', { name: '描述統計' });
  await s.wait('等待統計載入', () => expect(desc).toBeVisible({ timeout: 60_000 }), { manual: false });
  await s.step('每一欄的平均、中位數、缺值一覽', desc, undefined, {
    zoom: false,
    detail: '滑鼠移到數字上可看完整數值；表格下方「表頭說明」解釋 P25、中位數、P75、標準差、相異值。',
  });
  const dist = p.locator('#dist-column');
  await dist.scrollIntoViewIfNeeded();
  await s.step('在「分布」選欄位 age', dist, { select: await optionValue(dist, 'age') });
  await s.note('畫面顯示年齡的分布圖');
  await s.step('改選 smoker', dist, { select: await optionValue(dist, 'smoker') });
  await p.getByRole('heading', { name: '分布', exact: true }).evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await s.note('畫面顯示各類別的人數');

  // 資料預覽、顯示與隱藏欄位
  await s.step('按「資料預覽」逐列看原始資料', sections.getByRole('button', { name: '資料預覽', exact: true }), 'click');
  const shown = p.getByRole('group', { name: '顯示欄位' });
  const box = shown.getByRole('checkbox', { name: 'study_accession', exact: true });
  await expect(box).toBeVisible();
  if (!(await box.isChecked())) await box.check(); // 重跑時先恢復（鏡頭外）
  await s.step('取消勾選 study_accession 隱藏這欄', box, 'click');
  await expect(p.getByText(/已隱藏 1 個：study_accession/).first()).toBeVisible();
  await s.step('上方寫出已隱藏的欄位', p.getByText(/已隱藏 1 個：study_accession/).first(), undefined, {
    detail: '隱藏只影響自己的檢視，會自動儲存，不會刪除欄位，也不影響模型用的欄位。要恢復時重新勾選，或按「全部顯示」。',
  });

  // 相關與散佈圖
  await s.step('按「相關與散佈圖」', sections.getByRole('button', { name: '相關與散佈圖', exact: true }), 'click');
  await s.step('按「產生相關矩陣」', p.getByRole('button', { name: '產生相關矩陣' }), 'click');
  await s.wait('畫面顯示各數值欄位的相關矩陣', async () => {
    const m = p.getByText(/相關矩陣（pearson）/).first();
    await expect(m).toBeVisible({ timeout: 60_000 });
    await m.scrollIntoViewIfNeeded();
    await p.evaluate(() => window.scrollBy(0, 250));
  });

  s.section(
    '完成後的樣子',
    `資料集列表多了「${DS}」，總列數 100、拒絕 0 列。資料集頁「查看資料」可以看每一欄的統計與分布、逐列預覽原始資料、產生相關矩陣與散佈圖。`,
  );
  s.section(
    '常見問題',
    [
      '- 預檢顯示「部分資料列被拒絕：共 100 列，通過 95 列，拒絕 5 列。」：下方逐列列出列號、欄位與原因（例如「必填欄位為空值」）。若是欄位設定太嚴（例如勾了「必填」但這欄本來就有空白），改設定後按「重新預檢」；若是資料錯誤，修正 CSV 後重新選檔。',
      '- 出現「已經有名為「…」的資料集」：可選「建立新版本」（舊的保留），或「取代舊的」（會一併刪除舊資料集的 Target／Feature 設定）。',
      '- 某些寫法沒有被當成缺值：在「視為缺值的寫法」加上該寫法（以頓號分隔），按「套用缺值寫法並重新判斷」。空白、NA、N/A、- 預設就視為缺值。',
      '- 看不到「上傳 CSV」：帳號沒有上傳權限（檢視者只能查看資料與做統計分析），請聯絡計畫主持人或系統管理者。',
    ].join('\n'),
  );
  await s.finish();
});
