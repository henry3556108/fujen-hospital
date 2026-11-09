import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type Locator, type Page } from '@playwright/test';
import { EVIDENCE_DIR, P1, note, shot, useProject } from './helpers';

// M1 補拍 11：首屏載入時間（TC-A02-09）。由程式量測：每頁先開一次（不算），再重新整理 3 次，
// 從按下重新整理到「首屏完成」元素出現計時；同時記 DOMContentLoaded、Load、最後一個 /api/ 請求結束時間。
// 以 Windows 上的瀏覽器執行（CDP_URL、BROWSER_LABEL，同 r10）。
const TC = 'TC-A02-09';
const CDP = process.env.CDP_URL || '';
const LABEL = process.env.BROWSER_LABEL || 'Chrome';
const BASE = process.env.WEB_URL || 'http://localhost:38982';

const firstRow = (page: Page, table: string) =>
  page.locator(`table[aria-label="${table}"] tbody tr`).filter({ hasNotText: '載入中' }).first();

type Timing = { first: number; dcl: number; load: number; api: number };

async function navTiming(page: Page, since: number) {
  return page.evaluate((t0) => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const api = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((r) => r.name.includes('/api/'));
    const lastApi = api.length ? Math.max(...api.map((r) => r.responseEnd)) : 0;
    void t0;
    return { dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, api: lastApi };
  }, since);
}

const fmt = (ms: number) => (ms / 1000).toFixed(2);

test('M1 補拍 11 首屏載入時間（TC-A02-09）', async () => {
  test.skip(!CDP, '需要 CDP_URL（Windows 上開啟的瀏覽器）');
  test.setTimeout(15 * 60_000);
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.bringToFront();
  const lines: string[] = ['頁面｜網址｜首屏完成的判斷｜第 1 次｜第 2 次｜第 3 次｜平均｜最大｜判定｜DOMContentLoaded（3 次）｜Load（3 次）｜最後 /api/ 結束（3 次）'];
  const results: { name: string; avg: number; max: number; api: boolean }[] = [];

  const measure = async (i: number, name: string, url: string, ready: () => Locator, judge: string, file: string) => {
    if (url) await page.goto(`${BASE}${url}`);
    await ready().waitFor({ state: 'visible', timeout: 30_000 }); // 第一次載入不算
    await page.waitForLoadState('networkidle');
    const runs: Timing[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = Date.now();
      await page.reload({ waitUntil: 'commit' });
      await ready().waitFor({ state: 'visible', timeout: 30_000 });
      const first = Date.now() - t0;
      await page.waitForLoadState('networkidle');
      const t = await navTiming(page, t0);
      runs.push({ first, dcl: t.dcl, load: t.load, api: t.api });
      await page.waitForTimeout(500);
    }
    await shot(page, TC, `${String(i).padStart(2, '0')}-${file}`);
    const v = runs.map((r) => r.first);
    const avg = v.reduce((a, b) => a + b, 0) / 3;
    const max = Math.max(...v);
    const pass = avg <= 5000 && max <= 10000;
    results.push({ name, avg, max, api: false });
    lines.push(
      `${name}｜${url || page.url().replace(BASE, '')}｜${judge}｜${v.map(fmt).join('｜')}｜${fmt(avg)}｜${fmt(max)}｜${pass ? '通過' : '不通過'}（≤5／≤10 秒）｜${runs.map((r) => fmt(r.dcl)).join('、')}｜${runs.map((r) => fmt(r.load)).join('、')}｜${runs.map((r) => fmt(r.api)).join('、')}`,
    );
    note(TC, `${name}：${v.map(fmt).join('、')} 秒，平均 ${fmt(avg)}、最大 ${fmt(max)}`);
  };

  // 1 登入頁（未登入）
  await page.goto(`${BASE}/login`);
  await measure(1, '登入', '/login', () => page.getByRole('button', { name: '登入' }), '「登入」按鈕出現', '登入');
  await page.getByRole('button', { name: '登入' }).click();
  await page.locator('#username').fill('admin01');
  await page.locator('#password').fill('Admin01-dev!');
  await page.locator('#kc-login').click();
  await expect(page.locator('.topbar__username')).toHaveText('admin01', { timeout: 15_000 });
  await useProject(page, P1); // Admin 登入後在管理區，從「選擇專案」進 P1

  await measure(2, '專案清單', '/admin/projects', () => firstRow(page, '專案列表'), '列表第一列出現', '專案清單');
  await measure(3, '資料清單（影像）', '/data/imaging', () => firstRow(page, '影像清單'), '列表第一列出現', '數據管理-影像清單');
  await measure(3, '資料清單（表格）', '/data/tabular', () => firstRow(page, '資料集列表'), '列表第一列出現', '數據管理-結構式資料');
  // 4 影像檢視器：從「影像標註」待處理清單點第一個研究
  await page.goto(`${BASE}/labeling`);
  await page.getByRole('link', { name: /的標註工作台$/ }).first().click();
  const viewerReady = () => page.locator('[data-testid="viewport"][data-ready="1"]').first();
  await measure(4, '影像檢視器', '', viewerReady, '影像與「第 1 / N 張」出現', '影像檢視器');
  const pos = (await page.getByTestId('image-position').innerText()).trim();
  note(TC, `影像檢視器位置文字「${pos}」`);
  expect(pos).toMatch(/^第 1 \/ \d+ 張$/);
  await measure(5, '訓練任務清單', '/training', () => firstRow(page, '訓練清單'), '訓練紀錄第一列出現', '建模管理-訓練紀錄');
  await measure(6, '監控看板', '/admin/compute/gpu', () => page.locator('ul[aria-label="GPU Dashboard"] > li').first(), 'GPU 卡片出現', '運算資源-GPU使用對照');
  await measure(7, '管理後台：帳號', '/admin/users', () => firstRow(page, '帳號列表'), '列表第一列出現', '管理後台-帳號');
  await measure(8, '管理後台：GPU 群組', '/admin/compute/groups', () => firstRow(page, 'GPU 群組列表'), '列表第一列出現', '運算資源-GPU群組');
  await measure(9, '管理後台：叢集節點', '/admin/compute/nodes', () => firstRow(page, '叢集節點列表'), '列表第一列出現', '運算資源-節點');

  // 10 介面資料回應：「建模管理 › 訓練紀錄」按「重新整理」，到對應 /api/ 請求結束
  await page.goto(`${BASE}/training`);
  await firstRow(page, '訓練清單').waitFor();
  await page.waitForLoadState('networkidle');
  const btn = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: '訓練紀錄' }) })
    .getByRole('button', { name: '重新整理', exact: true });
  const once = async () => {
    const t0 = Date.now();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/projects\/\d+\/training\/runs/.test(r.url()) && r.request().method() === 'GET'),
      btn.click(),
    ]);
    await resp.finished();
    const ms = Date.now() - t0;
    const timing = resp.request().timing();
    return { ms, server: timing.responseEnd > 0 ? timing.responseEnd - Math.max(0, timing.requestStart) : NaN, status: resp.status(), url: resp.url().replace(/^https?:\/\/[^/]+/, '') };
  };
  await once(); // 第一次不算
  await page.waitForTimeout(500);
  const api: Awaited<ReturnType<typeof once>>[] = [];
  for (let k = 0; k < 3; k++) {
    api.push(await once());
    await expect(btn).toBeEnabled();
    await page.waitForTimeout(500);
  }
  await shot(page, TC, '10-介面回應');
  const v = api.map((a) => a.ms);
  const avg = v.reduce((a, b) => a + b, 0) / 3;
  const max = Math.max(...v);
  const pass = avg <= 3000 && max <= 8000;
  results.push({ name: '介面資料回應', avg, max, api: true });
  lines.push(`介面資料回應｜「訓練紀錄」按「重新整理」→ GET ${api[0].url}｜請求結束（HTTP ${api.map((a) => a.status).join('、')}）｜${v.map(fmt).join('｜')}｜${fmt(avg)}｜${fmt(max)}｜${pass ? '通過' : '不通過'}（≤3／≤8 秒）｜—｜—｜—`);
  note(TC, `介面資料回應：${v.map(fmt).join('、')} 秒，平均 ${fmt(avg)}、最大 ${fmt(max)}`);

  const file = path.join(EVIDENCE_DIR, TC, 'TC-A02-09-紀錄表.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ua = await page.evaluate(() => navigator.userAgent);
  fs.writeFileSync(
    file,
    `量測：${new Date().toLocaleString('zh-TW', { hour12: false })}，${LABEL}（${ua}），Windows 11 開發機，本機連線 ${BASE}，admin01，目前專案 ${P1}。\n` +
      `方法：每頁先開一次（不算），再重新整理 3 次；「第 N 次」是從按下重新整理到首屏元素出現的秒數（程式量測，含 Playwright 輪詢誤差約 0.05 秒）。\n` +
      `DOMContentLoaded、Load、最後 /api/ 結束為瀏覽器 Navigation／Resource Timing（距離該次導覽開始的秒數）。\n\n${lines.join('\n')}\n`,
  );
  const failed = results.filter((r) => (r.api ? !(r.avg <= 3000 && r.max <= 8000) : !(r.avg <= 5000 && r.max <= 10000)));
  note(TC, `共 ${results.length} 項，不通過 ${failed.length} 項；頁面平均最大 ${fmt(Math.max(...results.filter((r) => !r.api).map((r) => r.avg)))} 秒`);
  await page.locator('.topbar').getByRole('button', { name: '登出', exact: true }).click().catch(() => undefined);
  await browser.close().catch(() => undefined);
  expect(failed).toEqual([]);
});
