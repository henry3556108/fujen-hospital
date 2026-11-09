import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clickMenu, clickTab, note, shot, useProject } from './helpers';
import { PROJECT_TABS, adminTab, projectTab, userPage, waitIdle } from './ops';

// 不用診斷 CSV，在工作台一筆一筆手動做分類標註（「儲存並開啟下一筆」一路往下），
// 再從「標註資料集」→「用這份資料建立訓練任務」→ 建立訓練任務精靈送出，確認訓練完成（介面改版後的流程）。
// 同時存證標註易用性的修正：分類標在影像左上角、待處理清單顯示類別與進度、標籤不預填、
// 分類預設整個研究、沒存的草稿離開前提醒、只有 1 種 Label 時先擋下。
//   EVIDENCE_DIR=<存證資料夾> npx playwright test -c playwright.acceptance.config.ts zz-manual-label-train --headed
// 專案 LABEL-手動標註（共享池 gpu-shared，pi01 為 PI）每次重建；跑完留著供檢視。

const PROJECT = 'LABEL-手動標註';
const DATA = process.env.DEMO_DATA || '/mnt/c/Users/skyland/Desktop/workspace/Demo腳本/演示資料';
const TC = '手動標註到訓練';
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

test.use({ actionTimeout: 30_000 });

test('準備：admin01 重建 LABEL-手動標註並加入 pi01', async ({ browser }) => {
  const { ctx, page } = await userPage(browser, 'admin01');
  await adminTab(page, '專案');
  await page.waitForLoadState('networkidle');
  if (await page.getByRole('table', { name: '專案列表' }).getByRole('rowheader', { name: PROJECT, exact: true }).count()) {
    await page.getByRole('button', { name: `刪除 ${PROJECT}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
    await expect(status(page, `已刪除專案「${PROJECT}」`)).toBeVisible();
  }
  const form = page.getByRole('form', { name: '新增專案' });
  await form.getByLabel('專案名稱（必填）').fill(PROJECT);
  const group = form.getByLabel('GPU 群組');
  const option = (await group.locator('option').allInnerTexts()).find((t) => t.startsWith('gpu-shared'));
  await group.selectOption({ label: option! });
  await form.getByRole('button', { name: '新增專案' }).click();
  await expect(status(page, `已新增專案「${PROJECT}」`)).toBeVisible();
  // 成員在專案頁的「成員與權限」分頁
  await projectTab(page, PROJECT, PROJECT_TABS.members);
  await page.waitForLoadState('networkidle');
  const f = page.getByRole('form', { name: '設定專案成員' });
  await f.getByLabel('帳號').selectOption({ label: 'pi01' });
  await f.getByLabel('角色').selectOption({ label: 'Principal Investigator' });
  await f.getByRole('button', { name: '加入專案' }).click();
  await expect(status(page, '已將「pi01」設定為')).toBeVisible();
  note(TC, `已建立專案 ${PROJECT}（${option}），pi01 為 Principal Investigator`);
  await ctx.close();
});

test('手動分類標註 20 個研究，不上傳診斷 CSV，再送出訓練到完成', async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  const { page } = await userPage(browser, 'pi01');
  await waitIdle(page, 600);
  await useProject(page, PROJECT);

  // 匯入影像：數據管理 → 影像 →「匯入資料」→ 從電腦上傳（整個資料夾）
  await clickMenu(page, '數據管理');
  await page.getByRole('link', { name: '匯入資料', exact: true }).click();
  const dicom = page.getByRole('form', { name: '從電腦上傳' });
  await dicom.getByRole('checkbox', { name: '選擇整個資料夾（保留資料夾路徑）' }).check();
  await dicom.locator('input[type=file]').setInputFiles(path.join(DATA, '1-影像'));
  await dicom.getByRole('button', { name: /^上傳到「/ }).click();
  const imported = dicom.getByRole('region', { name: 'DICOM 匯入結果' });
  await expect(imported).toContainText(/新增 \d+、重複 \d+、失敗 \d+/, { timeout: 5 * 60_000 });
  note(TC, `步驟 1 影像匯入：${flat(await imported.innerText()).slice(0, 120)}`);
  // 改版後「匯入資料」是滑出面板，遮罩會擋住側欄：照使用者操作按「到影像清單查看」關閉面板
  await dicom.getByRole('link', { name: '到影像清單查看' }).click();
  await expect(page.getByTestId('slideover-backdrop')).toHaveCount(0);

  // 待處理清單：還沒標註
  await clickMenu(page, '影像標註');
  const progress = page.getByTestId('label-progress');
  await expect(progress).toBeVisible();
  note(TC, `步驟 2 標註前：${flat(await progress.innerText())}`);
  await shot(page, TC, '01-待處理清單-標註前');

  // 正確答案取自診斷 CSV，但不上傳，只當作醫師判讀結果一筆一筆手動輸入
  const answers = new Map(
    fs.readFileSync(path.join(DATA, '3-影像診斷-demo_diagnosis.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
      .map((line) => line.split(',').map((v) => v.trim()) as [string, string]),
  );
  // 研究 UID → 影像編號（工作台網址只有 UID）；待處理清單每頁 20 筆
  const accOf = new Map<string, string>();
  for (const row of await page.getByRole('table', { name: '研究清單' }).locator('tbody tr').all()) {
    const uid = await row.getAttribute('data-study');
    if (uid) accOf.set(uid, (await row.getByRole('rowheader').innerText()).trim());
  }
  note(TC, `研究數：${accOf.size}`);

  // 首頁的「繼續標註」打開第一筆待處理，之後每筆按「儲存並開啟下一筆」
  await page.getByRole('button', { name: '繼續標註', exact: true }).click();
  const uidNow = () => decodeURIComponent(/\/labeling\/studies\/([^/?#]+)/.exec(page.url())?.[1] ?? '');
  const done: string[] = [];
  for (let i = 0; i < accOf.size + 2; i++) {
    await expect(page).toHaveURL(/\/labeling\/studies\//);
    const uid = uidNow();
    if (done.includes(uid)) break;
    const acc = accOf.get(uid) ?? '';
    const label = answers.get(acc);
    expect(label, `${acc || uid} 在診斷 CSV 裡要有答案`).toBeTruthy();
    await expect(page.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
    const next = page.getByTestId('workbench-actions').getByRole('button').first();
    const saveOnly = page.getByRole('button', { name: '只儲存', exact: true });
    if (i === 0) {
      const field = page.getByRole('combobox', { name: '標籤' });
      note(TC, `步驟 3 標籤欄預設值：「${await field.inputValue()}」；主要按鈕「${(await next.innerText()).trim()}」；「只儲存」${(await saveOnly.isDisabled()) ? '不能按' : '可以按'}`);
      note(TC, `步驟 3 標註對象預設：${(await page.getByLabel('整個研究').isChecked()) ? '整個研究' : '這張影像'}`);
      await shot(page, TC, '02-工作台-標籤空白不能存');
    }
    await page.getByRole('combobox', { name: '標籤' }).fill(label!);
    if (i === 0) {
      // 第一筆先「只儲存」，看分類標在影像上，再測沒存的框離開前提醒
      await saveOnly.click();
      await expect(page.getByTestId('workbench-status')).toContainText('已儲存分類標註');
      const badges = page.getByRole('list', { name: '這張影像的分類標註' }).first();
      await expect(badges).toContainText(`整個研究：${label}`);
      note(TC, `步驟 4 存檔後影像左上角：${flat(await badges.innerText())}`);
      await shot(page, TC, '03-工作台-分類標在影像上');

      await page.getByRole('group', { name: '標註種類' }).getByRole('button', { name: '偵測' }).click();
      const box = page.getByRole('form', { name: '以座標新增框' });
      for (const [name, value] of [['x1', '10'], ['y1', '10'], ['x2', '60'], ['y2', '60']]) await box.getByLabel(name).fill(value);
      await box.getByRole('button', { name: '新增框' }).click();
      let asked = '';
      page.once('dialog', (d) => {
        asked = d.message();
        void d.dismiss();
      });
      await page.getByRole('link', { name: '← 回待處理清單' }).click();
      await expect.poll(() => asked).not.toBe('');
      await expect(page.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeVisible();
      note(TC, `步驟 5 有沒存的框時按「回待處理清單」：跳出提醒「${asked}」，按取消後留在工作台`);
      await shot(page, TC, '04-沒存的框-按取消後仍在工作台');
      await page.getByRole('button', { name: '捨棄草稿' }).first().click();
      await page.getByRole('group', { name: '標註種類' }).getByRole('button', { name: '分類' }).click();
      // 已經存過了：清空標籤，主要按鈕變成「開啟下一筆」，不會再存一筆
      await page.getByRole('combobox', { name: '標籤' }).fill('');
    }
    done.push(uid);
    // 主要按鈕：有內容時「儲存並開啟下一筆」，已存過時「開啟下一筆」
    await next.click();
    const last = status(page, '已經沒有待處理的影像了');
    await expect.poll(async () => uidNow() !== uid || (await last.isVisible()), { timeout: 30_000 }).toBe(true);
    if (await last.isVisible()) break;
  }
  note(TC, `步驟 6 以「儲存並開啟下一筆」標了 ${done.length} 筆`);
  await shot(page, TC, '05-工作台-最後一筆已無待處理');

  // 待處理清單：顯示類別與進度
  // 工作台不在「影像標註分頁」底下：用「← 回待處理清單」回去（都已存，不會跳提醒）
  await page.getByRole('link', { name: '← 回待處理清單' }).click();
  // 改版後進度卡：「已確認（共 N 個研究）」進度條＋「已確認數 / 總數」
  await expect(progress).toContainText(new RegExp(`已確認（共 ${accOf.size} 個研究）\\s*${accOf.size} / ${accOf.size}`));
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  const classes = await page.getByTestId('study-classes').allInnerTexts();
  note(TC, `步驟 6 標註後：${flat(await progress.innerText())}；類別欄 ${classes.join(' / ')}`);
  await shot(page, TC, '06-待處理清單-類別與進度');

  // 標註資料集：系統自動建立的分類標註資料集 →「用這份資料建立訓練任務」
  await clickTab(page, '標註資料集', page.getByRole('navigation', { name: '影像標註分頁' }));
  const dsTable = page.getByRole('table', { name: '標註資料集' });
  await expect(dsTable).toBeVisible();
  note(TC, `步驟 7 標註資料集：${flat(await dsTable.innerText()).slice(0, 300)}`);
  await dsTable.getByRole('link', { name: /分類標註/ }).first().click();
  await expect(page.getByTestId('dataset-summary')).toBeVisible();
  note(TC, `步驟 7 資料集摘要：${flat(await page.getByTestId('dataset-summary').innerText())}`);
  await shot(page, TC, '07-標註資料集');
  await page.getByRole('link', { name: '用這份資料建立訓練任務', exact: true }).click();

  // 建立訓練任務精靈：第 2 步已選好標註資料集 → 第 3 步確認並送出
  await expect(page.getByRole('heading', { level: 1, name: '建立訓練任務' })).toBeVisible();
  await expect(page.getByLabel('標註資料集', { exact: true })).not.toHaveValue('');
  note(TC, `步驟 8 精靈第 2 步：${flat(await page.getByRole('region', { name: /^確認資料/ }).innerText()).slice(0, 300)}`);
  await shot(page, TC, '08-建立訓練任務-確認資料');
  await page.getByRole('button', { name: '下一步：確認並送出', exact: true }).click();
  const train = page.getByRole('form', { name: '確認並送出' });
  await expect(train).toBeVisible();

  // 只留 1 種 Label 會先被擋下（進階設定的 Label）
  await train.locator('summary', { hasText: /^進階設定：影像範圍/ }).click();
  const labels = train.getByLabel('Label（以逗號分隔）', { exact: true });
  const allLabels = await labels.inputValue();
  note(TC, `步驟 9 Label（由標註資料集帶入）：${allLabels}`);
  await labels.fill('abnormal');
  await train.getByRole('button', { name: '確認並送出訓練', exact: true }).click();
  const alert = train.getByRole('alert');
  await expect(alert).toContainText('分類至少要有 2 個類別');
  note(TC, `步驟 9 只留 abnormal 送出：${flat(await alert.innerText())}`);
  await shot(page, TC, '09-只有1種Label被擋下');
  await labels.fill(allLabels);

  // 送出：直接進入單次訓練頁
  await train.getByRole('button', { name: '確認並送出訓練', exact: true }).click();
  await expect(page).toHaveURL(/\/training\/runs\/\d+$/, { timeout: 60_000 });
  const runId = /\/training\/runs\/(\d+)/.exec(page.url())![1];
  note(TC, `步驟 10 已送出訓練 #${runId}：${flat(await page.getByTestId('run-status').innerText())}`);
  await shot(page, TC, '10-單次訓練頁-已送出');

  // 單次訓練頁會自動更新狀態
  const runStatus = page.getByTestId('run-status');
  await expect(runStatus).toHaveText(/目前狀態：(已完成|失敗|已取消)/, { timeout: 30 * 60_000 });
  const final = flat(await runStatus.innerText());
  note(TC, `步驟 11 訓練 #${runId}：${final}`);
  await page.waitForTimeout(1500);
  const verdict = page.getByTestId('verdict');
  if (await verdict.count()) note(TC, `步驟 11 訓練結果：${flat(await verdict.first().innerText())}`);
  await shot(page, TC, '11-單次訓練頁-訓練完成');
  expect(final).toContain('已完成');
});
