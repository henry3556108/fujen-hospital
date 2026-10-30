import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { DIAG_CSV, DICOM_DIR, IMG_PROJECT, IMPORT_PROJECT, RUN1, flat, prepareProject } from './img-common';
import { ROOT, startScenario } from './kit';

// D1（pi01）：把「手冊-胸部影像研究」的訓練流程匯出成專案包，切到新專案「手冊-流程匯入」檢查並匯入。
// 匯入後在新專案的「已存設定」送出訓練，等到完成。
// 鏡頭外準備：admin01 重建「手冊-流程匯入」（pi01 為 PI），pi01 上傳同一批 DICOM 並匯入診斷 CSV（新環境要有自己的影像與標註）。
const PKG_DIR = path.join(ROOT, '資料');

test('D1 把整個流程存下來、換環境重做', async ({ browser }) => {
  test.setTimeout(45 * 60_000);
  await prepareProject(browser, IMPORT_PROJECT, [['pi01', 'Principal Investigator'], ['ca01', 'Coder Assistant']], {
    uploader: 'pi01',
    dicom: DICOM_DIR,
    csv: DIAG_CSV,
  });
  const s = await startScenario(browser, { id: 'D1', title: '匯出流程並在新專案重做', role: 'pi01', manual: '02-計畫主持人', project: IMG_PROJECT });
  const p = s.page;
  s.section('目的', '把一次訓練從資料匯入、標註、前處理、訓練到部署的設定與程式匯出成一個「專案包」，在另一個專案或另一套環境匯入後重做。');
  s.section('開始前準備', `原專案已有存好的訓練設定（本手冊用「${RUN1}」）。目標專案要先建立好、你是成員，並已匯入要用的影像與標註；專案包裡的影像與研究編號已去識別，不會帶過去。`);

  await s.step('按左側選單的「建立模型」', sideNav(p).getByRole('link', { name: SIDE.training, exact: true }), 'click');
  const tabs = p.getByRole('navigation', { name: '建立模型分頁' });
  await s.step('點「已存設定」分頁', tabs.getByRole('link', { name: '已存設定' }), 'click');
  await s.step(`按「${RUN1}」的「流程程式碼」`, p.getByRole('link', { name: `流程程式碼「${RUN1}」`, exact: true }), 'click');
  const panel = p.getByRole('region', { name: `流程程式碼「${RUN1}」` });
  const stages = panel.getByRole('table', { name: '流程環節' });
  await expect(stages).toBeVisible();
  console.log(`[D1] 環節：${flat(await stages.innerText())}`);
  await s.step('「流程環節」列出五個環節', stages, undefined, { zoom: false });
  const exportBtn = panel.getByRole('button', { name: '下載整個流程（專案包）', exact: true });
  const dl = p.waitForEvent('download', { timeout: 120_000 });
  await s.step('按「下載整個流程（專案包）」', exportBtn, 'click', {
    detail: '專案包是一個 zip，內含五個環節的設定與程式，以及在自己電腦重做的說明（README.md、run_all.py）。',
  });
  const d = await dl;
  fs.mkdirSync(PKG_DIR, { recursive: true });
  const pkg = path.join(PKG_DIR, d.suggestedFilename());
  await d.saveAs(pkg);
  console.log(`[D1] 專案包：${pkg}（${fs.statSync(pkg).size} bytes）`);
  await s.note('專案包下載到電腦');

  // 切到新專案匯入
  await s.step(`頂端「目前專案」切到 ${IMPORT_PROJECT}`, p.locator('select#project-switcher'), { select: { label: IMPORT_PROJECT } });
  await expect(p.locator('select#project-switcher option:checked')).toHaveText(IMPORT_PROJECT);
  await p.waitForLoadState('networkidle').catch(() => undefined);
  if (!(await tabs.count())) await s.step('按左側選單的「建立模型」', sideNav(p).getByRole('link', { name: SIDE.training, exact: true }), 'click');
  await s.step('點「程式與專案包」分頁', tabs.getByRole('link', { name: '程式與專案包' }), 'click');
  await s.step('按「匯入專案包」', p.getByRole('button', { name: '匯入專案包', exact: true }), 'click');
  const region = p.getByRole('region', { name: '匯入整個流程（專案包）' });
  await expect(region).toBeVisible();
  const picker = region.getByRole('button', { name: '選擇檔案' });
  if (await picker.count()) await s.step('在「專案包（zip）」選剛下載的檔案', picker, { upload: pkg });
  else await s.step('在「專案包（zip）」選剛下載的檔案', region.getByLabel('專案包（zip）', { exact: true }), { upload: pkg });
  await s.step('按「檢查專案包」', region.getByRole('button', { name: '檢查專案包', exact: true }), 'click');
  const result = region.getByRole('group', { name: '檢查結果' });
  await s.wait('等待檢查結果', () => expect(result.or(region.getByRole('alert').first())).toBeVisible({ timeout: 120_000 }), { manual: false });
  console.log(`[D1] 檢查結果：${flat(await region.innerText()).slice(0, 600)}`);
  await s.step('檢查結果列出內容與注意事項', result, undefined, { zoom: false });
  const range = result.getByRole('radiogroup', { name: '要使用的影像範圍' });
  if (await range.count()) {
    await s.step('影像範圍選「本專案全部研究」', range.getByLabel(/^本專案全部研究/), 'click');
    await s.step('按「用這個資料重新檢查」', result.getByRole('button', { name: '用這個資料重新檢查', exact: true }), 'click');
    await p.waitForLoadState('networkidle').catch(() => undefined);
    console.log(`[D1] 重新檢查：${flat(await result.innerText()).slice(0, 400)}`);
  }
  const importBtn = result.getByRole('button', { name: /^匯入「/ });
  await expect(importBtn).toBeEnabled({ timeout: 60_000 });
  await s.step('按「匯入「…」」', importBtn, 'click');
  const notice = p.getByRole('status').filter({ hasText: '已匯入專案包，建立訓練設定「' }).first();
  const failed = region.getByRole('alert').first();
  await expect(notice.or(failed)).toBeVisible({ timeout: 120_000 });
  if (!(await notice.isVisible())) throw new Error(`匯入失敗：${flat(await failed.innerText())}`);
  const noticeText = flat(await notice.innerText());
  console.log(`[D1] ${noticeText}`);
  const imported = /建立訓練設定「([^」]+)」/.exec(noticeText)![1];
  await s.step('上方顯示「已匯入專案包，建立訓練設定」', notice, undefined, {
    detail: '匯入後會建立一份新的訓練設定，並列出影像範圍與由匯入檔控制的環節。',
  });

  // 在新專案送出訓練
  await s.step('點「已存設定」分頁', tabs.getByRole('link', { name: '已存設定' }), 'click');
  const mine = p.getByRole('checkbox', { name: '只看我建立的' });
  await mine.waitFor();
  if (await mine.isChecked()) await s.step('取消勾選「只看我建立的」', mine, 'click');
  await s.step(`在「${imported}」按「送出訓練」`, p.getByRole('button', { name: `送出訓練「${imported}」`, exact: true }), 'click');
  await expect(p).toHaveURL(/\/training\/runs\/\d+$/, { timeout: 60_000 });
  const st = p.getByTestId('run-status');
  await s.step('畫面顯示這次訓練與目前狀態', st, undefined);
  await s.wait('等待訓練完成（自動更新）', () => expect(st).toHaveText(/目前狀態：(已完成|失敗|已取消)/, { timeout: 40 * 60_000 }));
  const final = flat(await st.innerText());
  console.log(`[D1] 新專案訓練：${final}`);
  expect(final).toContain('已完成');
  await s.step('新專案的訓練完成', st, undefined);

  s.section('完成後的樣子', `電腦裡有一個專案包 zip（例如 project-90-…-flow-日期.zip），內含五個環節的設定與程式、README.md 與 run_all.py，可以在自己電腦依 README 重做。新專案「${IMPORT_PROJECT}」的「已存設定」多了一份同名的訓練設定，用它送出的訓練顯示「目前狀態：已完成」。`);
  s.section('常見問題', [
    '- 檢查結果要你選影像範圍：專案包內的研究編號已去識別，平台找不到內容相同的影像，畫面說明「專案包內的研究編號已去識別，平台找不到內容相同的影像資料版本。請選擇要用本專案的哪些研究。」',
    '- 「匯入」按鈕不能按，旁邊寫「請先選擇要對應的資料並重新檢查。」：先選影像範圍，再按「用這個資料重新檢查」。',
    '- 看不到「程式與專案包」分頁：帳號沒有 Coding 權限，畫面會顯示「匯出專案包需要 Coding 權限。」',
  ].join('\n'));
  await s.finish();
});
