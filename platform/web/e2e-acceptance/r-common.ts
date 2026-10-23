import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { EVIDENCE_DIR, shot } from './helpers';
import { PROJECT_TABS, adminTab, projectTab, psql, q } from './ops';

// M1 補拍（M1補拍\01～13）共用：網址列入鏡截圖、指定密碼登入、登出、成功訊息、稽核查詢。

export const KC_INVALID = '使用者名稱或密碼無效。';

/**
 * 截圖時在畫面最上方疊一條「網址列」（文字取自瀏覽器目前的 page.url()），
 * 因為 Playwright 的頁面截圖不含瀏覽器本身的網址列。截完即移除。
 */
export async function shotUrl(page: Page, tc: string, name: string) {
  const url = page.url();
  await page
    .evaluate((u) => {
      const bar = document.createElement('div');
      bar.id = '__kit_urlbar';
      bar.textContent = `網址列：${u}`;
      bar.setAttribute(
        'style',
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#dfe3e8;color:#111;font:15px/30px Consolas,monospace;padding:0 12px;border-bottom:1px solid #999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
      );
      document.documentElement.appendChild(bar);
      document.documentElement.style.paddingTop = '31px';
    }, url)
    .catch(() => undefined);
  await shot(page, tc, name);
  await page
    .evaluate(() => {
      document.getElementById('__kit_urlbar')?.remove();
      document.documentElement.style.paddingTop = '';
    })
    .catch(() => undefined);
}

/** 在 Keycloak 登入頁輸入帳密（不檢查結果） */
export async function kcSubmit(page: Page, username: string, password: string) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}

/** 從平台登入頁按「登入」到 Keycloak */
export async function toKeycloak(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登入', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page.locator('#username')).toBeVisible({ timeout: 15_000 });
}

/** 指定密碼登入，回到平台並看到右上角帳號 */
export async function loginWith(page: Page, username: string, password: string) {
  await toKeycloak(page);
  await kcSubmit(page, username, password);
  await expect(page.locator('.topbar__username')).toHaveText(username, { timeout: 15_000 });
}

/** 指定密碼登入應失敗：停在 Keycloak 並顯示「使用者名稱或密碼無效。」 */
export async function loginFails(page: Page, username: string, password: string) {
  await toKeycloak(page);
  await kcSubmit(page, username, password);
  await expect(page.getByText(KC_INVALID).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#username')).toBeVisible();
}

export async function logout(page: Page) {
  // 頂端的「登出」（沒有專案的說明頁、個人設定頁另有登出按鈕）
  await page.locator('.topbar').getByRole('button', { name: '登出', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登入', level: 1 })).toBeVisible({ timeout: 15_000 });
}

/**
 * 頂端「帳號（身分）」文字：帳號取自右上角，身分取自「我的身分（…）」；
 * Admin 在管理區顯示「系統管理區」；沒有專案時只回帳號（頂端改顯示「尚未加入任何專案」）。
 */
export async function headerUser(page: Page) {
  const user = (await page.locator('.topbar__username').innerText()).trim();
  const role = page.getByTestId('header-role');
  if (await role.count()) {
    const m = /（(.+)）/.exec((await role.innerText()).replace(/\s+/g, ''));
    if (m) return `${user}（${m[1]}）`;
  }
  const area = page.locator('.topbar__area');
  if (await area.count()) return `${user}（${(await area.innerText()).trim()}）`;
  return user;
}

/** 綠色成功訊息「完成：…」，捲到可見處 */
export async function ok(page: Page, text: string) {
  const s = page.getByRole('status').filter({ hasText: `完成：${text}` });
  await expect(s).toBeVisible();
  await s.scrollIntoViewIfNeeded();
  return s;
}

/** 每個帳號一個新的瀏覽器環境（等同新開無痕視窗） */
export async function freshPage(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  return { ctx, page };
}

/** 管理區「專案」→ 專案頁「成員與權限」分頁（取代舊 /admin/members 的專案下拉） */
export async function membersOf(page: Page, project: string) {
  await projectTab(page, project, PROJECT_TABS.members);
  // 專案頁內的專案下拉是隱藏的（專案由網址決定）；舊版頁面才需要選
  const sel = page.locator('select#member-project');
  if (await sel.isVisible().catch(() => false)) await sel.selectOption({ label: project });
  await expect(page.getByRole('table', { name: '目前的專案成員' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** 管理區「專案」→ 專案頁「標註群組」分頁 */
export async function labelGroupsOf(page: Page, project: string) {
  await projectTab(page, project, PROJECT_TABS.labelGroups);
  // 專案頁內的專案下拉是隱藏的（專案由網址決定）；舊版頁面才需要選
  const sel = page.locator('select#group-project');
  if (await sel.isVisible().catch(() => false)) await sel.selectOption({ label: project });
  await expect(page.getByRole('table', { name: '標註群組列表' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

export async function gotoAdmin(page: Page, tab: string) {
  await adminTab(page, tab);
  await page.waitForLoadState('networkidle');
}

/** 稽核紀錄分頁：類別篩選，回傳表格前 n 列 */
export async function auditFilter(page: Page, label: string, n: number) {
  await gotoAdmin(page, '稽核紀錄');
  const form = page.getByRole('form', { name: '篩選稽核紀錄' });
  await form.getByLabel('類別').selectOption({ label });
  await form.getByLabel('操作者').fill('admin01');
  await form.getByRole('button', { name: '查詢' }).click();
  await page.waitForLoadState('networkidle');
  const rows = await page.getByRole('table', { name: '稽核紀錄' }).locator('tbody tr').all();
  const out: string[][] = [];
  for (const r of rows.slice(0, n)) out.push((await r.locator('th, td').allInnerTexts()).map((s) => s.trim()));
  return out;
}

/** 寫出資料庫唯讀查詢結果（附指令）到 <案例>/<檔名>.txt */
export function dbDump(tc: string, file: string, sql: string) {
  const cmd = `kubectl -n ai-platform exec postgres-0 -- psql -U platform -d platform -c "${sql}"`;
  const out = q(cmd);
  const dir = path.join(EVIDENCE_DIR, tc);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${file}.txt`), `$ ${cmd}\n${out}\n\n`);
  return out;
}

export const maxAuditId = () => Number(psql('select coalesce(max(id),0) from audit_log'));
