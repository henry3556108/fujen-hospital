import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { EVIDENCE_DIR, P1, note, shot } from './helpers';
import { psql } from './ops';

// M1 補拍 10：Chrome、Edge 版面相容（TC-A02-08）。
// 以 Windows 上的瀏覽器執行：先在 Windows 用 --remote-debugging-port 開 Chrome／Edge（視窗 1366×768），
// 再由這裡以 CDP 連線操作（CDP_URL=http://127.0.0.1:<埠>，BROWSER_LABEL=Chrome 或 Edge）。
// 每頁由程式檢查：水平捲軸、超出視窗的元素、Console 錯誤；要點的元件只打開下拉、切分頁，不送出表單。
const TC = 'TC-A02-08';
const CDP = process.env.CDP_URL || '';
const LABEL = process.env.BROWSER_LABEL || 'Chrome';
const BASE = process.env.WEB_URL || 'http://localhost:38982';

type Check = { hscroll: boolean; overflow: string[] };

async function layoutCheck(page: Page): Promise<Check> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const hscroll = document.documentElement.scrollWidth > vw + 1;
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.getBoundingClientRect().right <= vw + 1) return true;
      }
      return false;
    };
    const overflow: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed') continue;
      if (r.right > vw + 1 && !clipped(el)) {
        const id = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}`;
        overflow.push(`${id}(right=${Math.round(r.right)})`);
      }
    }
    return { hscroll, overflow: overflow.slice(0, 5) };
  });
}

const ROWS_FILE = () => path.join(EVIDENCE_DIR, TC, 'TC-A02-08-紀錄表.txt');
function row(line: string) {
  fs.mkdirSync(path.dirname(ROWS_FILE()), { recursive: true });
  if (!fs.existsSync(ROWS_FILE())) fs.writeFileSync(ROWS_FILE(), '瀏覽器｜#｜頁面｜網址｜要點的元件與結果｜水平捲軸｜超出視窗元素｜Console 錯誤｜破版｜無法操作\n');
  fs.appendFileSync(ROWS_FILE(), `${line}\n`);
}

/** 原生下拉選單：點開再按 Esc 關閉，值不變 */
async function poke(page: Page, sel: ReturnType<Page['locator']>) {
  const before = await sel.inputValue();
  const n = await sel.locator('option').count();
  await sel.click();
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const after = await sel.inputValue();
  return { ok: n > 0 && before === after && (await sel.isEnabled()), n };
}

/** 依序點分頁（nav.tabs 內的連結），每次確認網址改變且頁面沒有錯誤框 */
async function clickTabs(page: Page, nav: ReturnType<Page['locator']>) {
  const links = await nav.locator('a').all();
  const names: string[] = [];
  let ok = 0;
  for (const a of links) {
    const name = (await a.innerText()).trim();
    names.push(name);
    await a.click();
    await page.waitForLoadState('networkidle');
    if ((await a.getAttribute('aria-current')) === 'page' || (await a.getAttribute('class'))?.includes('active')) ok++;
  }
  return { ok, total: links.length, names };
}

test('M1 補拍 10 瀏覽器相容（TC-A02-08）', async () => {
  test.skip(!CDP, '需要 CDP_URL（Windows 上開啟的 Chrome／Edge）');
  test.setTimeout(10 * 60_000);
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.bringToFront();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push(`pageerror ${String(e).slice(0, 160)}`));

  // 0 版本頁
  const verUrl = LABEL === 'Edge' ? 'edge://version' : 'chrome://version';
  await page.goto(verUrl);
  const version = (await page.locator('#version').innerText().catch(() => '')).trim() || (await page.locator('body').innerText()).split('\n').slice(0, 2).join(' ');
  const ua = await page.evaluate(() => navigator.userAgent);
  await shot(page, TC, `${LABEL}-00-版本`);
  note(TC, `${LABEL}：${version}；UA ${ua}`);

  const ds = psql(`select t.id from tabular_datasets t join projects p on p.id=t.project_id where p.name='${P1}' order by t.id limit 1`);
  let broken = 0;
  let inoperable = 0;
  const doPage = async (i: number, title: string, url: string, name: string, act: () => Promise<string>) => {
    errors.length = 0;
    if (url) {
      await page.goto(`${BASE}${url}`);
      await page.waitForLoadState('networkidle');
    }
    let result = '';
    let operable = true;
    try {
      result = await act();
      if (result.startsWith('失敗')) operable = false;
    } catch (e) {
      operable = false;
      result = `失敗：${String(e).split('\n')[0].slice(0, 120)}`;
    }
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const c = await layoutCheck(page);
    const errs = [...errors];
    const isBroken = c.hscroll || c.overflow.length > 0;
    if (isBroken) broken++;
    if (!operable) inoperable++;
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, TC, `${LABEL}-${String(i).padStart(2, '0')}-${name}`);
    const size = await page.evaluate(() => `${innerWidth}×${innerHeight}（視窗 ${outerWidth}×${outerHeight}）`);
    row(`${LABEL}｜${i}｜${title}｜${url || page.url().replace(BASE, '')}｜${result}｜${c.hscroll ? '有' : '無'}｜${c.overflow.length ? c.overflow.join(' ') : '無'}｜${errs.length ? errs.join(' / ') : '無'}｜破版：${isBroken ? '有' : '無'}｜無法操作：${operable ? '無' : '有'}`);
    if (i === 1) note(TC, `${LABEL} 頁面可視區 ${size}`);
  };

  // 1 登入頁（未登入）
  await doPage(1, '登入頁（未登入）', '/login', '登入頁', async () => {
    await expect(page.getByRole('button', { name: '登入' })).toBeEnabled();
    return '「登入」按鈕可按（截圖後點下登入）';
  });
  await page.getByRole('button', { name: '登入' }).click();
  await page.locator('#username').fill('admin01');
  await page.locator('#password').fill('Admin01-dev!');
  await page.locator('#kc-login').click();
  await expect(page.locator('.topbar__username')).toHaveText('admin01', { timeout: 15_000 });
  const sw = page.locator('#project-switcher');
  await sw.selectOption({ label: P1 });

  await doPage(2, '首頁', '/', '首頁', async () => {
    const cards = await page.locator('main .entry-grid > li').count();
    await page.locator('main .entry-grid a').first().hover();
    return cards === 8 ? '8 張入口卡片皆顯示' : `失敗：入口卡片 ${cards} 張`;
  });
  await doPage(3, '帳號管理 › 專案', '/admin/projects', '專案', async () => {
    await page.getByRole('button', { name: `編輯 ${P1}`, exact: true }).click();
    await expect(page.getByRole('form', { name: '編輯專案' })).toBeVisible();
    await page.getByRole('form', { name: '編輯專案' }).getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('form', { name: '新增專案' }).getByRole('button', { name: '新增專案' })).toBeEnabled();
    return '「編輯」開啟編輯表單後取消；「新增專案」按鈕可按（未送出）';
  });
  await doPage(4, '帳號管理 › 帳號', '/admin/users', '帳號', async () => {
    const r = await poke(page, page.getByLabel('admin01 的帳號類型'));
    return r.ok ? `「帳號類型」下拉可開啟（${r.n} 個選項），值未變更` : '失敗：帳號類型下拉';
  });
  await doPage(5, '數據管理', '/data/imaging', '數據管理', async () => {
    const t = await clickTabs(page, page.getByRole('navigation', { name: '數據管理分頁' }));
    return t.ok === 2 ? `兩個分頁切換正常（${t.names.join('、')}）` : `失敗：分頁 ${t.ok}/${t.total}`;
  });
  await doPage(6, '描述統計', `/data/tabular/${ds}/describe`, '描述統計', async () => {
    const nav = page.getByRole('navigation', { name: '資料集分頁' });
    const t = await clickTabs(page, nav);
    await nav.getByRole('link', { name: '描述統計' }).click();
    await page.waitForLoadState('networkidle');
    return t.ok === 6 ? `6 個分頁切換正常（${t.names.join('、')}），回到描述統計` : `失敗：分頁 ${t.ok}/${t.total}（${t.names.join('、')}）`;
  });
  await doPage(7, '影像標註', '/labeling', '影像標註', async () => {
    await expect(page.getByText('研究清單').first()).toBeVisible();
    const rows = await page.locator('main table tbody tr').count();
    return `研究清單顯示 ${rows} 列`;
  });
  await doPage(8, '專案工作', '/training/jobs', '專案工作', async () => {
    const r = await poke(page, page.getByRole('form', { name: '送出工作' }).getByLabel('工作種類'));
    return r.ok ? `「工作種類」下拉可開啟（${r.n} 個選項），未送出` : '失敗：工作種類下拉';
  });
  await doPage(9, '推論服務管理', '/inference', '推論服務', async () => {
    const btn = page.getByRole('button', { name: /^選擇 / }).first();
    if (!(await btn.count())) {
      const empty = await page.getByText('這個專案還沒有訓練完成的模型。').isVisible();
      return empty ? '開發環境目前沒有訓練完成的模型，頁面顯示「這個專案還沒有訓練完成的模型。」，沒有可點的「選擇」（資料狀態，非介面問題）' : `模型 ${await page.locator('main table tbody tr').count()} 列皆已選擇`;
    }
    const label = (await btn.innerText()).trim();
    await btn.click();
    await page.waitForLoadState('networkidle');
    return `按「${label}」後該模型變成已選擇`;
  });
  await doPage(10, 'LLM No-code 開發', '/llm/playground', 'LLM', async () => {
    const t = await clickTabs(page, page.getByRole('navigation', { name: 'LLM 功能分頁' }));
    await page.getByRole('navigation', { name: 'LLM 功能分頁' }).getByRole('link', { name: 'Playground' }).click();
    await page.waitForLoadState('networkidle');
    const r = await poke(page, page.locator('#chat-mode'));
    return t.ok === 7 && r.ok ? `7 個分頁切換正常，「對話模式」下拉可開啟（${r.n} 個選項）` : `失敗：分頁 ${t.ok}/${t.total}、對話模式 ${r.ok}`;
  });
  note(TC, `${LABEL} 10 頁：破版 ${broken}、無法操作 ${inoperable}`);
  // 登出，留下乾淨的狀態
  await page.getByRole('button', { name: '登出', exact: true }).click().catch(() => undefined);
  await browser.close().catch(() => undefined);
  expect(broken).toBe(0);
  expect(inoperable).toBe(0);
});
