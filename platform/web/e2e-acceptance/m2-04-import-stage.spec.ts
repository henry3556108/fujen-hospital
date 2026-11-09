import path from 'node:path';
import { expect, test } from '@playwright/test';
import { note, shot } from './helpers';
import { logout } from './r-common';
import {
  Checks, DS, PA, ROW, SETTING, WEB, begin, dirOf, download, editSetting, flat, gotoSettings, gotoTraining, openEditor, openFlow, openUnlock, openAs,
  stageRow, stageStates, statesText, statusMsg, step, textArea, zipList,
} from './m2-common';

// M2驗證\04-資料匯入階段.md（F-04、F-05；研究助理沒有 Coding 只能操作設定檔階段）。帳號 ra01、pi01，專案 M2-FLOW-A。
const TC = '04';

test.use({ actionTimeout: 30_000 });

test('M2 04 資料匯入階段', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  begin(TC, 'M2 04 資料匯入階段');
  const c = new Checks(TC);

  // 1 研究助理看到的按鈕
  step(TC, 1, `ra01 登入，切到 ${PA}，「建模管理」→「各階段處理程式碼「${SETTING}」」`);
  const ra = await openAs(browser, 'ra01', PA);
  let page = ra.page;
  await gotoTraining(page);
  const mine = page.getByRole('checkbox', { name: '只看我建立的', exact: true });
  if ((await mine.count()) && (await mine.isChecked()) && !(await page.getByRole('link', { name: `各階段處理程式碼「${SETTING}」`, exact: true }).count())) {
    await mine.uncheck();
    c.diff(`訓練設定清單預設勾「只看我建立的」，ra01 要先取消勾選才看得到 pi01 建立的「${SETTING}」`);
  }
  // 研究助理沒有 Coding：仍要能打開各階段處理程式碼操作設定檔階段（資料匯入、部署）
  const flowLink = page.getByRole('link', { name: `各階段處理程式碼「${SETTING}」`, exact: true });
  if (!c.check(`步驟 1 ra01 在「訓練設定」看得到「各階段處理程式碼「${SETTING}」」`, (await flowLink.count()) > 0)) await shot(page, TC, '01-研究助理看不到各階段處理程式碼');
  let panel = await openFlow(page, SETTING);
  const buttons: Record<string, string[]> = {};
  for (const n of Object.values(ROW)) {
    buttons[n] = (await stageRow(panel, n).getByRole('button').allInnerTexts()).map(flat);
  }
  const codeRowsClean = [ROW.labels, ROW.preprocess, ROW.train].every((n) => !buttons[n].some((b) => /^(檢視程式碼|下載階段檔|上傳階段檔)/.test(b)));
  const cfgRows = [ROW.import, ROW.deploy].every((n) => buttons[n].includes(`檢視設定檔「${n}」`));
  const pkgButton = await panel.getByRole('button', { name: '下載整個流程（專案包）', exact: true }).count();
  const pkgBox = await panel.getByRole('checkbox', { name: /^附上原始資料/ }).count();
  note(TC, `各列按鈕：${Object.entries(buttons).map(([k, v]) => `${k}［${v.join('、') || '無'}］`).join('；')}`);
  note(TC, `「下載整個流程（專案包）」${pkgButton ? '有' : '無'}；「附上原始資料」${pkgBox ? '有' : '無'}`);
  await shot(page, TC, '01-研究助理看到的按鈕');
  c.check('步驟 1 標註、前處理、訓練沒有檢視程式碼／下載階段檔／上傳階段檔', codeRowsClean);
  c.check(`步驟 1 資料匯入、${ROW.deploy}有「檢視設定檔」`, cfgRows);
  c.diff(`部署那一列的名稱是「${ROW.deploy}」，按鈕是「檢視設定檔「${ROW.deploy}」」，不是「…「部署」」`);
  c.check('步驟 1 沒有「下載整個流程（專案包）」', pkgButton === 0);

  // 2 下載資料匯入階段檔
  step(TC, 2, '「下載階段檔「資料匯入」」，存到 04\\');
  const d = await download(page, () => panel.getByRole('button', { name: `下載階段檔「${ROW.import}」`, exact: true }).click(), dirOf(TC));
  note(TC, `下載 ${path.basename(d.file)}：${zipList(d.file).join('、')}`);

  // 3 檢視設定檔
  step(TC, 3, '「檢視設定檔「資料匯入」」');
  const ed = await openEditor(panel, 'import');
  const importJson = await textArea(ed, 'import.json').inputValue();
  const hasSchema = (await textArea(ed, 'schema.json').count()) > 0;
  const dsName = (JSON.parse(importJson) as { dataset?: { name?: string } }).dataset?.name;
  note(TC, `import.json：${flat(importJson).slice(0, 300)}；schema.json ${hasSchema ? '有' : '無'}`);
  await shot(page, TC, '02-資料匯入設定檔');
  c.check(`步驟 3 import.json 寫著資料集 ${DS}`, dsName === DS, String(dsName));
  c.check('步驟 3 另有 schema.json', hasSchema);

  // 4 不修改直接套用
  step(TC, 4, '不修改，按「套用「資料匯入」」');
  await ed.getByRole('button', { name: `套用「${WEB.import}」`, exact: true }).click();
  const applied = statusMsg(panel, `已套用「${WEB.import}」`);
  await expect(applied.or(panel.getByRole('alert').first())).toBeVisible({ timeout: 60_000 });
  const ok4 = await applied.isVisible();
  note(TC, `套用結果：${flat(await (ok4 ? applied : panel.getByRole('alert').first()).innerText())}`);
  const s4 = await stageStates(panel);
  note(TC, `五階段：${statesText(s4)}`);
  await shot(page, TC, '03-套用資料匯入');
  c.check('步驟 4 沒改內容直接套用就通過', ok4);
  c.check('步驟 4 資料匯入變成「匯入檔控制」', s4[ROW.import] === '匯入檔控制');
  await gotoSettings(page); // 「資料」欄在「訓練設定」分頁
  const dataCell = flat(await page.getByRole('table', { name: '訓練設定清單' }).getByRole('row')
    .filter({ has: page.getByRole('button', { name: `送出訓練「${SETTING}」`, exact: true }) }).getByRole('cell').nth(1).innerText());
  c.check(`步驟 4 資料集仍是 ${DS}（F-05，差異 0 欄）`, dataCell.startsWith(DS) && !dataCell.includes('匯入結構'), dataCell);

  // 5 登出
  step(TC, 5, 'ra01 登出');
  await logout(page);
  await ra.ctx.close();

  // 6 pi01 編輯：資料集停用
  step(TC, 6, `pi01 登入，「訓練設定」按「修改「${SETTING}」」（原「編輯」）`);
  const pi = await openAs(browser, 'pi01', PA);
  page = pi.page;
  await gotoTraining(page);
  const form = await editSetting(page, SETTING);
  const locks = flat(await form.getByTestId('stage-locks').innerText());
  const dsDisabled = await form.getByLabel('資料集', { exact: true }).isDisabled();
  const algoEnabled = await form.getByLabel('演算法', { exact: true }).isEnabled();
  const seedEnabled = await form.getByLabel('隨機種子', { exact: true }).isEnabled();
  note(TC, `表單上方：${locks}；資料集 ${dsDisabled ? '停用' : '可改'}、演算法 ${algoEnabled ? '可改' : '停用'}、隨機種子 ${seedEnabled ? '可改' : '停用'}`);
  await form.scrollIntoViewIfNeeded();
  await shot(page, TC, '04-訓練設定修改-資料集停用');
  c.check('步驟 6 上方列出「「資料匯入」由匯入的檔案控制…ra01…」', locks.includes('「資料匯入」由匯入的檔案控制') && locks.includes('ra01'), locks);
  c.check('步驟 6 「資料集」停用', dsDisabled);
  c.check('步驟 6 演算法等其他欄位可改', algoEnabled && seedEnabled);

  // 7 改回
  step(TC, 7, '關閉表單，「改回用介面設定「資料匯入」」→「刪除匯入檔並改回介面設定」');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  panel = await openFlow(page, SETTING);
  const dlg = await openUnlock(panel, ROW.import);
  note(TC, `確認視窗：${flat(await dlg.innerText())}`);
  await dlg.getByRole('button', { name: '刪除匯入檔並改回介面設定', exact: true }).click();
  await expect(statusMsg(panel, `已改回用介面設定「${ROW.import}」`)).toBeVisible({ timeout: 30_000 });
  const s7 = await stageStates(panel);
  note(TC, `五階段：${statesText(s7)}`);
  await shot(page, TC, '05-改回');
  c.check('步驟 7 資料匯入改回「介面設定」', s7[ROW.import] === '介面設定');
  await pi.ctx.close();
  c.finish();
});
