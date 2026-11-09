import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { EVIDENCE_DIR, note, shot } from './helpers';
import {
  Checks, PA, PB, SETTING, begin, checkPackage, diffRows, dirOf, esc, flat, gotoSettings, gotoTabular, gotoTraining, importedNotice, latestUiRun,
  openAs, openPackageImport, planInfo, settingExists, step, submitTraining, switchProject, uiMetrics, waitRun,
} from './m2-common';

// M2驗證\07-專案包匯入附資料.md（F-11 匯入到另一個專案，送出訓練成功，設定與匯出時差異 0）。帳號 pi01，專案 M2-FLOW-B。
const TC = '07';

test.use({ actionTimeout: 30_000 });

test('M2 07 專案包匯入（附資料）', async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  begin(TC, 'M2 07 專案包匯入（附資料）');
  const c = new Checks(TC);
  const pkg = path.join(EVIDENCE_DIR, '06', '專案包-附資料.zip');
  if (!c.check('找到 06\\專案包-附資料.zip', fs.existsSync(pkg), pkg)) return c.finish();

  // 1 切到 M2-FLOW-B，匯入專案包
  step(TC, 1, `右上角「目前專案」切到 ${PB}，「建模管理」→「匯入專案包」`);
  const { ctx, page } = await openAs(browser, 'pi01', PB);
  await gotoTraining(page);
  let region = await openPackageImport(page);
  await shot(page, TC, '01-原始程式碼與專案包-匯入專案包');

  // 2、3 檢查專案包
  step(TC, 2, '「專案包（zip）」選 06\\專案包-附資料.zip，按「檢查專案包」');
  let result = await checkPackage(region, pkg);
  const p = await planInfo(result);
  step(TC, 3, '看檢查結果');
  note(TC, `紅色：${p.errors || '（無）'}；黃色「請注意」：${p.warnings.join(' ／ ') || '（無）'}；專案包內容：${p.contents}；資料對應：${p.mapping}；按鈕：${p.buttonText}（${p.enabled ? '可按' : '不能按'}）`);
  await result.scrollIntoViewIfNeeded();
  await shot(page, TC, '02-檢查結果');
  c.check('步驟 3 沒有紅色「不能匯入」', p.errors === '', p.errors);
  if (!p.warnings.some((w) => w.includes('部署階段沒有匯入'))) {
    c.diff('黃色「請注意」沒有「部署階段沒有匯入」：這句只在專案包內「部署」階段是匯入檔控制時出現（flow_import.py），05 已改回介面設定，所以 06 的專案包不會有');
  }
  c.check(`步驟 3 專案包內容顯示 ${SETTING}、結構式資料分類`, p.contents.includes(SETTING) && p.contents.includes('結構式資料分類'), p.contents);
  c.check('步驟 3 資料對應：用專案包附的資料建立新資料集', p.mapping.includes('專案包內附的資料') && p.mapping.includes('建立一個新的資料集'), p.mapping);
  c.diff(`資料對應的文字是「${p.mapping}」，不是「用專案包附的資料建立新資料集」`);

  // 4 匯入
  step(TC, 4, `按「${p.buttonText}」`);
  await p.button.click();
  const n1 = await importedNotice(page);
  const dsName = /資料集「(.+?)」/.exec(n1.text)?.[1] ?? '';
  note(TC, `頂端訊息：${n1.text}`);
  await shot(page, TC, '03-匯入完成');
  c.check('步驟 4 建立新的訓練設定', Boolean(n1.setting), n1.setting);
  c.check('步驟 4 建立新資料集', Boolean(dsName), dsName);

  // 5 新資料集
  step(TC, 5, '「數據管理」→「結構式資料」：多一個從專案包建立的資料集');
  await gotoTabular(page);
  const dsRow = page.getByRole('table', { name: '資料集列表' }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: dsName, exact: true }) });
  const dsText = (await dsRow.count()) ? flat(await dsRow.innerText()) : '';
  note(TC, `資料集列表：${flat(await page.getByRole('table', { name: '資料集列表' }).innerText()).slice(0, 400)}`);
  if (await dsRow.count()) await dsRow.scrollIntoViewIfNeeded();
  await shot(page, TC, '04-新資料集');
  c.check(`步驟 5 資料集列表有「${dsName}」`, Boolean(dsText), dsText);

  // 6 送出訓練
  step(TC, 6, `「建模管理」：多一份 ${n1.setting}，按「送出訓練「${n1.setting}」」，等到「已完成」`);
  await gotoTraining(page);
  c.check(`步驟 6 清單有「${n1.setting}」`, await settingExists(page, n1.setting));
  const runB = await submitTraining(page, n1.setting);
  const stB = await waitRun(page, runB);
  await page.getByTestId('run-status').scrollIntoViewIfNeeded(); // 送出後在單次訓練頁
  await shot(page, TC, '05-單次訓練頁-訓練完成');
  c.check(`步驟 6 訓練 #${runB} 已完成`, stB === '已完成', stB);

  // 7 指標比對
  step(TC, 7, `展開訓練，指標與 ${PA} 那份設定（介面設定版本）最近一次訓練相同`);
  const mB = await uiMetrics(page, runB);
  await shot(page, TC, '06-單次訓練頁-指標');
  await switchProject(page, PA);
  await gotoTraining(page);
  const runA = await latestUiRun(page, SETTING);
  const mA = runA !== null ? await uiMetrics(page, runA) : { cards: '', rows: [] as string[], cv: [] as string[] };
  const d = [...diffRows(mB.rows, mA.rows), ...diffRows(mB.cv, mA.cv)];
  const lines = [
    `${PB}「${n1.setting}」訓練 #${runB}｜${PA}「${SETTING}」介面設定版本訓練 #${runA ?? '—'}`, '',
    `重點指標：${mB.cards}`, `重點指標：${mA.cards}`, '',
    '【所有指標】', ...mB.rows.map((r, i) => `${r}　｜　${mA.rows[i] ?? '（無）'}`), '',
    '【K 折】', ...mB.cv.map((r, i) => `${r}　｜　${mA.cv[i] ?? '（無）'}`), '',
    `差異：${d.join('；') || '0 項'}`,
  ];
  fs.writeFileSync(path.join(dirOf(TC), '07-指標比對.txt'), `${lines.join('\n')}\n`);
  note(TC, `${PB} #${runB}：${mB.cards}`);
  note(TC, `${PA} #${runA ?? '—'}：${mA.cards}`);
  c.check('步驟 7 指標與原專案相同（差異 0）', runA !== null && mB.rows.length > 0 && d.length === 0, d.join('；') || '0 項');

  // 8 同一包再匯入一次
  step(TC, 8, '同一個專案包再匯入一次（步驟 1～4）');
  await switchProject(page, PB);
  await gotoTraining(page);
  region = await openPackageImport(page);
  result = await checkPackage(region, pkg);
  const p2 = await planInfo(result);
  note(TC, `第二次檢查：按鈕 ${p2.buttonText}；資料對應 ${p2.mapping}`);
  await p2.button.click();
  const n2 = await importedNotice(page);
  note(TC, `頂端訊息：${n2.text}`);
  await shot(page, TC, '07-重名加序號');
  c.check('步驟 8 重名自動加序號', new RegExp(`^${esc(SETTING)}（匯入 \\d+）$`).test(n2.setting), n2.setting);
  if (n2.setting !== `${SETTING}（匯入 1）`) c.diff(`重名時的名稱是「${n2.setting}」：原始程式碼從「（匯入 2）」開始編號（flow_import._unique_setting_name），不是「（匯入 1）」`);
  await gotoSettings(page); // 匯入後的設定列在「訓練設定」分頁
  await expect(page.getByRole('button', { name: `送出訓練「${n2.setting}」`, exact: true })).toBeVisible();
  await ctx.close();
  c.finish();
});
