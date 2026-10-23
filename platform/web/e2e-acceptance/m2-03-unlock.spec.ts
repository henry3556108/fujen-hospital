import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { EVIDENCE_DIR, note, shot } from './helpers';
import {
  Checks, PA, ROW, SETTING, begin, chooseFile, dirOf, download, findNumber, flat, gotoTraining, loadState, lockBadge, openEditor, openFlow,
  openUnlock, openAs, runsTable, stageStates, statesText, statusMsg, step, textArea, zipList, zipRead,
} from './m2-common';

// M2驗證\03-改回用介面設定.md（F-08）。帳號 pi01，專案 M2-FLOW-A，設定 FLOW-結構式（訓練環節為匯入檔控制）。
const TC = '03';

/** 01 匯出的訓練環節檔（匯入前）裡的 n_estimators；找不到時用 01 記下的值 */
function originalN(): number | null {
  const dir = path.join(EVIDENCE_DIR, '01', '匯出');
  const zip = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.zip') && f.includes('train')) : undefined;
  if (zip) {
    const v = findNumber(zipRead(path.join(dir, zip), 'train.json'), 'n_estimators');
    if (v !== null) return v;
  }
  const s = loadState().n_estimators_before;
  return typeof s === 'number' ? s : null;
}

test.use({ actionTimeout: 30_000 });

test('M2 03 改回用介面設定', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  begin(TC, 'M2 03 改回用介面設定');
  const c = new Checks(TC);
  const { ctx, page } = await openAs(browser, 'pi01', PA);
  await gotoTraining(page);
  const panel = await openFlow(page, SETTING);
  note(TC, `開始前五環節：${statesText(await stageStates(panel))}`);

  // 重跑準備：上一次已改回時，把 03 下載的匯入檔（n_estimators 7）再上傳一次，回到「匯入檔控制」
  if ((await stageStates(panel))[ROW.train] !== '匯入檔控制') {
    const prev = path.join(dirOf(TC), 'FLOW-train.zip');
    const again = path.join(dirOf(TC), '重跑前-FLOW-train.zip');
    fs.copyFileSync(prev, again);
    await chooseFile(page, () => panel.getByRole('button', { name: `上傳環節檔「${ROW.train}」`, exact: true }).click(), again);
    await expect.poll(async () => (await stageStates(panel))[ROW.train], { timeout: 30_000 }).toBe('匯入檔控制');
    note(TC, `重跑準備：上傳 ${path.basename(again)}，訓練回到「匯入檔控制」`);
  }

  // 1 確認視窗
  step(TC, 1, '訓練那一列按「改回用介面設定「訓練」」');
  let dlg = await openUnlock(panel, ROW.train);
  note(TC, `確認視窗：${flat(await dlg.innerText())}`);
  await shot(page, TC, '01-確認視窗');
  c.check('步驟 1 確認視窗出現', true);

  // 2 取消
  step(TC, 2, '按「取消」');
  await dlg.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dlg).toHaveCount(0);
  const s2 = await stageStates(panel);
  await shot(page, TC, '02-取消後不變');
  c.check('步驟 2 取消後訓練仍是「匯入檔控制」', s2[ROW.train] === '匯入檔控制', statesText(s2));

  // 3 下載匯入檔
  step(TC, 3, '再按「改回用介面設定「訓練」」，先按「下載匯入檔」，存到 03\\');
  dlg = await openUnlock(panel, ROW.train);
  const d = await download(page, () => dlg.getByRole('button', { name: '下載匯入檔', exact: true }).click(), dirOf(TC));
  const nImported = findNumber(zipRead(d.file, 'train.json'), 'n_estimators');
  note(TC, `下載 ${path.basename(d.file)}：${zipList(d.file).join('、')}；train.json 的 n_estimators = ${nImported}`);
  await shot(page, TC, '03-下載匯入檔');
  c.check('步驟 3 下載的 zip 是 n_estimators 7 的版本', nImported === 7, String(nImported));

  // 4 刪除匯入檔並改回
  step(TC, 4, '按「刪除匯入檔並改回介面設定」');
  await dlg.getByRole('button', { name: '刪除匯入檔並改回介面設定', exact: true }).click();
  await expect(statusMsg(panel, `已改回用介面設定「${ROW.train}」，匯入的檔案已刪除。`)).toBeVisible({ timeout: 30_000 });
  const s4 = await stageStates(panel);
  await page.waitForLoadState('networkidle');
  const badge = await lockBadge(page, SETTING);
  note(TC, `五環節：${statesText(s4)}；名稱旁標籤：${badge || '（無）'}`);
  await page.getByRole('table', { name: '訓練設定清單' }).scrollIntoViewIfNeeded();
  await shot(page, TC, '04-改回介面設定');
  c.check('步驟 4 訓練變回「介面設定」', s4[ROW.train] === '介面設定');
  c.check('步驟 4 名稱旁「匯入控制」標籤消失', badge === '', badge);

  // 5 設定回到匯入前
  step(TC, 5, '「檢視程式碼「訓練」」：n_estimators 回到原值、train.py 沒有「M2 驗證」註解');
  const ed = await openEditor(panel, 'train');
  const nNow = findNumber(await textArea(ed, 'train.json').inputValue(), 'n_estimators');
  const hasComment = (await textArea(ed, 'train.py').inputValue()).includes('M2 驗證');
  const nOrig = originalN();
  note(TC, `train.json n_estimators = ${nNow}（匯入前 ${nOrig}）；train.py 含「M2 驗證」：${hasComment ? '是' : '否'}`);
  await shot(page, TC, '05-設定回到匯入前');
  c.check('步驟 5 n_estimators 回到原值（不是 7）', nNow !== 7 && (nOrig === null || nNow === nOrig), `${nNow}／匯入前 ${nOrig}`);
  c.check('步驟 5 train.py 沒有「M2 驗證」那行', !hasComment);
  await ed.getByRole('button', { name: '不套用，關閉', exact: true }).click();

  // 6 表單解鎖
  step(TC, 6, `「編輯「${SETTING}」」：演算法、亂數種子可以改`);
  await page.getByRole('button', { name: `編輯「${SETTING}」`, exact: true }).click();
  const form = page.getByRole('form', { name: `修改訓練設定「${SETTING}」` });
  await expect(form).toBeVisible();
  const algo = await form.getByLabel('演算法', { exact: true }).isEnabled();
  const seed = await form.getByLabel('亂數種子', { exact: true }).isEnabled();
  const locks = await form.getByTestId('stage-locks').count();
  note(TC, `演算法 ${algo ? '可改' : '停用'}、亂數種子 ${seed ? '可改' : '停用'}；上方匯入控制說明 ${locks ? '有' : '無'}`);
  await form.scrollIntoViewIfNeeded();
  await shot(page, TC, '06-表單解鎖');
  c.check('步驟 6 演算法、亂數種子可以改', algo && seed);
  await form.getByRole('button', { name: '取消', exact: true }).click();

  // 7 訓練紀錄仍在
  step(TC, 7, '「建模管理」訓練紀錄：01 的兩筆訓練與模型都還在');
  const st = loadState();
  const ids = [st.run_ui, st.run_import].filter((x): x is number => typeof x === 'number');
  const runs = runsTable(page);
  await runs.scrollIntoViewIfNeeded();
  const found: string[] = [];
  for (const id of ids) {
    const row = runs.getByRole('row').filter({ has: page.getByRole('cell', { name: `#${id}`, exact: true }) });
    found.push((await row.count()) ? `#${id} ${flat((await row.getByRole('cell').nth(3).innerText()))}` : `#${id} 不在第一頁`);
  }
  note(TC, `01 的訓練：${found.join('、') || '（01 沒有記下編號）'}；訓練清單：${flat(await runs.innerText()).slice(0, 400)}`);
  await shot(page, TC, '07-訓練紀錄仍在');
  c.check('步驟 7 01 的兩筆訓練仍是已完成', ids.length === 2 && found.every((f) => f.endsWith('已完成')), found.join('、'));
  let models = 0;
  for (const id of ids) {
    const open = page.getByRole('button', { name: `展開訓練 #${id}`, exact: true });
    if (!(await open.count())) continue;
    await open.click();
    const exportSection = page.getByRole('region', { name: '模型匯出' });
    if (await exportSection.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      models++;
      note(TC, `訓練 #${id}：${flat(await exportSection.innerText()).slice(0, 120)}`);
    }
  }
  c.check('步驟 7 兩筆訓練的模型都還在（展開有「模型匯出」）', models === ids.length && ids.length === 2, `${models}/${ids.length}`);
  await ctx.close();
  c.finish();
});
