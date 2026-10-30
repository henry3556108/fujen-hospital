import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { startScenario } from './kit';
import { CSV_NEW, DS, TAB_PROJECT, openDatasetOffCamera } from './tab-common';

// C4 訓練分類模型、預測新資料（ra01，手冊 04-研究助理；影片 2 第 4 段）。接在 C2 之後（用資料集已存的整理設定）。
const SETTING = '手冊-確診預測';

test('C4 訓練分類模型、預測新資料', async ({ browser }) => {
  test.setTimeout(40 * 60_000);
  const s = await startScenario(browser, { id: 'C4', title: '訓練分類模型、預測新資料', role: 'ra01', manual: '04-研究助理', project: TAB_PROJECT });
  const p = s.page;
  s.section('目的', '用整理好的表格資料建立預測模型（例如預測是否確診），看模型好不好，再用模型預測新的病人。');
  s.section(
    '開始前準備',
    [
      `- 已完成「清洗與前處理」：資料集「${DS}」已存好想預測的欄位（diagnosis）與用來預測的欄位。`,
      '- 帳號要有建立模型（Training）的權限，研究助理與計畫主持人都有。',
      '- 要預測的新病人資料：可以直接在畫面上填，或準備一份欄位相同的 CSV 檔（本節用 cohort_02.csv）。',
    ].join('\n'),
  );

  // 鏡頭外：重跑時先刪掉上一輪同名的訓練設定（訓練紀錄保留），再開資料集頁
  await p.goto('/training/settings');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  const old = p.getByRole('button', { name: `查看「${SETTING}」的詳細設定` });
  if (await old.count()) {
    await old.first().click();
    await p.locator('main').getByRole('button', { name: /^刪除/ }).first().click();
    await p.getByRole('dialog').getByRole('button', { name: '刪除', exact: true }).click();
    await expect(p.getByText(`已刪除訓練設定「${SETTING}」。`)).toBeVisible();
  }
  await openDatasetOffCamera(p, 'view');

  // 建立訓練
  await s.step('在資料集頁按「用這份資料建立模型」', p.getByRole('link', { name: '用這份資料建立模型' }), 'click');
  const notice = p.getByRole('status').filter({ hasText: `已帶入資料集「${DS}」的設定` });
  await s.wait('平台帶入資料集已存的設定', () => expect(notice).toBeVisible({ timeout: 60_000 }), { manual: false });
  await s.step('上方說明帶入了哪些設定', notice, undefined, {
    detail: '研究目的依想預測的欄位自動選好：diagnosis 只有 0 與 1，所以是「判斷類別」；預測連續數字（例如血壓）時會選「預測數值」。',
  });
  await s.step('右側「送出前確認」列出目前的選擇', p.getByRole('complementary', { name: '送出前確認' }), undefined, { zoom: false });
  await s.step('按「下一步：確認並送出」', p.getByRole('button', { name: '下一步：確認並送出' }), 'click');
  const valid = p.getByRole('region', { name: '5. 驗證方式' });
  await expect(valid).toBeVisible({ timeout: 30_000 });
  await s.step('驗證方式已預選「K 折交叉驗證」', valid, undefined, {
    zoom: false,
    detail: '資料少於 1,000 列時平台預選 K 折交叉驗證（K 用 5），並寫出原因；資料很多時用「固定比例切分」。',
  });
  const algo = p.getByRole('combobox', { name: '演算法' });
  await s.step('「演算法」用預設的邏輯斯迴歸', algo, undefined, {
    detail: '也可以選隨機森林或梯度提升。不確定就保留預設值；其他參數收在「進階設定」，每個參數旁都有說明與建議值。',
  });
  await s.step(`「設定名稱」輸入 ${SETTING}`, p.getByRole('textbox', { name: '設定名稱' }), { fill: SETTING });
  await s.step('按「開始訓練」', p.getByRole('button', { name: '確認並送出訓練' }), 'click');
  await expect(p).toHaveURL(/\/training\/runs\/\d+/, { timeout: 60_000 });
  const runId = /\/training\/runs\/(\d+)/.exec(p.url())![1];
  await s.step('進度條顯示：已送出 → 排隊中 → 訓練中 → 完成', p.getByRole('list', { name: `訓練 #${runId} 的進度` }));
  await s.wait('等待訓練完成', () => expect(p.getByText('目前狀態：已完成')).toBeVisible({ timeout: 30 * 60_000 }));

  // 看結果
  const good = p.getByRole('region', { name: '模型好不好？' });
  await expect(good).toBeVisible();
  await s.step('「模型好不好？」最上方是一句結論', good.getByText(/^整體表現：/), undefined, {
    detail: '分類模型看 AUC：0.9 以上優秀、0.8 以上良好、0.7 以上尚可。有 K 折時用 K 折平均。下面寫出用了哪些病人、缺值怎麼補。',
  });
  await s.step('重點指標：AUC、準確率、敏感度、特異度', good.getByRole('list', { name: `訓練 #${runId} 的重點指標` }), undefined, {
    detail: '每個指標都有一句白話說明；下方「比較基準」寫出全部猜最常見那一類能猜對多少，模型要明顯高於它才有用。',
  });
  const charts = p.getByRole('group', { name: `訓練 #${runId} 的圖表` });
  await charts.scrollIntoViewIfNeeded();
  await s.note('圖表：混淆矩陣、ROC 曲線、特徵重要性');

  // 預測新病人：一位
  await good.scrollIntoViewIfNeeded();
  await s.step('按「用新資料測試」', good.getByRole('link', { name: '用新資料測試' }), 'click');
  const one = p.getByRole('form', { name: '一位病人' });
  await expect(one).toBeVisible({ timeout: 30_000 });
  await s.note('預測頁：一位病人、多位病人一起預測');
  const patient: [string, string][] = [
    ['age', '67'],
    ['bmi', '28.5'],
    ['sbp', '148'],
    ['dbp', '92'],
    ['glucose', '135'],
  ];
  for (const [k, v] of patient) await s.step(`「${k}」輸入 ${v}`, one.getByRole('spinbutton', { name: k, exact: true }), { fill: v });
  await s.step('「sex」選 M', one.getByRole('combobox', { name: 'sex', exact: true }), { select: 'M' });
  await s.step('「smoker」選 current', one.getByRole('combobox', { name: 'smoker', exact: true }), { select: 'current' });
  await s.step('按「預測」', one.getByRole('button', { name: '預測', exact: true }), 'click');
  const oneResult = one.getByRole('status').filter({ hasText: '預測結果' });
  await s.wait('等待預測結果', () => expect(oneResult).toBeVisible({ timeout: 60_000 }), { manual: false });
  await s.step('結果寫出 diagnosis＝1 的機率', oneResult, undefined, {
    detail: '二元分類的機率一律是「diagnosis＝1」的機率；預測為「0」時也寫 diagnosis＝1 的機率。沒有填的欄位會用訓練資料的中位數或最常見的值補上，結果會寫出補了什麼。',
  });

  // 多位病人：測試資料
  const batch = p.getByRole('region', { name: '多位病人一起預測' });
  await batch.scrollIntoViewIfNeeded();
  await s.step('「資料範圍」選 測試資料', batch.getByRole('combobox', { name: '資料範圍' }), { select: { label: '測試資料' } }, {
    detail: '測試資料是訓練時沒看過的病人；資料裡有實際結果，可以對照模型猜得準不準。',
  });
  await s.step('按「多位病人一起預測」', batch.getByRole('button', { name: '多位病人一起預測' }), 'click');
  const res = (n: number) => p.getByRole('region', { name: new RegExp(`^預測結果 #\\d+（${n} 筆）`) });
  await s.wait('等待預測完成', () => expect(res(20)).toBeVisible({ timeout: 120_000 }), { manual: false });
  await s.step('摘要寫出 20 位中預測對幾位', res(20).getByText(/位中預測對/), undefined, {
    detail: '表格前面是病歷號、實際值、預測結果、機率、預測對／錯與說明；其餘輸入的欄位在右側，可左右捲動。',
  });

  // 多位病人：上傳 CSV
  const up = p.getByRole('form', { name: '上傳 CSV 預測' });
  await up.scrollIntoViewIfNeeded();
  await s.step('上傳新病人：按「選擇檔案」選 CSV', up.getByRole('button', { name: '選擇檔案' }), { upload: CSV_NEW });
  await s.step('按「上傳並預測」', up.getByRole('button', { name: '上傳並預測' }), 'click');
  await s.wait('等待 100 位病人預測完成', () => expect(res(100)).toBeVisible({ timeout: 180_000 }), { manual: false });
  await res(100).scrollIntoViewIfNeeded();
  await s.step('結果表多了「預測結果」與機率欄', res(100).getByRole('table', { name: '預測結果' }), undefined, { zoom: false });
  await s.step('按「下載結果」存成 CSV', res(100).getByRole('button', { name: '下載結果' }), undefined, {
    detail: '下載的 CSV 保留英文欄名：prediction（預測結果）、prediction_positive_probability（diagnosis＝1 的機率）、prediction_probability、prediction_note，並保留原本的欄位。',
  });

  // 訓練紀錄：比較多次訓練
  await s.step('按左側選單的「建立模型」', sideNav(p).getByRole('link', { name: SIDE.training, exact: true }), 'click');
  await p.getByRole('navigation', { name: '建立模型分頁' }).getByRole('link', { name: '訓練紀錄', exact: true }).click();
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.note('「訓練紀錄」列出每次訓練與主要分數', {
    detail: '同一份資料可以換演算法或設定再訓練幾次，在這裡依「主要分數」排序比較，點名稱回到該次結果。',
  });

  s.section(
    '完成後的樣子',
    `「訓練紀錄」多了一筆「${SETTING}」，狀態已完成，有一句結論（例如「整體表現：良好（AUC 0.83，5 折平均）」）。預測頁可以預測一位病人，或一次預測多位病人並下載含預測結果的 CSV；每次預測都記在「預測紀錄」。`,
  );
  s.section(
    '常見問題',
    [
      '- 進度停在「排隊中」：運算資源正在處理其他工作，畫面會寫出排在第幾位，完成後自動更新，不用一直重新整理。',
      '- 建立訓練時出現「這個資料集還沒設定想預測的欄位」：先到資料集的「整理資料」選想預測的欄位並儲存，或在建立訓練的下一步直接選。',
      '- 按「開始訓練」後出現「資料衝突：訓練設定「…」已存在」：設定名稱不能重複，請換一個名稱。',
      '- 訓練失敗：畫面只顯示中文原因與「前往修正」連結，程式訊息收在「技術細節」。',
      '- 上傳預測的 CSV 欄位要和訓練資料相同（欄名一致）；缺少的值會照訓練時的方式補上，有實際結果欄位時會多一欄「預測對／錯」。',
      '- 要分享給醫師使用：在結果頁按「分享給同事使用」（見計畫主持人手冊）。',
    ].join('\n'),
  );
  await s.finish();
});
