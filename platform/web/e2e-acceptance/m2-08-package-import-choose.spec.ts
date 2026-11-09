import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { EVIDENCE_DIR, note, shot } from './helpers';
import {
  Checks, DS80, PB, SETTING, begin, checkPackage, flat, gotoSettings, gotoTraining, importedNotice, openAs, openPackageImport, planInfo,
  selectByPrefix, settingRow, step, submitTraining, waitRun,
} from './m2-common';

// M2驗證\08-專案包匯入選資料.md（F-11 資料對應）。帳號 pi01，專案 M2-FLOW-B（前置已上傳 cohort_01-前80列）。
const TC = '08';

test.use({ actionTimeout: 30_000 });

test('M2 08 專案包匯入（不附資料，自己選資料集）', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  begin(TC, 'M2 08 專案包匯入（不附資料，自己選資料集）');
  const c = new Checks(TC);
  const pkg = path.join(EVIDENCE_DIR, '06', '專案包-不附資料.zip');
  if (!c.check('找到 06\\專案包-不附資料.zip', fs.existsSync(pkg), pkg)) return c.finish();
  const { ctx, page } = await openAs(browser, 'pi01', PB);
  await gotoTraining(page);

  // 1 檢查專案包
  step(TC, 1, '「建模管理」→「匯入專案包」，選 06\\專案包-不附資料.zip，按「檢查專案包」');
  const region = await openPackageImport(page);
  const result = await checkPackage(region, pkg);

  // 2 要求選資料
  step(TC, 2, '檢查結果要求選資料');
  const choose = result.getByLabel('要使用的資料集', { exact: true });
  const p1 = await planInfo(result);
  const options = (await choose.count()) ? (await choose.locator('option').allInnerTexts()).map(flat) : [];
  note(TC, `紅色：${p1.errors || '（無）'}；黃色：${p1.warnings.join(' ／ ') || '（無）'}；「要使用的資料集」選項：${options.join('、') || '（沒有出現）'}；按鈕 ${p1.buttonText}（${p1.enabled ? '可按' : '不能按'}）`);
  await result.scrollIntoViewIfNeeded();
  await shot(page, TC, '01-要求選資料集');
  c.check('步驟 2 出現「要使用的資料集」', (await choose.count()) > 0);
  c.check('步驟 2 「匯入」按鈕還不能按', !p1.enabled, p1.buttonText);
  if (!p1.buttonText.startsWith(`匯入「${SETTING}」`)) c.diff(`匯入按鈕是「${p1.buttonText}」：本專案已有同名設定時名稱自動加「（匯入 N）」，不是「匯入「${SETTING}」」`);

  // 3 選資料集重新檢查
  step(TC, 3, `「要使用的資料集」選 ${DS80}，按「用這個資料重新檢查」`);
  const picked = await selectByPrefix(choose, DS80);
  await result.getByRole('button', { name: '用這個資料重新檢查', exact: true }).click();
  await expect(result.getByTestId('package-mapping')).toContainText(DS80, { timeout: 60_000 });
  const p2 = await planInfo(result);
  note(TC, `選 ${picked}；資料對應：${p2.mapping}；紅色：${p2.errors || '（無）'}；按鈕 ${p2.buttonText}（${p2.enabled ? '可按' : '不能按'}）`);
  await shot(page, TC, '02-重新檢查通過');
  c.check('步驟 3 重新檢查通過、匯入可以按', p2.errors === '' && p2.enabled, p2.mapping);

  // 4 匯入
  step(TC, 4, `按「${p2.buttonText}」`);
  await p2.button.click();
  const n = await importedNotice(page);
  note(TC, `頂端訊息：${n.text}`);
  await shot(page, TC, '03-匯入完成');
  c.check(`步驟 4 結果寫著用了 ${DS80}`, n.text.includes(DS80), n.text);

  // 5 新設定的資料集、訓練
  step(TC, 5, `「建模管理」：新設定的資料集是 ${DS80}，送出訓練，等到「已完成」`);
  await gotoSettings(page); // 匯入後的設定列在「訓練設定」分頁
  const row = settingRow(page, n.setting);
  await expect(row).toBeVisible();
  const dataCell = flat(await row.getByRole('cell').nth(1).innerText());
  note(TC, `「${n.setting}」資料欄：${dataCell}`);
  c.check(`步驟 5 新設定的資料集是 ${DS80}`, dataCell.startsWith(DS80), dataCell);
  const run = await submitTraining(page, n.setting);
  const st = await waitRun(page, run);
  await page.getByTestId('run-status').scrollIntoViewIfNeeded(); // 送出後在單次訓練頁
  await shot(page, TC, '04-單次訓練頁-訓練完成');
  c.check(`步驟 5 訓練 #${run} 已完成`, st === '已完成', st);
  await ctx.close();
  c.finish();
});
