import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

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

export async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '登入' }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(PASSWORDS[username] ?? DEV_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.getByText(`${username}（`).first()).toBeVisible({ timeout: 15_000 });
}

/** 把右上角「目前專案」切到指定專案（帳號沒有任何專案時略過） */
export async function useProject(page: Page, name = P1) {
  const sel = page.locator('#project-switcher');
  if ((await sel.count()) === 0) return;
  await sel.selectOption({ label: name });
  await expect(sel.locator('option:checked')).toHaveText(name);
}

export async function menuLabels(page: Page) {
  const nav = page.getByRole('navigation', { name: '功能選單' });
  return (await nav.getByRole('link').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
}

export async function clickMenu(page: Page, name: string) {
  await page.getByRole('navigation', { name: '功能選單' }).getByRole('link', { name, exact: true }).click();
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
