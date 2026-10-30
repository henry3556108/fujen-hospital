import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { IMG_PROJECT, RUN1, flat } from './img-common';
import { startScenario } from './kit';

// D2（ca01）：在「流程程式碼」檢視訓練環節的 train.py，先示範格式不符被擋下，再加一行輸出訊息後套用，送出訓練並在訓練輸出看到這行。
const MARK = '[手冊] 這次使用修改過的訓練程式';

test('D2 改程式碼再跑', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  const s = await startScenario(browser, { id: 'D2', title: '修改訓練程式再執行', role: 'ca01', manual: '05-程式助理', project: IMG_PROJECT });
  const p = s.page;
  // 鏡頭外：重跑時先把上次匯入的訓練程式改回介面設定
  await p.goto('/training/settings');
  const mine0 = p.getByRole('checkbox', { name: '只看我建立的' });
  await mine0.waitFor();
  if (await mine0.isChecked()) await mine0.uncheck();
  await p.getByRole('link', { name: `流程程式碼「${RUN1}」`, exact: true }).click();
  const unlock = p.getByRole('button', { name: '改回用介面設定「訓練」', exact: true });
  await p.getByRole('table', { name: '流程環節' }).waitFor();
  if (await unlock.count()) {
    await unlock.click();
    await p.getByRole('dialog').getByRole('button', { name: '刪除匯入檔並改回介面設定' }).click();
    await expect(p.getByText('已改回用介面設定「訓練」')).toBeVisible();
  }
  await p.goto('/');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  s.section('目的', '畫面上調不到的地方，由會寫程式的人直接修改訓練環節的 Python 程式，套用後在平台上再跑一次，結果一樣記在訓練紀錄。');
  s.section('開始前準備', `專案裡已有存好的訓練設定（本手冊用「${RUN1}」）。帳號要有 Coding 與 Training 權限。修改時要保留平台呼叫的函式名稱與參數。`);

  await s.step('按左側選單的「建立模型」', sideNav(p).getByRole('link', { name: SIDE.training, exact: true }), 'click');
  const tabs = p.getByRole('navigation', { name: '建立模型分頁' });
  await s.step('點「已存設定」分頁', tabs.getByRole('link', { name: '已存設定' }), 'click');
  const mine = p.getByRole('checkbox', { name: '只看我建立的' });
  if (await mine.isChecked()) {
    await s.step('取消勾選「只看我建立的」', mine, 'click', { detail: '設定是計畫主持人建立的；預設只列出自己建立的設定。' });
  }
  await s.step(`按「${RUN1}」的「流程程式碼」`, p.getByRole('link', { name: `流程程式碼「${RUN1}」`, exact: true }), 'click');
  const panel = p.getByRole('region', { name: `流程程式碼「${RUN1}」` });
  await expect(panel.getByRole('table', { name: '流程環節' })).toBeVisible();
  await s.step('在「訓練」按「檢視程式碼」', panel.getByRole('button', { name: '檢視程式碼「訓練」', exact: true }), 'click');
  const code = panel.getByLabel('train.py', { exact: true });
  await expect(code).toBeVisible();
  const original = await code.inputValue();
  console.log(`[D2] train.py ${original.split('\n').length} 行；開頭：${flat(original.slice(0, 300))}`);
  await s.step('左邊顯示 train.py 與 train.json', code, undefined, {
    detail: 'train.json 是這個環節的設定值，train.py 是程式。下方「平台預設程式（對照用）」可以對照原本的內容。',
  });

  // 1. 格式不符：把函式名稱改掉
  const broken = `${original.trimEnd()}
print("少了右括號"
`;
  await s.step('先示範：最後加一行少了右括號的程式', code, { fill: broken });
  const apply = panel.getByRole('button', { name: '套用「訓練」', exact: true });
  await s.step('按「檢查並套用」', apply, 'click');
  const errs = panel.getByRole('alert').first();
  await expect(errs).toBeVisible({ timeout: 60_000 });
  console.log(`[D2] 格式不符：${flat(await errs.innerText())}`);
  await s.step('列出不符合格式的原因，設定不會改變', errs, undefined);

  // 2. 正確修改：還原後加一行輸出
  await s.step('按「train.py 還原成平台預設程式」', panel.getByRole('button', { name: 'train.py 還原成平台預設程式' }), 'click');
  const restored = await code.inputValue();
  const lines = restored.split('\n');
  let at = 0;
  lines.forEach((l, i) => {
    if (/^(import |from \S+ import )/.test(l)) at = i + 1;
  });
  lines.splice(at, 0, `print("${MARK}")`);
  await s.step('在 import 下面加一行 print', code, { fill: lines.join('\n') }, {
    detail: `本手冊示範加入 print("${MARK}")，送出訓練後可以在訓練輸出看到這一行。`,
  });
  await s.step('按「檢查並套用」', apply, 'click');
  const ok = panel.getByText('已套用「訓練」');
  await expect(ok).toBeVisible({ timeout: 60_000 });
  console.log(`[D2] ${flat(await ok.innerText())}`);
  await s.step('顯示「已套用「訓練」」', ok, undefined);
  const row = panel.getByRole('table', { name: '流程環節' }).getByRole('row').filter({ has: p.getByRole('rowheader', { name: '訓練', exact: true }) });
  await s.step('「訓練」改成「匯入檔控制」、程式已修改', row, undefined);

  // 3. 送出訓練
  await s.step('點「已存設定」分頁', tabs.getByRole('link', { name: '已存設定' }), 'click');
  await mine.waitFor();
  if (await mine.isChecked()) await s.step('取消勾選「只看我建立的」', mine, 'click');
  await s.step('在這份設定按「送出訓練」', p.getByRole('button', { name: `送出訓練「${RUN1}」`, exact: true }), 'click');
  await expect(p).toHaveURL(/\/training\/runs\/\d+$/, { timeout: 60_000 });
  const st = p.getByTestId('run-status');
  await s.wait('等待訓練完成', () => expect(st).toHaveText(/目前狀態：(已完成|失敗|已取消)/, { timeout: 40 * 60_000 }));
  const final = flat(await st.innerText());
  console.log(`[D2] ${final}`);
  expect(final).toContain('已完成');
  await s.step('按「檢視訓練輸出」', p.getByRole('button', { name: '檢視訓練輸出' }), 'click');
  const log = p.getByLabel(/^訓練 #\d+ 的輸出$/);
  await expect(log).toContainText(MARK, { timeout: 30_000 });
  await s.step('輸出裡有剛加的那一行', log, undefined);

  s.section('完成後的樣子', '「流程環節」表格的「訓練」顯示「匯入檔控制」與「程式已修改」；送出的訓練完成後，訓練紀錄的任務欄註明使用匯入的程式，訓練輸出裡看得到修改後程式印出的訊息。');
  s.section('常見問題', [
    '- 按「檢查並套用」後出現「檔案不符合平台的流程框架，未套用：」與原因（例如「train.py 第 78 行語法錯誤」「缺少函式」），設定不會改變。改正後再按一次，或按「train.py 還原成平台預設程式」重來。',
    '- 要改回用畫面設定：在「流程環節」按「改回用介面設定「訓練」」。匯入的檔案會從平台刪除，不能復原，需要保留請先按「下載 Python 與設定檔」。',
    '- 「已存設定」顯示「沒有符合條件的設定。」：預設勾選「只看我建立的」，取消勾選才看得到其他成員的設定。',
  ].join('\n'));
  await s.finish();
});
