import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clickMenu, note, shot, useProject } from './helpers';
import { adminTab, userPage, waitIdle } from './ops';

// 不用診斷 CSV，在工作台一筆一筆手動做分類標註，再從「標註後直接訓練」送出，確認訓練完成。
// 同時存證標註易用性的修正：分類標在影像左上角、研究清單顯示類別與進度、標籤不預填、
// 分類預設整個研究、沒存的草稿離開前提醒、只選 1 種 Label 時先擋下。
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
  await adminTab(page, '專案成員');
  await page.locator('#member-project').selectOption({ label: PROJECT });
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

  // 匯入影像
  await clickMenu(page, '數據管理');
  await page.getByRole('list', { name: '資料種類' }).getByRole('link', { name: /^醫療影像/ }).click();
  await page.getByRole('navigation', { name: '醫療影像分頁' }).getByRole('link', { name: '匯入影像' }).click();
  const dicom = page.getByRole('form', { name: 'DICOM' });
  await dicom.getByRole('checkbox', { name: '選擇整個資料夾（保留資料夾路徑）' }).check();
  await dicom.locator('input[type=file]').setInputFiles(path.join(DATA, '1-影像'));
  await dicom.getByRole('button', { name: '上傳DICOM' }).click();
  const imported = dicom.getByRole('region', { name: 'DICOM 匯入結果' });
  await expect(imported).toContainText(/匯入 \d+、重複 \d+、失敗 \d+/, { timeout: 5 * 60_000 });
  note(TC, `步驟 1 影像匯入：${flat(await imported.innerText()).slice(0, 120)}`);

  // 研究清單：還沒標註
  await clickMenu(page, '影像標註');
  const progress = page.getByTestId('label-progress');
  await expect(progress).toBeVisible();
  note(TC, `步驟 2 標註前：${flat(await progress.innerText())}`);
  await shot(page, TC, '01-研究清單-標註前');

  // 正確答案取自診斷 CSV，但不上傳，只當作醫師判讀結果一筆一筆手動輸入
  const answers = new Map(
    fs.readFileSync(path.join(DATA, '3-影像診斷-demo_diagnosis.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
      .map((line) => line.split(',').map((v) => v.trim()) as [string, string]),
  );
  const rows = page.getByRole('table', { name: '研究清單' }).getByRole('row');
  const studies: { acc: string; href: string }[] = [];
  for (const row of await rows.all()) {
    const link = row.getByRole('link', { name: /^開啟 .* 的標註工作台$/ });
    if (!(await link.count())) continue;
    studies.push({ acc: (await row.getByRole('rowheader').innerText()).trim(), href: (await link.getAttribute('href'))! });
  }
  note(TC, `研究數：${studies.length}`);

  for (const [i, s] of studies.entries()) {
    const label = answers.get(s.acc);
    expect(label, `${s.acc} 在診斷 CSV 裡要有答案`).toBeTruthy();
    await page.goto(s.href);
    await expect(page.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
    const save = page.getByRole('button', { name: '儲存分類標註' });
    if (i === 0) {
      const field = page.getByRole('combobox', { name: '標籤' });
      note(TC, `步驟 3 標籤欄預設值：「${await field.inputValue()}」；儲存按鈕${(await save.isDisabled()) ? '不能按' : '可以按'}`);
      note(TC, `步驟 3 標註對象預設：${(await page.getByLabel('整個研究').isChecked()) ? '整個研究' : '這張影像'}`);
      await shot(page, TC, '02-工作台-標籤空白不能存');
    }
    await page.getByRole('combobox', { name: '標籤' }).fill(label!);
    await save.click();
    await expect(page.getByTestId('workbench-status')).toContainText(`已儲存分類標註`);
    const badges = page.getByRole('list', { name: '這張影像的分類標註' }).first();
    await expect(badges).toContainText(`整個研究：${label}`);
    if (i === 0) {
      note(TC, `步驟 4 存檔後影像左上角：${flat(await badges.innerText())}`);
      await shot(page, TC, '03-工作台-分類標在影像上');

      // 沒存的框：離開前提醒
      await page.getByRole('group', { name: '標註種類' }).getByRole('button', { name: '偵測' }).click();
      const box = page.getByRole('form', { name: '以座標新增框' });
      for (const [name, value] of [['x1', '10'], ['y1', '10'], ['x2', '60'], ['y2', '60']]) await box.getByLabel(name).fill(value);
      await box.getByRole('button', { name: '新增框' }).click();
      let asked = '';
      page.once('dialog', (d) => {
        asked = d.message();
        void d.dismiss();
      });
      await page.getByRole('link', { name: '← 回研究清單' }).click();
      await expect.poll(() => asked).not.toBe('');
      await expect(page.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeVisible();
      note(TC, `步驟 5 有沒存的框時按「回研究清單」：跳出提醒「${asked}」，按取消後留在工作台`);
      await shot(page, TC, '04-沒存的框-按取消後仍在工作台');
      await page.getByRole('button', { name: '捨棄草稿' }).click();
    }
  }

  // 研究清單：顯示類別與進度
  await page.goto('/labeling');
  await expect(progress).toContainText(`已標註 ${studies.length}／共 ${studies.length} 個研究`);
  const classes = await page.getByTestId('study-classes').allInnerTexts();
  note(TC, `步驟 6 標註後：${flat(await progress.innerText())}；分類欄 ${classes.join(' / ')}`);
  await shot(page, TC, '05-研究清單-類別與進度');

  // 只勾 1 種 Label 會先被擋下
  const train = page.getByRole('form', { name: '建立訓練任務' });
  await train.scrollIntoViewIfNeeded();
  note(TC, `步驟 7 Label 選項：${flat(await train.getByRole('group', { name: 'Label' }).innerText())}`);
  await train.getByLabel(/^normal/).uncheck();
  await train.getByRole('button', { name: '建立訓練任務' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('影像分類至少要 2 種 Label');
  note(TC, `步驟 7 只勾 abnormal 送出：${flat(await alert.innerText())}`);
  await shot(page, TC, '06-只勾1種Label被擋下');
  await train.getByLabel(/^normal/).check();

  // 送出訓練
  await train.getByRole('button', { name: '建立訓練任務' }).click();
  const jobs = page.getByRole('table', { name: '已建立的訓練任務' });
  await expect(jobs).toBeVisible({ timeout: 60_000 });
  note(TC, `步驟 8 已送出：${flat(await jobs.innerText())}`);
  await shot(page, TC, '07-已送出訓練');

  const runId = /#(\d+)/.exec(await jobs.innerText())![1];
  await clickMenu(page, '建模管理');
  // 訓練紀錄表：那一列有「展開訓練 #N」按鈕與狀態欄
  const runRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: `展開訓練 #${runId}`, exact: true }) });
  await expect(async () => {
    await page.reload();
    expect(await runRow.innerText({ timeout: 10_000 })).toMatch(/已完成|失敗/);
  }).toPass({ timeout: 30 * 60_000, intervals: [5000] });
  const final = flat(await runRow.innerText());
  note(TC, `步驟 9 訓練 #${runId}：${final}`);
  await runRow.getByRole('button', { name: `展開訓練 #${runId}`, exact: true }).click();
  await page.waitForTimeout(1500);
  const verdict = page.getByTestId('verdict');
  if (await verdict.count()) note(TC, `步驟 9 訓練結果：${flat(await verdict.first().innerText())}`);
  await shot(page, TC, '08-訓練完成');
  expect(final).toContain('已完成');
});
