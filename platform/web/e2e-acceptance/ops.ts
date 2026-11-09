import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN_SIDE, EVIDENCE_DIR, P1, SIDE, clickTab, login, note, sideNav } from './helpers';

// 情境 8～10 共用：終端機指令存證、各帳號獨立瀏覽器、帳號管理分頁與專案工作頁的操作。

export const REPO = path.resolve(process.cwd(), '../..'); // 在 platform/web 執行
export const KIT = path.join(REPO, 'docs/acceptance-kit/m1');
export const ENV = {
  ...process.env,
  PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
  GATEWAY: process.env.GATEWAY || 'http://localhost:38980',
  KEYCLOAK: process.env.KEYCLOAK || 'http://localhost:38180',
};

/** 執行劇本中的終端機指令，輸出存到 <案例>/<檔名>.txt（附指令本身），回傳 { out, code } */
export function sh(tc: string, file: string, cmd: string, cwd = REPO) {
  let out = '';
  let code = 0;
  try {
    out = execSync(cmd, { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/bash', maxBuffer: 64 << 20 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? 1;
  }
  const dir = path.join(EVIDENCE_DIR, tc);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${file}.txt`), `$ ${cmd}\n${out}\n結束碼 ${code}\n\n`);
  return { out, code };
}

/** 不存證的查詢（例如等待叢集閒置） */
export function q(cmd: string): string {
  try {
    return execSync(cmd, { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/bash' }).trim();
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '').trim();
  }
}

export const psql = (sql: string) =>
  q(`kubectl -n ai-platform exec postgres-0 -- psql -U platform -d platform -tA -F'|' -c "${sql.replace(/"/g, '\\"')}"`);

/** 每個帳號一個獨立瀏覽器環境（等同無痕視窗） */
export async function userPage(browser: Browser, user: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, user);
  return { ctx, page };
}

/** 進入管理區並點側欄項目（在研究區時先按側欄底部「管理後台」） */
export async function adminSide(page: Page, name: string) {
  if (!/\/admin(\/|$)/.test(new URL(page.url() || 'about:blank', 'http://x').pathname)) {
    const link = sideNav(page).getByRole('link', { name: SIDE.admin, exact: true });
    if (await link.count()) await link.click();
    else await page.goto('/admin');
  }
  await sideNav(page).getByRole('link', { name, exact: true }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** 舊「帳號管理」分頁名稱 → 新管理區位置 */
const ADMIN_MAP: Record<string, { side: string; tab?: string }> = {
  'Dashboard 總覽': { side: ADMIN_SIDE.overview },
  'Account 帳號': { side: ADMIN_SIDE.users },
  專案: { side: ADMIN_SIDE.projects },
  稽核紀錄: { side: ADMIN_SIDE.audit, tab: '稽核紀錄' },
  模型下載審核: { side: ADMIN_SIDE.audit, tab: '模型下載審核' },
  共享排程設定: { side: ADMIN_SIDE.compute },
  '資料交換（FHIR）': { side: ADMIN_SIDE.fhir },
};

/**
 * 管理區頁面。沿用舊分頁名稱呼叫：「專案成員」「標註群組」改到專案頁的分頁（預設 P1，可傳 project）。
 */
export async function adminTab(page: Page, tab: string, project = P1) {
  if (tab === '專案成員') return projectTab(page, project, PROJECT_TABS.members);
  if (tab === '標註群組') return projectTab(page, project, PROJECT_TABS.labelGroups);
  const m = ADMIN_MAP[tab] ?? { side: tab };
  await adminSide(page, m.side);
  if (m.tab) await clickTab(page, m.tab, page.locator('main'));
}

/** 專案頁的四個分頁 */
export const PROJECT_TABS = {
  basic: '基本資料與 GPU 群組',
  members: '成員與權限',
  labelGroups: '標註群組',
  allowlist: 'Accession Number 清單',
} as const;

/** 管理區「專案」→ 點專案名稱 → 專案頁分頁 */
export async function projectTab(page: Page, project: string, tab: string) {
  await adminSide(page, ADMIN_SIDE.projects);
  const table = page.getByRole('table', { name: '專案列表' });
  await table.getByRole('link', { name: project, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/projects\/\d+/);
  await clickTab(page, tab, page.locator('main'));
}

/** 舊「排程與叢集」分頁名稱 → 新「運算資源」分頁名稱與網址 */
const COMPUTE_MAP: Record<string, { tab: string; path: string }> = {
  'GPU Dashboard': { tab: 'GPU Dashboard', path: '/admin/compute/gpu' },
  佇列順序: { tab: '佇列排程', path: '/admin/compute/queues' },
  共享排程設定: { tab: '共享排程設定', path: '/admin/compute/shared' },
  'GPU 群組': { tab: 'GPU 群組', path: '/admin/compute/groups' },
  叢集節點: { tab: '節點', path: '/admin/compute/nodes' },
};

/** 管理區「運算資源」→ 頁內分頁（沿用舊分頁名稱呼叫）；「監控儀表板」改為側欄「系統監控」 */
export async function schedulingTab(page: Page, tab: string) {
  if (tab === '監控儀表板') {
    await adminSide(page, ADMIN_SIDE.monitoring);
    await expect(page).toHaveURL(/\/admin\/monitoring/);
    return;
  }
  const m = COMPUTE_MAP[tab] ?? { tab, path: '' };
  await adminSide(page, ADMIN_SIDE.compute);
  await clickTab(page, m.tab, page.locator('main'));
  if (m.path) await expect(page).toHaveURL(new RegExp(`${m.path}$`));
}

/**
 * 原「專案工作」（送出工作表單＋工作列表）：改為 Admin 專用的管理區「運算資源 › 測試工作」（/admin/compute/jobs），
 * 頁內「送出到專案」選專案。page 必須是 admin01 登入的頁面；研究者看不到假工作。
 */
export async function gotoJobs(page: Page, project: string) {
  await adminSide(page, ADMIN_SIDE.compute);
  await clickTab(page, '測試工作', page.getByRole('navigation', { name: 'GPU／CPU 伺服器管理分頁' }));
  await expect(page).toHaveURL(/\/admin\/compute\/jobs/);
  const picker = page.locator('#jobs-project');
  await picker.waitFor();
  if ((await picker.locator('option:checked').innerText()).trim() !== project) await picker.selectOption({ label: project });
  await expect(picker.locator('option:checked')).toHaveText(project);
  await expect(page.getByText(`專案「${project}」的排程工作`)).toBeVisible();
  await expect(page.getByRole('form', { name: '送出工作' })).toBeVisible();
}

/** 在「送出工作」表單送出一件工作，回傳畫面訊息中的工作編號與佇列 */
export async function submitJob(page: Page, opts: { kind?: '訓練（GPU）' | '資料清洗（CPU）'; seconds: number; fail?: boolean }) {
  const form = page.getByRole('form', { name: '送出工作' });
  await form.getByLabel('工作種類').selectOption({ label: opts.kind ?? '訓練（GPU）' });
  await form.getByLabel('執行秒數（1–3600）').fill(String(opts.seconds));
  await form.getByRole('checkbox', { name: '讓這件工作以失敗結束（測試佇列不會卡住）' }).setChecked(!!opts.fail);
  const msg = page.getByRole('status').filter({ hasText: /已送出工作 \d+，進入佇列/ });
  const before = (await msg.allInnerTexts()).join();
  await form.getByRole('button', { name: '送出工作' }).click();
  await expect(msg).toBeVisible();
  await expect.poll(async () => (await msg.innerText()) !== before).toBeTruthy();
  const text = (await msg.innerText()).trim();
  const m = /已送出工作 (\d+)，進入佇列 (\S+)/.exec(text)!;
  return { id: Number(m[1]), queue: m[2], text };
}

export function jobRow(page: Page, id: number) {
  return page
    .getByRole('table', { name: '工作列表' })
    .locator('tbody tr')
    .filter({ has: page.getByRole('rowheader', { name: String(id), exact: true }) });
}

export async function jobStatus(page: Page, id: number) {
  return (await jobRow(page, id).getAttribute('data-status')) ?? '';
}

/** 工作列表該列的各欄文字 */
export async function jobCells(page: Page, id: number) {
  const row = jobRow(page, id);
  const cells = (await row.locator('th, td').allInnerTexts()).map((s) => s.trim());
  const [jid, kind, status, user, group, queue, created, started, finished, message] = cells;
  return { jid, kind, status, user, group, queue, created, started, finished, message };
}

/** 等待叢集 platform-jobs 沒有排隊／執行中的 Pod（避免前一案的工作影響下一案） */
export async function waitIdle(page: Page, maxSec = 240) {
  for (let i = 0; i < maxSec / 5; i++) {
    const busy = q(
      `kubectl -n platform-jobs get pods --no-headers --field-selector=status.phase!=Succeeded,status.phase!=Failed 2>/dev/null | wc -l`,
    );
    // 資料庫的工作狀態要等有人開工作列表才同步，所以以叢集為準：沒有執行中的 Pod、Kueue 沒有等候中的工作
    const pending = q(`kubectl get clusterqueues -o jsonpath='{range .items[*]}{.status.pendingWorkloads}{"\\n"}{end}' | awk '{s+=$1} END {print s+0}'`);
    if (busy === '0' && pending === '0') return;
    await page.waitForTimeout(5000);
  }
  throw new Error('叢集仍有排隊或執行中的工作，無法開始本案例');
}

export { note };
