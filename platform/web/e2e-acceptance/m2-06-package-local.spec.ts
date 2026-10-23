import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { note, shot } from './helpers';
import { sh } from './ops';
import {
  Checks, PA, SETTING, begin, diffRows, dirOf, download, flat, gotoTraining, latestUiRun, localMetricRows, openFlow, openAs,
  stageStates, statesText, step, uiMetrics, unzip, zipList, zipRead,
} from './m2-common';

// M2驗證\06-專案包匯出與地端重做.md（F-09 專案包匯出、金鑰掃描命中 0；F-10 平台外重做，指標與平台差異 0）。
// 地端重做：Windows PowerShell 以 py -m venv 建環境（這台只有 Python 3.13）；套件裝不起來或執行失敗時改在 WSL 用 uv 建 Python 3.12 重做。
const TC = '06';
const LOG = '06-地端執行';
const PS = process.env.M2_POWERSHELL || '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

// 只用 ASCII（在解開的資料夾內執行，不必把中文路徑當參數傳給 Windows）
const PS1 = [
  "$ErrorActionPreference = 'Continue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$env:PYTHONUTF8 = '1'",
  "$env:PYTHONIOENCODING = 'utf-8'",
  "$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'",
  "Write-Output ('PS> cd ' + (Get-Location).Path)",
  "Write-Output 'PS> py --list'",
  'py --list 2>&1 | ForEach-Object { "$_" }',
  "Write-Output 'PS> py -m venv .venv'",
  'py -m venv .venv 2>&1 | ForEach-Object { "$_" }',
  '$c = $LASTEXITCODE; Write-Output "EXIT $c"; if ($c -ne 0) { exit 11 }',
  "Write-Output 'PS> .venv\\Scripts\\python --version'",
  '& .\\.venv\\Scripts\\python.exe --version 2>&1 | ForEach-Object { "$_" }',
  "Write-Output 'PS> .venv\\Scripts\\pip install -r requirements.txt'",
  '& .\\.venv\\Scripts\\pip.exe install -r requirements.txt 2>&1 | ForEach-Object { "$_" }',
  '$c = $LASTEXITCODE; Write-Output "EXIT $c"; if ($c -ne 0) { exit 12 }',
  "Write-Output 'PS> .venv\\Scripts\\python run_all.py --data dataset --out out'",
  '& .\\.venv\\Scripts\\python.exe run_all.py --data dataset --out out 2>&1 | ForEach-Object { "$_" }',
  '$c = $LASTEXITCODE; Write-Output "EXIT $c"; if ($c -ne 0) { exit 13 }',
  'exit 0',
].join('\r\n');

test.use({ actionTimeout: 30_000 });

test('M2 06 專案包匯出與地端重做', async ({ browser }) => {
  test.setTimeout(90 * 60_000);
  begin(TC, 'M2 06 專案包匯出與地端重做');
  const c = new Checks(TC);
  const out = dirOf(TC);
  const { ctx, page } = await openAs(browser, 'pi01', PA);
  await gotoTraining(page);
  const panel = await openFlow(page, SETTING);
  note(TC, `五環節：${statesText(await stageStates(panel))}`);

  // 1 勾選附上原始資料
  step(TC, 1, '「整個流程（專案包）」勾「附上原始資料」');
  const box = panel.getByRole('checkbox', { name: /^附上原始資料/ });
  await box.scrollIntoViewIfNeeded();
  await box.check();
  const dlg = page.getByRole('dialog');
  if (await dlg.isVisible()) {
    note(TC, `確認視窗：${flat(await dlg.innerText())}`);
    await dlg.getByRole('button').last().click();
  } else {
    c.diff('勾選「附上原始資料」不會出現確認視窗，勾選後直接生效（說明文字寫在勾選框旁）');
  }
  note(TC, `勾選框文字：${flat(await box.locator('xpath=..').innerText())}`);
  await shot(page, TC, '01-勾選附上原始資料');
  c.check('步驟 1 已勾選「附上原始資料」', await box.isChecked());

  // 2 下載附資料
  step(TC, 2, '按「下載整個流程（專案包）」，存成 06\\專案包-附資料.zip');
  const pkgButton = panel.getByRole('button', { name: '下載整個流程（專案包）', exact: true });
  const withData = await download(page, () => pkgButton.click(), out, '專案包-附資料.zip');
  const alert1 = panel.getByRole('alert');
  const scanErr1 = (await alert1.count()) ? flat(await alert1.first().innerText()) : '';
  note(TC, `下載 ${withData.suggested} → ${withData.file}（${fs.statSync(withData.file).size} bytes）${scanErr1 ? `；紅框：${scanErr1}` : ''}`);
  await shot(page, TC, '02-下載完成');
  c.check('步驟 2 附資料的專案包下載成功、沒有金鑰掃描錯誤', fs.statSync(withData.file).size > 0 && !scanErr1);

  // 3 不附資料
  step(TC, 3, '不勾「附上原始資料」再下載一次，存成 專案包-不附資料.zip');
  await box.uncheck();
  const noData = await download(page, () => pkgButton.click(), out, '專案包-不附資料.zip');
  const scanErr2 = (await panel.getByRole('alert').count()) ? flat(await panel.getByRole('alert').first().innerText()) : '';
  note(TC, `下載 ${noData.suggested} → ${noData.file}（${fs.statSync(noData.file).size} bytes）${scanErr2 ? `；紅框：${scanErr2}` : ''}`);
  c.check('步驟 3 不附資料的專案包下載成功、沒有金鑰掃描錯誤', fs.statSync(noData.file).size > 0 && !scanErr2);

  // 4 檔案清單
  step(TC, 4, '解開附資料的 zip，列出檔案；附的 CSV 只有用到的欄位');
  const names = zipList(withData.file);
  const work = dirOf(TC, '專案包-附資料');
  unzip(withData.file, work);
  const top = [...new Set(names.map((n) => (n.includes('/') ? `${n.split('/')[0]}/` : n)))].sort();
  const stagesDirs = [...new Set(names.filter((n) => n.startsWith('stages/')).map((n) => n.split('/')[1]))].sort();
  const manifest = JSON.parse(zipRead(withData.file, 'dataset/manifest.json')) as { items?: { files?: { csv?: { blob?: string } } }[] };
  const blob = manifest.items?.[0]?.files?.csv?.blob;
  const header = blob ? zipRead(withData.file, `dataset/blobs/${blob}`).split('\n')[0].trim() : '';
  const cols = header ? header.split(',') : [];
  const noDataNames = zipList(noData.file);
  const listing = [
    `專案包-附資料.zip（${names.length} 個檔案）`, ...names.map((n) => `  ${n}`), '',
    `最上層：${top.join('、')}`, `stages\\ 環節資料夾：${stagesDirs.join('、')}`,
    `附的 CSV（dataset/blobs/${blob ?? '—'}）欄位：${header || '（找不到）'}`, '',
    `專案包-不附資料.zip（${noDataNames.length} 個檔案）`, ...noDataNames.map((n) => `  ${n}`), '',
  ].join('\n');
  fs.writeFileSync(path.join(out, '06-檔案清單.txt'), listing);
  note(TC, `最上層：${top.join('、')}；環節資料夾：${stagesDirs.join('、')}；CSV 欄位：${header}`);
  const need = ['flow.json', 'README.md', 'requirements.txt', 'run_all.py', 'stages/', 'dataset/'];
  c.check('步驟 4 有 flow.json、README.md、requirements.txt、run_all.py、stages\\、dataset\\', need.every((n) => top.includes(n)), top.join('、'));
  c.check('步驟 4 stages\\ 有五個環節資料夾', ['deploy', 'import', 'labels', 'preprocess', 'train'].every((s) => stagesDirs.includes(s)), stagesDirs.join('、'));
  c.check('步驟 4 附的 CSV 沒有 patient_id、study_accession', cols.length > 0 && !cols.includes('patient_id') && !cols.includes('study_accession'), header);
  c.check('步驟 4 不附資料的專案包沒有原始資料（dataset/blobs）', !noDataNames.some((n) => n.startsWith('dataset/blobs/')));

  // 5 地端重做
  step(TC, 5, 'Windows PowerShell：py -m venv .venv、.venv\\Scripts\\pip install -r requirements.txt、.venv\\Scripts\\python run_all.py --data dataset --out out');
  fs.writeFileSync(path.join(work, 'run-local-windows.ps1'), `﻿${PS1}\r\n`);
  const win = sh(TC, LOG, `'${PS}' -NoProfile -ExecutionPolicy Bypass -File run-local-windows.ps1`, work);
  let outDir = path.join(work, 'out');
  let where = 'Windows（Python 3.13）';
  if (win.code !== 0) {
    const reasons: Record<number, string> = { 11: '建立 venv 失敗', 12: 'pip install -r requirements.txt 失敗（套件版本裝不起來）', 13: 'run_all.py 執行失敗' };
    const reason = reasons[win.code] ?? `PowerShell 結束碼 ${win.code}`;
    const tail = win.out.trim().split('\n').slice(-8).join(' ／ ');
    note(TC, `Windows 重做失敗：${reason}；最後輸出：${flat(tail).slice(0, 600)}`);
    note(TC, '改在 WSL 用 Python 3.12（uv）重做');
    sh(TC, LOG, 'uv --version && uv venv -p 3.12 .venv-wsl312', work);
    sh(TC, LOG, 'uv pip install --python .venv-wsl312/bin/python -r requirements.txt', work);
    const wsl = sh(TC, LOG, '.venv-wsl312/bin/python --version && .venv-wsl312/bin/python run_all.py --data dataset --out out-wsl', work);
    outDir = path.join(work, 'out-wsl');
    where = `WSL（Python 3.12，uv）；改用原因：Windows ${reason}`;
    c.check('步驟 5 WSL 重做執行成功', wsl.code === 0, `結束碼 ${wsl.code}`);
  } else {
    c.check('步驟 5 Windows 重做執行成功', true);
  }
  const produced = ['model.pkl', 'metrics.json', 'model_card.json'].map((f) => `${f} ${fs.existsSync(path.join(outDir, f)) ? '有' : '無'}`);
  note(TC, `地端重做在 ${where}；產出 ${path.basename(outDir)}\\：${produced.join('、')}`);
  c.check('步驟 5 產出 model.pkl、metrics.json、model_card.json', produced.every((p) => p.endsWith('有')), produced.join('、'));

  // 6 指標比對
  step(TC, 6, '打開 out\\metrics.json，和平台上這份設定（介面設定版本）最近一次訓練的指標比對');
  c.diff('「這份設定最近一次訓練」是 01 用匯入程式（n_estimators 7）跑的那筆；專案包是 03 改回後的介面設定，所以比對對象是介面設定版本最近一次完成的訓練（與 07 相同）');
  const runId = await latestUiRun(page, SETTING);
  const lines: string[] = [`平台：${PA}「${SETTING}」介面設定版本最近一次完成的訓練 #${runId ?? '—'}`, `地端：${where}，${path.join(outDir, 'metrics.json')}`, ''];
  let same = false;
  if (runId !== null && fs.existsSync(path.join(outDir, 'metrics.json'))) {
    const ui = await uiMetrics(page, runId);
    await shot(page, TC, '06-單次訓練頁-平台指標');
    const raw = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8')) as Record<string, unknown>;
    const local = localMetricRows(raw);
    const d1 = diffRows(ui.rows, local.rows);
    const d2 = diffRows(ui.cv, local.cv);
    same = ui.rows.length > 0 && d1.length === 0 && d2.length === 0;
    lines.push('【所有指標】平台｜地端', ...ui.rows.map((r, i) => `${r}　｜　${local.rows[i] ?? '（無）'}`), '');
    lines.push('【K 折】平台｜地端', ...ui.cv.map((r, i) => `${r}　｜　${local.cv[i] ?? '（無）'}`), '');
    lines.push(`差異：${[...d1, ...d2].join('；') || '0 項'}`, '', '地端 metrics.json 原始內容：', JSON.stringify(raw, null, 2));
    note(TC, `平台重點指標：${ui.cards}`);
  } else {
    lines.push('無法比對：找不到平台的訓練或地端的 metrics.json');
  }
  fs.writeFileSync(path.join(out, '06-指標比對.txt'), `${lines.join('\n')}\n`);
  c.check('步驟 6 指標數字與平台相同（F-10，差異 0）', same, `見 06-指標比對.txt`);
  await ctx.close();
  c.finish();
});
