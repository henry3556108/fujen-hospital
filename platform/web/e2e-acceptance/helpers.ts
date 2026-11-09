import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

// M1 驗收輔助腳本共用：登入、切換目前專案、存證截圖。
// 密碼與 e2e-real 相同（種子帳號的本機測試密碼）；甲方環境以 KIT_PASSWORDS 覆寫，格式 admin01=xxx,pi01=yyy
const PASSWORDS: Record<string, string> = { admin01: 'Admin01-dev!' };
const DEV_PASSWORD = 'Dev-Passw0rd!';
for (const pair of (process.env.KIT_PASSWORDS ?? '').split(',').filter(Boolean)) {
  const [u, p] = pair.split('=');
  PASSWORDS[u] = p;
}

export const EVIDENCE_DIR = process.env.EVIDENCE_DIR || 'acceptance-evidence';
export const P1 = 'P1-lung-ct';
export const DENIED = '無法存取此功能';
/** 沒有加入任何專案時的說明頁（GlobalPages.tsx NoProjectPage）：標題＋請聯絡管理者 */
export const NO_PROJECT_TITLE = '你尚未加入任何專案';
export const NO_PROJECT_LEAD = '請聯絡專案管理者，將你的帳號加入研究專案。';
export async function expectNoProjectPage(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: NO_PROJECT_TITLE, exact: true })).toBeVisible();
  await expect(page.getByText(NO_PROJECT_LEAD, { exact: true })).toBeVisible();
}

// ── 介面改版後的外框定位（集中在這裡，畫面用語變動時只改這一段） ──

/** 契約 8 個功能入口原名稱（功能目錄依此順序列出） */
export const CONTRACT_ENTRIES = [
  '帳號管理',
  '數據管理',
  '影像標註',
  '自動影像分類標註',
  '建模管理',
  'AI 模型部署',
  '推論服務管理',
  'LLM No-code 開發',
] as const;
export type ContractEntry = (typeof CONTRACT_ENTRIES)[number];
const isContract = (name: string): name is ContractEntry => (CONTRACT_ENTRIES as readonly string[]).includes(name);

/** 研究區側欄名稱 */
export const SIDE = {
  home: '專案首頁',
  data: '數據管理',
  labeling: '影像標註',
  training: '建模管理',
  models: '模型部署與推論服務',
  llm: '大型語言模型',
  catalog: '功能目錄',
  admin: '管理後台',
} as const;

/** 管理區側欄名稱 */
export const ADMIN_SIDE = {
  overview: 'Dashboard',
  users: '帳號管理',
  projects: '專案管理',
  compute: 'GPU／CPU 伺服器管理',
  monitoring: '系統監控',
  fhir: 'HL7 FHIR 醫療資料交換',
  audit: '稽核與審核',
  back: '回研究區',
} as const;

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 名稱開頭相符（卡片連結的名稱常含說明文字） */
export const startsWith = (s: string) => new RegExp(`^\\s*${esc(s)}`);

/** 側欄（研究區「功能選單」、管理區「管理後台選單」） */
export function sideNav(page: Page): Locator {
  return page.getByRole('navigation', { name: /^(功能選單|管理後台選單)$/ });
}

/** 契約入口在功能目錄上可能用的名稱（LLM 入口改用全名，原名列為別名） */
const ENTRY_ALIASES: Record<string, string[]> = {
  'LLM No-code 開發': ['LLM No-code 開發', '大型語言模型 No-code 開發'],
};
const entryPattern = (name: string) => new RegExp(`^\\s*(${(ENTRY_ALIASES[name] ?? [name]).map(esc).join('|')})`);

export async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '登入' }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(PASSWORDS[username] ?? DEV_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.locator('.topbar__username')).toHaveText(username, { timeout: 15_000 });
}

/**
 * 把「目前專案」切到指定專案（帳號沒有任何專案時略過）。
 * 頂端有下拉選單就直接選；沒有（例如 Admin 在管理區）就到「選擇專案」頁點該專案。
 */
export async function useProject(page: Page, name = P1) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const sel = page.locator('select#project-switcher');
  if ((await sel.count()) > 0) {
    if ((await sel.locator('option:checked').innerText().catch(() => '')).trim() !== name) {
      await sel.selectOption({ label: name });
    }
    await expect(sel.locator('option:checked')).toHaveText(name);
    return;
  }
  await page.goto('/projects');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const main = page.locator('main');
  const target = main
    .getByRole('button', { name: startsWith(name) })
    .or(main.getByRole('link', { name: startsWith(name) }))
    .first();
  if ((await target.count()) === 0) return; // 沒有任何專案（例如 user01）
  await target.click();
  // 點卡片只是選取，按「進入專案 →」才進入
  const enter = main.getByRole('button', { name: /進入專案/ });
  if ((await enter.count()) > 0) await enter.click();
  // 選好後回到研究區，頂端「目前專案」下拉顯示該專案
  await expect(page.locator('select#project-switcher option:checked')).toHaveText(name);
}

/** 開啟側欄底部的「功能目錄」 */
export async function openCatalog(page: Page) {
  await sideNav(page).getByRole('link', { name: SIDE.catalog, exact: true }).click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole('heading', { level: 1, name: SIDE.catalog })).toBeVisible();
}

/** 功能目錄的入口表（GlobalPages.tsx CatalogPage：table「功能目錄」，每列 rowheader 是入口名稱連結） */
export function catalogList(page: Page): Locator {
  return page.getByRole('table', { name: '功能目錄' });
}

/**
 * 功能目錄上看得到的契約入口原名稱（依權限產生的「選單」）。會開到功能目錄頁。
 * 別名列（LLM No-code 開發）與全名併成一項，回傳原名稱。沒有任何入口時回傳空陣列。
 */
export async function menuLabels(page: Page) {
  await openCatalog(page);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if ((await catalogList(page).count()) === 0) return [];
  const texts = (await catalogList(page).locator('tbody th a').allInnerTexts()).map((t) => t.trim());
  const names = texts.map((t) => CONTRACT_ENTRIES.find((e) => entryPattern(e).test(t)) ?? t);
  return names.filter((n, i) => names.indexOf(n) === i);
}

/** 側欄目前顯示的名稱 */
export async function sideLabels(page: Page) {
  return (await sideNav(page).getByRole('link').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
}

/**
 * 點選功能：傳入契約 8 入口原名稱時，打開「功能目錄」再點該名稱（＝驗收「自入口點擊進入」）；
 * 其他名稱直接點側欄。
 */
export async function clickMenu(page: Page, name: string) {
  if (isContract(name)) {
    await openCatalog(page);
    await catalogList(page).getByRole('link', { name: entryPattern(name) }).first().click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    return;
  }
  await sideNav(page).getByRole('link', { name, exact: true }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** 頁內分頁（連結式或 tab 式皆可） */
export async function clickTab(page: Page, name: string | RegExp, scope: Page | Locator = page) {
  const opts = typeof name === 'string' ? { name, exact: true } : { name };
  await scope.getByRole('tab', opts).or(scope.getByRole('link', opts)).first().click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** 存證截圖：<EVIDENCE_DIR>/<案例>/<檔名>.png */
export async function shot(page: Page, tc: string, name: string) {
  const dir = path.join(EVIDENCE_DIR, tc);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/** 寫一行到該案例的紀錄檔（同時印到終端機） */
export function note(tc: string, line: string) {
  const dir = path.join(EVIDENCE_DIR, tc);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, '紀錄.txt'), `${new Date().toLocaleString('zh-TW', { hour12: false })}  ${line}\n`);
  console.log(`[${tc}] ${line}`);
}

export async function expectNotDenied(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(DENIED)).toHaveCount(0);
}
