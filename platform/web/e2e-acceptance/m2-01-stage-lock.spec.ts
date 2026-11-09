import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { note, shot } from './helpers';
import {
  Checks, DS, FEATURES, PA, ROW, SETTING, WEB, begin, dirOf, download, editSetting, expandRun, findNumber, flat, gotoTraining, lockBadge,
  openDetails, openEditor, openFlow, openAs, runCells, saveState, selectByPrefix, setFeatures, settingExists, stageStates,
  statesText, statusMsg, step, submitTraining, textArea, uiMetrics, waitRun, zipList, zipRead, type Stage,
} from './m2-common';

// M2驗證\01-單一階段套用與鎖定.md（F-01、F-02、F-03、F-07）。帳號 pi01，專案 M2-FLOW-A。
const TC = '01';
const COMMENT = '# M2 驗證：改過的程式';

test.use({ actionTimeout: 30_000 });

test('M2 01 單一階段套用與鎖定', async ({ browser }) => {
  test.setTimeout(90 * 60_000);
  begin(TC, 'M2 01 單一階段套用與鎖定');
  const c = new Checks(TC);
  const { ctx, page } = await openAs(browser, 'pi01', PA);
  await gotoTraining(page);

  // 1 介面建立設定
  step(TC, 1, `「新增訓練設定」：${SETTING}、結構式資料分類、${DS}、diagnosis、${FEATURES.join('、')}、隨機森林，按「儲存設定」`);
  if (await settingExists(page, SETTING)) {
    c.diff(`訓練設定「${SETTING}」已存在（前一輪留下），沿用，不重新建立；步驟 3 的「五個階段都是介面設定」以目前狀態為準`);
    await shot(page, TC, '01-訓練設定-介面建立設定');
  } else {
    await page.getByRole('button', { name: '新增訓練設定', exact: true }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await form.getByLabel('設定名稱', { exact: true }).fill(SETTING);
    await form.getByLabel('訓練種類', { exact: true }).selectOption({ label: '結構式資料分類' });
    const ds = await selectByPrefix(form.getByLabel('資料集', { exact: true }), `${DS}（`);
    await form.getByLabel('Target 欄位', { exact: true }).selectOption({ label: 'diagnosis' });
    await page.waitForLoadState('networkidle');
    const checked = await setFeatures(form, FEATURES);
    await form.getByLabel('演算法', { exact: true }).selectOption({ label: '隨機森林（Random Forest）' });
    await page.waitForLoadState('networkidle');
    const validation = flat(await form.getByRole('radiogroup', { name: '驗證方式' }).innerText().catch(() => ''));
    const missing = form.getByRole('radiogroup', { name: '有缺值的病人怎麼處理' });
    note(TC, `資料集 ${ds}；勾選 ${checked.join('、')}；驗證方式（預設）${validation}`);
    if (await missing.count()) note(TC, `出現「有缺值的病人怎麼處理」，保留預設選項（md 未寫，照預設）`);
    await form.scrollIntoViewIfNeeded();
    await shot(page, TC, '01-訓練設定-介面建立設定');
    await form.getByRole('button', { name: '儲存設定', exact: true }).click();
    const saved = statusMsg(page, `已新增訓練設定「${SETTING}」。`);
    await expect(saved.or(page.getByRole('alert').first())).toBeVisible({ timeout: 15_000 });
    c.check('步驟 1 儲存設定', await saved.isVisible(), (await saved.isVisible()) ? '' : flat(await page.getByRole('alert').first().innerText()));
  }

  // 2 介面訓練
  step(TC, 2, `按「送出訓練「${SETTING}」」，等到「已完成」，展開記下準確率`);
  const run1 = await submitTraining(page, SETTING);
  const st1 = await waitRun(page, run1);
  const m1 = await uiMetrics(page, run1);
  note(TC, `訓練 #${run1} ${st1}；重點指標：${m1.cards}`);
  await page.getByRole('heading', { name: new RegExp(`^訓練 #${run1}：`) }).scrollIntoViewIfNeeded();
  await shot(page, TC, '02-單次訓練頁-介面訓練完成');
  c.check(`步驟 2 介面設定訓練 #${run1} 已完成（F-01）`, st1 === '已完成', st1);
  saveState({ run_ui: run1 });

  // 3 各階段處理程式碼五階段
  step(TC, 3, `按「各階段處理程式碼「${SETTING}」」`);
  const panel = await openFlow(page, SETTING);
  const s3 = await stageStates(panel);
  note(TC, `五階段：${statesText(s3)}`);
  await shot(page, TC, '03-原始程式碼與專案包-各階段處理程式碼五階段');
  c.check('步驟 3 五個階段都是「介面設定」', Object.values(s3).every((v) => v === '介面設定'), statesText(s3));

  // 4 下載三個階段檔
  step(TC, 4, '標註、資料清理與前處理、訓練各按一次「下載階段檔「…」」，存到 01\\匯出\\');
  const outDir = dirOf(TC, '匯出');
  let missing = 0;
  for (const s of ['labels', 'preprocess', 'train'] as Stage[]) {
    const d = await download(page, () => panel.getByRole('button', { name: `下載階段檔「${ROW[s]}」`, exact: true }).click(), outDir);
    const names = zipList(d.file);
    const need = ['stage.json', `${s}.json`, `${s}.py`];
    const lack = need.filter((n) => !names.includes(n));
    missing += lack.length;
    note(TC, `${ROW[s]}：${path.basename(d.file)}，內含 ${names.join('、')}${lack.length ? `；缺 ${lack.join('、')}` : ''}`);
  }
  await shot(page, TC, '04-下載三個階段檔');
  c.check('步驟 4 三個 zip 都含 stage.json、設定檔、程式檔（F-02，缺漏 0）', missing === 0, `缺漏 ${missing}`);

  // 5 檢視訓練程式碼
  step(TC, 5, '按「檢視程式碼「訓練」」');
  const ed = await openEditor(panel, 'train');
  const tj = textArea(ed, 'train.json');
  const tp = textArea(ed, 'train.py');
  await expect(tj).toBeVisible();
  await expect(tp).toBeVisible();
  await shot(page, TC, '05-檢視訓練程式碼');
  c.check('步驟 5 出現 train.json、train.py 兩個文字框', true);

  // 6 修改後套用
  step(TC, 6, `train.json 的 n_estimators 改成 7；train.py 在 def train 後加一行「${COMMENT}」；按「套用「訓練」」`);
  const json = await tj.inputValue();
  const nBefore = findNumber(json, 'n_estimators');
  note(TC, `train.json 原本 n_estimators = ${nBefore}`);
  saveState({ n_estimators_before: nBefore });
  let newJson = json.replace(/("n_estimators"\s*:\s*)-?[0-9.]+/, (_m, key: string) => `${key}7`);
  if (newJson === json) {
    const obj = JSON.parse(json) as { hyperparameters?: Record<string, unknown> };
    obj.hyperparameters = { ...(obj.hyperparameters ?? {}), n_estimators: 7 };
    newJson = `${JSON.stringify(obj, null, 2)}\n`;
    note(TC, 'train.json 沒有 n_estimators，加在 hyperparameters 內');
  }
  await tj.fill(newJson);
  const lines = (await tp.inputValue()).split('\n');
  const at = lines.findIndex((l) => l.startsWith('def train('));
  c.check('train.py 有 def train', at >= 0);
  lines.splice(at + 1, 0, `    ${COMMENT}`);
  await tp.fill(lines.join('\n'));
  await ed.getByRole('button', { name: `套用「${WEB.train}」`, exact: true }).click();
  const applied = statusMsg(panel, `已套用「${WEB.train}」`);
  await expect(applied.or(panel.getByRole('alert').first())).toBeVisible({ timeout: 60_000 });
  const ok6 = await applied.isVisible();
  note(TC, `套用結果：${flat(await (ok6 ? applied : panel.getByRole('alert').first()).innerText())}`);
  await shot(page, TC, '06-套用訓練通過');
  c.check('步驟 6 套用「訓練」通過', ok6);

  // 7 匯入檔控制
  step(TC, 7, '表格「訓練」變成「匯入檔控制」，清單名稱旁「匯入控制：訓練」');
  const s7 = await stageStates(panel);
  const badge = await lockBadge(page, SETTING);
  note(TC, `五階段：${statesText(s7)}；名稱旁標籤：${badge || '（無）'}`);
  await page.getByRole('table', { name: '訓練設定清單' }).scrollIntoViewIfNeeded();
  await shot(page, TC, '07-訓練設定-訓練改為匯入檔控制');
  c.check('步驟 7 訓練＝匯入檔控制', s7[ROW.train] === '匯入檔控制');
  c.check('步驟 7 名稱旁「匯入控制：訓練」', badge === '匯入控制：訓練', badge);

  // 8 表單鎖定
  step(TC, 8, `「訓練設定」按「修改「${SETTING}」」（原「編輯」）`);
  const form = await editSetting(page, SETTING);
  const locks = flat(await form.getByTestId('stage-locks').innerText());
  note(TC, `表單上方：${locks}`);
  const field = async (label: string) => {
    const f = form.getByLabel(label, { exact: true });
    return (await f.count()) ? ((await f.isDisabled()) ? '停用' : '可改') : '（無此欄位）';
  };
  const fields: Record<string, string> = {};
  for (const l of ['設定名稱', '訓練種類', '資料集', '演算法', '隨機種子', '交叉驗證折數（K）', '訓練集（%）', '驗證集（%）', '測試集（%）']) fields[l] = await field(l);
  note(TC, `欄位狀態：${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join('、')}`);
  await form.scrollIntoViewIfNeeded();
  await shot(page, TC, '08-訓練設定修改-表單鎖定');
  c.check('步驟 8 上方列出「「訓練」由匯入的檔案控制…sha256…」', /「訓練」由匯入的檔案控制：train\.json、train\.py（pi01，.+sha256 [0-9a-f]{4}…）/.test(locks), locks);
  const splitFields = ['交叉驗證折數（K）', '訓練集（%）', '驗證集（%）', '測試集（%）'].filter((l) => fields[l] !== '（無此欄位）');
  c.check('步驟 8 隨機種子、演算法、切分比例停用（F-07）',
    fields['隨機種子'] === '停用' && fields['演算法'] === '停用' && splitFields.every((l) => fields[l] === '停用'),
    splitFields.map((l) => `${l} ${fields[l]}`).join('、'));
  c.check('步驟 8 訓練種類停用', fields['訓練種類'] === '停用');
  c.check('步驟 8 設定名稱可改', fields['設定名稱'] === '可改');

  // 9 取消後送出訓練
  step(TC, 9, `不改任何東西按「取消」，再按「送出訓練「${SETTING}」」`);
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await expect(form).toHaveCount(0);
  const run2 = await submitTraining(page, SETTING);
  note(TC, `送出訓練 #${run2}`);

  // 10 使用匯入的程式訓練
  step(TC, 10, '訓練紀錄標示「（使用匯入的程式：訓練）」，等到「已完成」');
  const st2 = await waitRun(page, run2);
  const cells = await runCells(page, run2);
  note(TC, `訓練 #${run2}：${cells.slice(0, 5).join(' | ')}`);
  await page.getByRole('table', { name: '訓練清單' }).scrollIntoViewIfNeeded();
  await shot(page, TC, '09-訓練紀錄-匯入程式訓練完成');
  c.check('步驟 10 標示「（使用匯入的程式：訓練）」', cells[2]?.includes('（使用匯入的程式：訓練）') ?? false, cells[2]);
  c.check(`步驟 10 匯入程式訓練 #${run2} 已完成（F-03）`, st2 === '已完成', st2);
  saveState({ run_import: run2 });

  // 11 訓練紀錄的設定：n_estimators
  step(TC, 11, '展開這筆訓練看設定內容：n_estimators 是 7');
  await expandRun(page, run2);
  await openDetails(page.locator('.run-detail details').filter({ has: page.locator('summary', { hasText: '這次訓練的資料與設定' }) }), '這次訓練的資料與設定');
  const facts = flat(await page.locator('.run-detail .training-facts').innerText());
  note(TC, `「這次訓練的資料與設定」：${facts}`);
  c.diff('「這次訓練的資料與設定」只列種類、驗證方式、資料版本、隨機種子、開始與結束時間，沒有超參數；n_estimators 改由「檢視訓練輸出」與「匯出原始程式碼」確認');
  await page.getByRole('button', { name: '檢視訓練輸出', exact: true }).click();
  const log = page.getByLabel(`訓練 #${run2} 的輸出`, { exact: true });
  await expect(log).toBeVisible({ timeout: 30_000 });
  const logText = await log.innerText();
  fs.writeFileSync(path.join(dirOf(TC), `訓練-${run2}-輸出.txt`), logText);
  const nLog = findNumber(logText, 'n_estimators');
  const src = await download(page, () => page.getByRole('button', { name: '匯出原始程式碼', exact: true }).click(), dirOf(TC, '訓練紀錄'));
  let nSrc: number | null = null;
  for (const n of zipList(src.file).filter((x) => x.endsWith('.json'))) {
    const v = findNumber(zipRead(src.file, n), 'n_estimators');
    if (v !== null) {
      nSrc = v;
      note(TC, `匯出原始程式碼 ${path.basename(src.file)} 的 ${n}：n_estimators = ${v}`);
      break;
    }
  }
  note(TC, `訓練輸出中的 n_estimators：${nLog ?? '（輸出沒有列出）'}`);
  await page.getByRole('heading', { name: new RegExp(`^訓練 #${run2}：`) }).scrollIntoViewIfNeeded();
  await shot(page, TC, '10-單次訓練頁-設定');
  const n11 = nSrc ?? nLog;
  c.check('步驟 11 訓練紀錄的 n_estimators 是 7（F-03，差異 0 欄）', n11 === 7, `匯出原始程式碼 ${nSrc ?? '—'}、訓練輸出 ${nLog ?? '—'}`);

  await ctx.close();
  c.finish();
});
