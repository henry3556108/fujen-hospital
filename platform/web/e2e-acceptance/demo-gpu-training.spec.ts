import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EVIDENCE_DIR, clickMenu, note, shot, useProject } from './helpers';
import { adminTab, q, sh, userPage, waitIdle } from './ops';

// 一條龍演示（Desktop\workspace\Demo腳本\一條龍演示腳本.md）第 2、4、5 段的預演：影像訓練真的在 GPU 上跑。
// 前提：共享池節點 ai-platform-worker4 接真 GPU（platform/deploy/kind/gpu-node.sh），專案綁共享池群組 gpu-shared。
//   EVIDENCE_DIR=<存證資料夾> DEMO_DATA=<演示資料資料夾> npx playwright test -c playwright.acceptance.config.ts demo-gpu-training --headed
// 會建立專案 DEMO-一條龍（已存在就沿用）並把 pi01 加為 Principal Investigator；資料、訓練、分享都留在專案內供演示使用。
// 訓練期間每秒記錄主機 nvidia-smi 到 <存證>/<案例>/nvidia-smi.csv。

const PROJECT = 'DEMO-一條龍';
const DATA = process.env.DEMO_DATA || '/mnt/c/Users/skyland/Desktop/workspace/Demo腳本/演示資料';
const RESIZE = process.env.DEMO_RESIZE || '224';
const EPOCHS = process.env.DEMO_EPOCHS || '50';
const SETTING = process.env.DEMO_SETTING || 'DEMO 影像分類';
const TC = '一條龍GPU訓練';
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

test('準備：admin01 建立 DEMO-一條龍（共享池 gpu-shared）並加入 pi01', async ({ browser }) => {
  const { ctx, page } = await userPage(browser, 'admin01');
  await adminTab(page, '專案');
  await page.waitForLoadState('networkidle');
  const exists = await page.getByRole('table', { name: '專案列表' }).getByRole('rowheader', { name: PROJECT, exact: true }).count();
  if (!exists) {
    const form = page.getByRole('form', { name: '新增專案' });
    await form.getByLabel('專案名稱（必填）').fill(PROJECT);
    await form.getByLabel('說明').fill('一條龍演示：影像訓練在共享池真 GPU 上執行');
    const group = form.getByLabel('GPU 群組');
    const option = (await group.locator('option').allInnerTexts()).find((t) => t.startsWith('gpu-shared'));
    expect(option, 'GPU 群組選單要有 gpu-shared').toBeTruthy();
    await group.selectOption({ label: option! });
    await form.getByRole('button', { name: '新增專案' }).click();
    await expect(status(page, `已新增專案「${PROJECT}」`)).toBeVisible();
    note(TC, `已新增專案 ${PROJECT}，GPU 群組 ${option}`);
  } else {
    note(TC, `專案 ${PROJECT} 已存在，沿用`);
  }
  await shot(page, TC, '00-專案');
  await adminTab(page, '專案成員');
  await page.locator('#member-project').selectOption({ label: PROJECT });
  await page.waitForLoadState('networkidle');
  if (!(await page.getByRole('table', { name: '目前的專案成員' }).getByText('pi01').count())) {
    const f = page.getByRole('form', { name: '設定專案成員' });
    await f.getByLabel('帳號').selectOption({ label: 'pi01' });
    await f.getByLabel('角色').selectOption({ label: 'Principal Investigator' });
    await f.getByRole('button', { name: '加入專案' }).click();
    await expect(status(page, '已將「pi01」設定為')).toBeVisible();
  }
  note(TC, `專案成員：${(await page.getByRole('table', { name: '目前的專案成員' }).innerText()).replace(/\s+/g, ' ')}`);
  await shot(page, TC, '01-專案成員');
  await ctx.close();
});

test('演示 2、4、5 段：匯入、標註、GPU 訓練、預測、分享', async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  const pi = await userPage(browser, 'pi01');
  const admin = await userPage(browser, 'admin01');
  const page = pi.page;
  await waitIdle(page, 600);
  await useProject(page, PROJECT);

  // 2 匯入資料：影像（整個資料夾）
  await clickMenu(page, '數據管理');
  await page.getByRole('list', { name: '資料種類' }).getByRole('link', { name: /^醫療影像/ }).click();
  await page.getByRole('navigation', { name: '醫療影像分頁' }).getByRole('link', { name: '匯入影像' }).click();
  const dicom = page.getByRole('form', { name: 'DICOM' });
  await dicom.getByRole('checkbox', { name: '選擇整個資料夾（保留資料夾路徑）' }).check();
  await dicom.locator('input[type=file]').setInputFiles(path.join(DATA, '1-影像'));
  note(TC, `選擇資料夾：${await dicom.getByRole('status').innerText()}`);
  await dicom.getByRole('button', { name: '上傳DICOM' }).click();
  const imported = dicom.getByRole('region', { name: 'DICOM 匯入結果' });
  await expect(imported).toContainText(/匯入 \d+、重複 \d+、失敗 \d+/, { timeout: 5 * 60_000 });
  note(TC, `影像匯入結果：${(await imported.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
  await shot(page, TC, '10-影像匯入結果');
  await dicom.getByRole('link', { name: '到研究列表查看' }).click();
  await expect(page.getByText(/^共 \d+ 個研究/)).toBeVisible();
  note(TC, `研究列表：${await page.getByText(/^共 \d+ 個研究/).innerText()}`);
  await shot(page, TC, '11-研究列表');

  // 2 匯入資料：病人資料 CSV
  await page.getByRole('navigation', { name: '數據管理分頁' }).getByRole('link', { name: /^結構式資料/ }).click();
  const csv = page.getByRole('form', { name: '上傳 CSV' });
  await csv.getByLabel(/^CSV 檔案/).setInputFiles(path.join(DATA, '2-病人資料-cohort_01.csv'));
  await csv.getByLabel('資料集名稱').fill('cohort_01');
  await csv.getByRole('button', { name: '上傳並驗證' }).click();
  const csvResult = page.getByRole('region', { name: '「cohort_01」的上傳結果' });
  await expect(csvResult).toBeVisible({ timeout: 60_000 });
  note(TC, `病人資料：${(await csvResult.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
  await shot(page, TC, '12-病人資料上傳結果');

  // 4 標註：以 CSV 診斷結果自動分類標註（影像編號）
  await clickMenu(page, '影像標註');
  const auto = page.getByRole('form', { name: 'CSV 自動分類標註' });
  await auto.getByLabel(/^CSV 檔/).setInputFiles(path.join(DATA, '3-影像診斷-demo_diagnosis.csv'));
  await auto.getByLabel('對齊依據').selectOption({ label: '影像編號（Accession Number）' });
  await auto.getByRole('button', { name: '上傳並標註' }).click();
  await expect(page.getByTestId('csv-result')).toBeVisible({ timeout: 60_000 });
  note(TC, `CSV 標註：${(await page.getByTestId('csv-result').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  await shot(page, TC, '20-CSV自動分類標註');

  // 4 開始監看 GPU：主機 nvidia-smi 每秒一行；admin01 開 GPU Dashboard
  const dir = path.join(EVIDENCE_DIR, TC);
  fs.mkdirSync(dir, { recursive: true });
  const smiOut = fs.openSync(path.join(dir, 'nvidia-smi.csv'), 'w');
  const smi: ChildProcess = spawn('nvidia-smi', ['--query-gpu=timestamp,index,utilization.gpu,memory.used', '--format=csv', '-l', '1'],
    { stdio: ['ignore', smiOut, smiOut] });
  try {
    await admin.page.goto('/admin/scheduling/gpu-dashboard');
    await expect(admin.page.getByRole('heading', { level: 1, name: 'GPU Dashboard' })).toBeVisible();
    await shot(admin.page, TC, '30-GPU Dashboard訓練前');

    // 4 送出訓練
    await clickMenu(page, '建模管理');
    await page.getByRole('button', { name: '新增訓練設定' }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await form.getByLabel('設定名稱').fill(SETTING);
    await form.getByLabel('訓練種類').selectOption({ label: '影像分類' });
    await form.getByRole('radio', { name: '全部研究' }).check();
    await form.getByLabel('標註來源').selectOption({ label: '影像標註平台（本專案的標註）' });
    await form.getByLabel('Resize 高（像素）').fill(RESIZE);
    await form.getByLabel('Resize 寬（像素）').fill(RESIZE);
    await form.getByLabel('訓練回合數').fill(EPOCHS);
    await shot(page, TC, '31-訓練設定');
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText(`已新增訓練設定「${SETTING}」。`)).toBeVisible();
    await page.getByRole('button', { name: `送出訓練「${SETTING}」` }).first().click();
    const sent = page.getByText(new RegExp(`已送出訓練 #(\\d+)（${SETTING}）`));
    await expect(sent).toBeVisible();
    const runId = Number(/#(\d+)/.exec(await sent.innerText())![1]);
    const submitted = Date.now();
    note(TC, `已送出訓練 #${runId}（Resize ${RESIZE}、訓練回合數 ${EPOCHS}）`);
    await shot(page, TC, '32-已送出訓練');

    // 訓練中：Dashboard 出現 DEMO-一條龍／pi01 的工作；記下 Pod 與節點
    const sel = `platform/training-id=${runId}`;
    let dashboardShot = false;
    let podInfo = '';
    for (let i = 0; i < 360 && !dashboardShot; i++) {
      // 不重新載入：Dashboard 每 5 秒自動更新；重新載入後表格是非同步載入，立刻檢查會讀到空表
      const running = admin.page.getByRole('table', { name: '執行中的 GPU 工作' });
      if (await running.getByText(PROJECT).count()) {
        await admin.page.waitForTimeout(3000);
        await shot(admin.page, TC, '33-GPU Dashboard訓練中');
        note(TC, `GPU Dashboard 執行中：${(await running.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
        note(TC, `GPU Dashboard 卡片：${(await admin.page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
        dashboardShot = true;
      } else {
        await admin.page.waitForTimeout(2000);
      }
      podInfo = q(`kubectl -n platform-jobs get pods -l ${sel} -o wide --no-headers`);
      if (/Completed|Error|OOMKilled/.test(podInfo) && !dashboardShot) break;
    }
    note(TC, `訓練 Pod：${podInfo}`);
    await shot(page, TC, '34-訓練中');

    // 等訓練結束
    const runStatus = page.getByTestId('run-status');
    await expect(async () => {
      expect(await runStatus.first().innerText()).toMatch(/已完成|失敗/);
    }).toPass({ timeout: 45 * 60_000, intervals: [5000] });
    const elapsed = Math.round((Date.now() - submitted) / 1000);
    note(TC, `訓練狀態：${(await runStatus.first().innerText()).replace(/\s+/g, ' ')}；送出到畫面顯示結束 ${elapsed} 秒`);
    sh(TC, 'trainer-job', `kubectl -n platform-jobs get job,pod -l ${sel} -o wide; kubectl -n platform-jobs get job -l ${sel} -o jsonpath='{range .items[*]}Job {.metadata.name} 開始 {.status.startTime} 完成 {.status.completionTime}{"\\n"}{end}'; kubectl -n platform-jobs get pod -l ${sel} -o jsonpath='{range .items[*]}Pod {.metadata.name} 節點 {.spec.nodeName} 映像 {.spec.containers[0].image} limits {.spec.containers[0].resources.limits} 結束原因 {.status.containerStatuses[0].state.terminated.reason}{"\\n"}{end}'`);
    sh(TC, 'trainer-log', `kubectl -n platform-jobs logs -l ${sel} --tail=-1`);
  } finally {
    smi.kill();
    fs.closeSync(smiOut);
  }
  await admin.page.reload();
  await shot(admin.page, TC, '35-GPU Dashboard訓練後');

  // 訓練結果
  await page.reload();
  const expand = page.getByRole('button', { name: /^展開訓練 #\d+$/ }).first();
  await expand.click();
  await page.waitForTimeout(1500);
  await shot(page, TC, '40-訓練結果');
  const verdict = page.getByTestId('verdict');
  if (await verdict.count()) note(TC, `訓練結果：${(await verdict.first().innerText()).replace(/\s+/g, ' ')}`);

  // 5 用這個模型預測病人 → 多張影像一起預測
  await page.getByRole('link', { name: '用這個模型預測病人' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: '推論服務管理' })).toBeVisible();
  const many = page.getByRole('form', { name: '多張影像一起預測' });
  await many.getByRole('button', { name: '多張影像一起預測' }).click();
  const done = page.getByRole('heading', { name: /^預測結果 #\d+/ });
  await expect(done.first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('batch-status')).toHaveCount(0, { timeout: 20 * 60_000 });
  await page.waitForTimeout(2000);
  note(TC, `多張影像預測：${(await done.first().innerText()).trim()}；結果卡 ${await page.getByTestId('image-result').count()} 張`);
  sh(TC, 'batch-inference-job', `kubectl -n platform-jobs get jobs,pods -o wide --sort-by=.metadata.creationTimestamp | tail -4`);
  await shot(page, TC, '50-多張影像預測結果');

  // 5 分享給同事使用（md01）
  await clickMenu(page, '建模管理');
  await page.getByRole('button', { name: /^展開訓練 #\d+$/ }).first().click();
  await page.getByRole('link', { name: '分享給同事使用' }).first().click();
  const share = page.getByRole('form', { name: '分享給同事使用' });
  await share.getByLabel('分享給（同事的帳號，以逗號分隔）').fill('md01');
  await share.getByRole('button', { name: '分享給同事使用' }).click();
  const shared = page.getByText(/^已把「.+」分享給 md01/);
  await expect(shared).toBeVisible();
  note(TC, `分享訊息：${(await shared.innerText()).trim()}`);
  const table = page.getByRole('table', { name: '已分享的模型' });
  note(TC, `已分享的模型：${(await table.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  await shot(page, TC, '60-分享給同事');
  await page.mouse.wheel(0, 2000);
  await shot(page, TC, '61-呼叫範例');
  await pi.ctx.close();
  await admin.ctx.close();
});
