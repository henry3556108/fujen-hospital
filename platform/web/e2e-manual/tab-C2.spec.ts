import { expect, test } from '@playwright/test';
import { startScenario } from './kit';
import { DS, TAB_PROJECT, optionValue } from './tab-common';

// C2 清洗與前處理（ra01，手冊 04-研究助理；影片 2 第 2 段）。接在 C1 之後（C1 重跑會以新上傳取代資料集，整理設定歸零）。
test('C2 清洗與前處理', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'C2', title: '清洗與前處理', role: 'ra01', manual: '04-研究助理', project: TAB_PROJECT });
  const p = s.page;
  s.section('目的', '指定要預測的結果（Target）與用來預測的欄位（Feature），處理文字欄位與缺值，把資料整理成可以統計或建立模型的樣子。');
  s.section('開始前準備', `已完成「上傳表格並看懂資料」，專案裡有資料集「${DS}」。`);

  // 鏡頭外：到表格資料清單
  await p.goto('/data/tabular');
  const list = p.getByRole('table', { name: '資料集列表' });
  await expect(list.getByRole('link', { name: DS, exact: true })).toBeVisible({ timeout: 30_000 });
  await p.waitForLoadState('networkidle').catch(() => undefined);

  await s.step(`在「${DS}」這列按「整理資料」`, list.getByRole('link', { name: `整理資料 ${DS}`, exact: true }), 'click');
  const form = p.getByRole('form', { name: '整理資料' });
  const table = form.getByRole('table', { name: '欄位整理' });
  await s.wait('畫面列出每一欄的型態、缺值與提示', () => expect(table).toBeVisible({ timeout: 60_000 }));

  // Target 與 Feature
  const target = p.locator('#prep-target');
  await s.step('在「想預測哪個欄位？」選 diagnosis', target, { select: await optionValue(target, 'diagnosis') });
  await s.step('按「全部勾選（不含識別碼）」', form.getByRole('button', { name: '全部勾選（不含識別碼）' }), 'click');
  // 追蹤結果與檢查單號不能拿來預測：取消勾選（依畫面實際勾選狀態）
  for (const [col, why] of [
    ['time_to_event', '追蹤天數是事後才知道的結果'],
    ['event', '是否發生事件也是事後的結果'],
    ['study_accession', '影像檢查單號不是病人特徵'],
  ] as const) {
    const box = table.getByRole('checkbox', { name: col, exact: true });
    if (await box.isChecked()) await s.step(`取消勾選 ${col}`, box, 'click', { detail: `${why}，不能拿來預測。` });
  }
  await expect(p.getByTestId('chosen-features')).toContainText('7 個');
  await s.step('上方確認用來預測的 7 個欄位', p.getByTestId('chosen-features'));

  // One-Hot
  const warn = form.getByRole('button', { name: '全部拆成 0／1 欄位' });
  await expect(warn).toBeVisible();
  await s.step('文字欄位要拆成 0／1：按「全部拆成 0／1 欄位」', warn, 'click', {
    detail: 'sex、smoker 是文字欄位，要先拆成 0／1 欄位（One-Hot 編碼）才能建立模型。以數字代表分類的欄位，可在「當作類別」打開開關。',
  });
  await expect(table.getByRole('switch', { name: 'sex 當作類別' })).toBeChecked();

  // 缺值
  const gaps = form.getByRole('radiogroup', { name: '有缺值的病人怎麼處理' });
  await expect(gaps).toBeVisible();
  await s.step('缺值處理選「補上缺值，所有病人都使用」', gaps.getByRole('radio').first(), 'click', {
    detail: '數字補訓練資料的中位數，類別補最常見的值；預測時也照樣補上。另一個選項「不使用這些病人」會在訓練時跳過有缺值的病人。',
  });

  // 自己加一個整理步驟（66 種方法依類別分組，可搜尋）
  await s.step('在 bmi 這列按「加步驟」', table.getByRole('button', { name: '替 bmi 加整理步驟' }), 'click');
  const add = p.getByRole('form', { name: '加入前處理步驟' });
  await expect(add).toBeVisible();
  const cat = add.locator('#step-category');
  await s.step('「類別」選 縮放與數值轉換', cat, { select: await optionValue(cat, '縮放與數值轉換') });
  const method = add.locator('#step-method');
  await s.step('「方法」選 標準化（Z 分數）', method, { select: await optionValue(method, '標準化（Z 分數）') });
  const bmi = add.getByRole('group', { name: /套用欄位/ }).getByRole('checkbox', { name: 'bmi', exact: true });
  if (!(await bmi.isChecked())) await s.step('「套用欄位」勾選 bmi', bmi, 'click');
  await s.step('按「加入步驟」', add.getByRole('button', { name: '加入步驟' }), 'click');
  const steps = p.getByRole('list', { name: '已加入的步驟' });
  await expect(steps).toBeVisible();
  await s.step('「整理步驟」列出加入的步驟', steps, undefined, { detail: '可以上移、下移、修改或移除；按「移除」就回到處理前。' });

  // 處理前後比較、儲存
  await s.step('按「預覽處理結果」', p.getByRole('button', { name: '預覽處理結果' }), 'click');
  const cmp = p.getByRole('region', { name: '處理前後預覽' });
  await s.wait('畫面並列處理前與處理後的資料', () => expect(cmp).toBeVisible({ timeout: 60_000 }));
  await s.step('按「儲存整理步驟」', p.getByRole('button', { name: '儲存整理步驟' }), 'click');
  const saved = p.getByText(/^已儲存：要預測的結果 diagnosis/).first();
  await expect(saved).toBeVisible({ timeout: 30_000 });
  await s.step('畫面寫出儲存的內容', saved);
  const savedCard = p.getByRole('region', { name: '已儲存的整理設定' });
  await s.step('「已儲存的整理設定」列出目前設定', savedCard);

  s.section(
    '完成後的樣子',
    '「已儲存的整理設定」寫出想預測的欄位 diagnosis、用來預測的 7 個欄位（sex、smoker 拆成 0／1 欄位）、有缺值的病人補上缺值後使用，以及 bmi 標準化的整理步驟。之後在「統計分析」或「用這份資料建立模型」會直接帶入這些設定。',
  );
  s.section(
    '常見問題',
    [
      '- 出現「有欄位還不能用來建立模型」：表示勾選的 Feature 中有文字或類別欄位，按「全部拆成 0／1 欄位」即可。',
      '- 欄位旁的提示寫「像病歷號等識別碼」：每列都不同的欄位不要當 Feature，「全部勾選（不含識別碼）」會自動略過。',
      '- 找不到想要的整理方法：在「加入前處理步驟」的「搜尋方法」輸入關鍵字（例如：補值、標準化、onehot），或展開「全部整理方法」看 66 種方法的清單。',
      '- 原始資料會不會被改掉：不會。整理步驟只套用在副本上，隨時可以移除步驟或重新儲存。',
    ].join('\n'),
  );
  await s.finish();
});
