import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { EVIDENCE_DIR, note, shot } from './helpers';
import {
  Checks, PA, ROW, SETTING, WEB, begin, chooseFile, errorAlert, flat, gotoTraining, openEditor, openFlow, openAs, stageStates,
  statesText, step, textArea, type Stage,
} from './m2-common';

// M2驗證\02-不符框架列出錯誤.md（F-06）。帳號 pi01，專案 M2-FLOW-A，設定 FLOW-結構式（01 做完的狀態）。
const TC = '02';

test.use({ actionTimeout: 30_000 });

test('M2 02 不符框架的檔案被擋下', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  begin(TC, 'M2 02 不符框架的檔案被擋下');
  const c = new Checks(TC);
  const { ctx, page } = await openAs(browser, 'pi01', PA);
  await gotoTraining(page);
  const panel = await openFlow(page, SETTING);
  const before = await stageStates(panel);
  note(TC, `開始前五環節：${statesText(before)}`);
  let rejected = 0;
  let accepted = 0;

  /** 套用後讀紅框；若意外通過也記下 */
  async function applyAndRead(ed: Locator, stage: Stage) {
    await ed.getByRole('button', { name: `套用「${WEB[stage]}」`, exact: true }).click();
    const ok = panel.getByRole('status').filter({ hasText: `已套用「${WEB[stage]}」` });
    await expect(ok.or(panel.getByRole('alert').first())).toBeVisible({ timeout: 60_000 });
    if (await ok.isVisible()) {
      accepted++;
      return { text: flat(await ok.innerText()), list: [] as string[] };
    }
    rejected++;
    return errorAlert(panel);
  }

  async function closeEditor(stage: Stage) {
    const ed = panel.getByRole('group', { name: new RegExp(`「${WEB[stage]}」$`) });
    if (await ed.count()) await ed.getByRole('button', { name: '不套用，關閉', exact: true }).click();
  }

  // 1 錯誤環節：把 01 下載的「訓練」zip 上傳到「標註」
  step(TC, 1, '「上傳環節檔「標註」」選 01 下載的「訓練」zip');
  const exportDir = path.join(EVIDENCE_DIR, '01', '匯出');
  const trainZip = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).find((f) => f.endsWith('.zip') && f.includes('train')) : undefined;
  if (!c.check('找到 01\\匯出\\ 裡檔名有 train 的 zip', Boolean(trainZip), trainZip ?? '（沒有，請先跑 01）')) {
    await ctx.close();
    return c.finish();
  }
  await chooseFile(page, () => panel.getByRole('button', { name: `上傳環節檔「${ROW.labels}」`, exact: true }).click(), path.join(exportDir, trainZip!));
  const e1 = await errorAlert(panel);
  rejected++;
  note(TC, `紅框：${e1.text}`);
  await panel.getByRole('alert').first().scrollIntoViewIfNeeded();
  await shot(page, TC, '01-錯誤環節');
  c.check('步驟 1 提示「這個檔案是「訓練」環節，請到「訓練」匯入」', e1.text.includes('這個檔案是「訓練」環節，請到「訓練」匯入'));
  c.diff('步驟 1 是上傳檔案，畫面上沒有編輯區，所以沒有「不套用，關閉」可按');

  // 2 缺進入點＋不支援的套件
  step(TC, 2, '「檢視程式碼「標註」」，labels.py 加 import requests、def build_labels 改名 def make_labels，按「套用「標註」」');
  let ed = await openEditor(panel, 'labels');
  let lp = textArea(ed, 'labels.py');
  const original = await lp.inputValue();
  let code = original.replace('def build_labels(', 'def make_labels(');
  const lines = code.split('\n');
  const imp = lines.findIndex((l) => l.startsWith('import ') || l.startsWith('from '));
  lines.splice(imp >= 0 ? imp + 1 : 0, 0, 'import requests');
  code = lines.join('\n');
  await lp.fill(code);
  const e2 = await applyAndRead(ed, 'labels');
  note(TC, `紅框：${e2.text}；清單：${e2.list.join(' ／ ')}`);
  await shot(page, TC, '02-缺進入點與套件');
  const missingEntry = e2.list.some((m) => m.includes('labels.py') && m.includes('缺少函式 build_labels'));
  const badImport = e2.list.some((m) => m.includes('labels.py') && m.includes('「requests」'));
  c.check('步驟 2 一次列出缺少 build_labels、不允許 requests，都標明 labels.py', missingEntry && badImport, e2.list.join(' ／ '));
  await closeEditor('labels');

  // 3 參數超出範圍
  step(TC, 3, '「檢視程式碼「資料清理與前處理」」，preprocess.json 第一個步驟的 id 改成 no_such_step，按套用');
  ed = await openEditor(panel, 'preprocess');
  const pj = textArea(ed, 'preprocess.json');
  const cfg = JSON.parse(await pj.inputValue()) as { steps?: { id?: string }[] };
  if (cfg.steps && cfg.steps.length) {
    note(TC, `preprocess.json 第 1 個步驟原本是 ${JSON.stringify(cfg.steps[0])}`);
    cfg.steps[0].id = 'no_such_step';
  } else {
    c.diff('preprocess.json 的 steps 是空的（資料集沒有設定前處理步驟），改為加入一個 {"id": "no_such_step"} 的步驟');
    cfg.steps = [{ id: 'no_such_step' }];
  }
  await pj.fill(`${JSON.stringify(cfg, null, 2)}\n`);
  const e3 = await applyAndRead(ed, 'preprocess');
  note(TC, `紅框：${e3.text}；清單：${e3.list.join(' ／ ')}`);
  await shot(page, TC, '03-參數超出範圍');
  c.check('步驟 3 紅框指出 preprocess.json 第 1 個步驟', e3.list.some((m) => m.startsWith('preprocess.json：第 1 個步驟')), e3.list.join(' ／ '));
  await closeEditor('preprocess');

  // 4 語法錯誤
  step(TC, 4, '「檢視程式碼「標註」」，labels.py 最後加一行 def broken(:，按套用');
  ed = await openEditor(panel, 'labels');
  lp = textArea(ed, 'labels.py');
  await lp.fill(`${(await lp.inputValue()).replace(/\n*$/, '')}\ndef broken(:\n`);
  const e4 = await applyAndRead(ed, 'labels');
  note(TC, `紅框：${e4.text}；清單：${e4.list.join(' ／ ')}`);
  await shot(page, TC, '04-語法錯誤');
  c.check('步驟 4 紅框指出 labels.py 的行號', e4.list.some((m) => /^labels\.py 第 \d+ 行語法錯誤/.test(m)), e4.list.join(' ／ '));
  await closeEditor('labels');

  // 5 設定沒變
  step(TC, 5, '關掉後看流程程式碼表格');
  const after = await stageStates(panel);
  note(TC, `五環節：${statesText(after)}`);
  await panel.getByRole('table', { name: '流程環節' }).scrollIntoViewIfNeeded();
  await shot(page, TC, '05-狀態未改變');
  c.check('步驟 5 標註、前處理仍是「介面設定」，訓練仍是「匯入檔控制」',
    after[ROW.labels] === '介面設定' && after[ROW.preprocess] === '介面設定' && after[ROW.train] === '匯入檔控制', statesText(after));
  c.check('拒絕 4 次（5 種錯誤）、成功 0 次', rejected === 4 && accepted === 0, `拒絕 ${rejected}、成功 ${accepted}`);
  await ctx.close();
  c.finish();
});
