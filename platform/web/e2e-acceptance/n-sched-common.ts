import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { EVIDENCE_DIR, login, note } from './helpers';

// 新功能情境 A（排程）、D1、E（功能缺口）共用：API 呼叫、終端機指令存證、逐步截圖與結果判定。
// 對象是本機 compose 堆疊（網頁 9082、Gateway 9080、Keycloak 8080），排程工作送進 kind 叢集（kind-ai-platform）。

export const GATEWAY = process.env.GATEWAY || 'http://localhost:9080';
export const KEYCLOAK = process.env.KEYCLOAK || 'http://localhost:8080';
export const KUBE = process.env.KUBE_CONTEXT || 'kind-ai-platform';
export const REPO = path.resolve(process.cwd(), '../..'); // 在 platform/web 執行
export const COMPOSE_DIR = path.join(REPO, 'platform/deploy/local');
export const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'ai-platform';
export const P1_NAME = 'P1-lung-ct';

const PASSWORDS: Record<string, string> = { admin01: 'Admin01-dev!' };
for (const pair of (process.env.KIT_PASSWORDS ?? '').split(',').filter(Boolean)) {
  const [u, p] = pair.split('=');
  PASSWORDS[u] = p;
}
export const password = (user: string) => PASSWORDS[user] ?? 'Dev-Passw0rd!';

// ---------------------------------------------------------------- API

export async function token(user: string): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'password', client_id: 'ai-platform-web', username: user, password: password(user) });
  const r = await fetch(`${KEYCLOAK}/realms/ai-platform/protocol/openid-connect/token`, { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error(`無法取得 ${user} 的 token（HTTP ${r.status}）`);
  return j.access_token;
}

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

/** 以指定帳號經 Gateway 呼叫 API；body 為 FormData 時送 multipart，其他物件送 JSON。 */
export async function api(user: string, method: string, p: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await token(user)}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(`${GATEWAY}${p}`, { method, headers, body: payload });
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed, text };
}

/** 呼叫並要求 2xx，否則丟出含回應內容的錯誤 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiOk(user: string, method: string, p: string, body?: unknown): Promise<any> {
  const r = await api(user, method, p, body);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${p}（${user}）→ HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
}

export async function projectId(name: string): Promise<number | null> {
  const list = (await apiOk('admin01', 'GET', '/api/admin/projects')) as { id: number; name: string }[];
  return list.find((p) => p.name === name)?.id ?? null;
}

export async function userId(username: string): Promise<number> {
  const list = (await apiOk('admin01', 'GET', '/api/admin/users')) as { id: number; username: string }[];
  const u = list.find((x) => x.username === username);
  if (!u) throw new Error(`找不到帳號 ${username}`);
  return u.id;
}

// ---------------------------------------------------------------- 佇列

export interface QueueJob {
  id: number;
  project_id: number;
  user: string;
  kind: string;
  status: string;
  k8s_name: string;
  admitted: boolean;
  training_run: { id: number; name: string } | null;
  inference_id: number | null;
  started_at: string | null;
}
export interface QueueOverview {
  queue: string;
  running: QueueJob[];
  waiting: QueueJob[];
  held: QueueJob[];
}

export async function queue(name: string): Promise<QueueOverview> {
  const all = (await apiOk('admin01', 'GET', '/api/admin/queues')) as QueueOverview[];
  const q = all.find((x) => x.queue === name);
  if (!q) throw new Error(`找不到佇列 ${name}`);
  return q;
}

export const ids = (jobs: QueueJob[]) => jobs.map((j) => j.id);

/** 輪詢佇列直到條件成立 */
export async function waitQueue(name: string, ok: (q: QueueOverview) => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  let last: QueueOverview | null = null;
  while (Date.now() < deadline) {
    last = await queue(name);
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`等待「${what}」逾時；佇列 ${name} 目前 執行中 ${ids(last?.running ?? [])}、等待 ${ids(last?.waiting ?? [])}、暫存 ${ids(last?.held ?? [])}`);
}

/** 取消一件排程工作：訓練經訓練 API 取消（訓練紀錄同步變成已取消），其他經專案工作 API；以送出者身分。已結束的略過。 */
export async function cancelJob(projectIdValue: number, job: { id: number; user: string; training_run?: { id: number } | null }) {
  const p = job.training_run
    ? `/api/projects/${projectIdValue}/training/runs/${job.training_run.id}/cancel`
    : `/api/projects/${projectIdValue}/jobs/${job.id}/cancel`;
  const r = await api(job.user, 'POST', p);
  return r.status;
}

/**
 * 開始前確認佇列淨空：上次中斷留下的暫存工作直接取消（只有這組腳本會暫存工作），
 * 排隊／執行中的工作等它們自然結束（最多 maxMs）。
 */
export async function ensureQueueIdle(s: Scenario, name: string, maxMs = 7 * 60_000) {
  let q = await queue(name);
  for (const j of q.held) {
    const code = await cancelJob(j.project_id, j);
    s.log(`開始前清除先前中斷留下的暫存工作 ${j.id}（${j.user}）：HTTP ${code}`);
  }
  q = await queue(name);
  if (q.running.length + q.waiting.length === 0) return;
  s.log(`佇列 ${name} 仍有工作（執行中 ${ids(q.running)}、等待 ${ids(q.waiting)}），等待結束後再開始（最多 ${maxMs / 60000} 分鐘）`);
  await waitQueue(name, (x) => x.running.length + x.waiting.length + x.held.length === 0, maxMs, `${name} 淨空`);
}

/** 以 API 送出假工作（準備用的佔位工作，不在畫面上操作） */
export async function submitJobApi(user: string, pid: number, seconds: number, kind: 'training' | 'data-cleaning' = 'training') {
  const job = await apiOk(user, 'POST', `/api/projects/${pid}/jobs`, { kind, duration_seconds: seconds, memory_mb: 16, fail: false });
  return job as { id: number; queue: string; user: string };
}

// ---------------------------------------------------------------- 終端機指令（輸出寫入紀錄.txt）

const SHELL_ENV = {
  ...process.env,
  PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
  GATEWAY,
  KEYCLOAK,
};

export function shellRaw(cmd: string, cwd = REPO, timeout = 120_000): { out: string; code: number } {
  try {
    const out = execSync(cmd, { cwd, env: SHELL_ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/bash', maxBuffer: 64 << 20, timeout });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

/** 在指令內取得 token 的 shell 片段（token 不會出現在紀錄中） */
export function tokenExpr(user: string): string {
  return (
    `$(curl -s -X POST ${KEYCLOAK}/realms/ai-platform/protocol/openid-connect/token -d grant_type=password -d client_id=ai-platform-web ` +
    `-d username=${user} --data-urlencode password='${password(user)}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')`
  );
}

/** 資料庫查詢（docker compose exec postgres psql，唯讀查詢） */
export function psqlCmd(sql: string): string {
  const q = sql.replace(/(["$`\\])/g, '\\$1');
  return `docker compose -p ${COMPOSE_PROJECT} -f compose.yaml exec -T postgres psql -U platform -d platform -c "${q}"`;
}

// ---------------------------------------------------------------- 情境紀錄

const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n').find((l) => l.trim()) ?? String(e);

/** 一個情境的存證：<EVIDENCE_DIR>/<代號>/NN-描述.png 與 紀錄.txt，最後寫「結果：…」一行 */
export class Scenario {
  private n = 0;
  private partials: string[] = [];
  private error: unknown = null;
  readonly dir: string;

  constructor(readonly tc: string, title: string) {
    this.dir = path.join(EVIDENCE_DIR, tc);
    fs.mkdirSync(this.dir, { recursive: true });
    // 重跑：舊截圖刪掉、舊紀錄改名保留
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith('.png')) fs.rmSync(path.join(this.dir, f));
    }
    const rec = path.join(this.dir, '紀錄.txt');
    if (fs.existsSync(rec)) fs.renameSync(rec, path.join(this.dir, `紀錄-前次-${Date.now()}.txt`));
    this.log(`===== 情境 ${tc}：${title} =====`);
  }

  log(line: string) {
    note(this.tc, line);
  }

  /** 截圖＋紀錄一行。focus：先捲到該元素；full：整頁截圖 */
  async step(page: Page, desc: string, line?: string, opts: { focus?: Locator; full?: boolean } = {}) {
    this.n += 1;
    const id = String(this.n).padStart(2, '0');
    if (opts.focus) await opts.focus.first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(this.dir, `${id}-${safe(desc)}.png`), fullPage: !!opts.full });
    this.log(`步驟 ${id} ${desc}${line ? `：${line}` : ''}`);
  }

  /** 終端機指令：指令與輸出寫進紀錄.txt */
  shell(label: string, cmd: string, opts: { cwd?: string; timeout?: number } = {}) {
    const r = shellRaw(cmd, opts.cwd ?? REPO, opts.timeout);
    fs.appendFileSync(path.join(this.dir, '紀錄.txt'), `----- ${label}\n$ ${cmd}\n${r.out.trimEnd()}\n（結束碼 ${r.code}）\n`);
    console.log(`[${this.tc}] ${label}：結束碼 ${r.code}`);
    return r;
  }

  /** 資料庫查詢：先用 docker compose exec，失敗時改用 docker exec（同一個容器） */
  psql(label: string, sql: string) {
    const r = this.shell(label, psqlCmd(sql), { cwd: COMPOSE_DIR });
    if (r.code === 0) return r;
    const q = sql.replace(/(["$`\\])/g, '\\$1');
    return this.shell(
      `${label}（改用 docker exec）`,
      `docker exec $(docker ps -q -f label=com.docker.compose.project=${COMPOSE_PROJECT} -f label=com.docker.compose.service=postgres) psql -U platform -d platform -c "${q}"`,
    );
  }

  /** 與預期不同但不中止的情況（結果判為部分通過） */
  partial(reason: string) {
    this.partials.push(reason);
    this.log(`部分通過的原因：${reason}`);
  }

  /** 執行情境本體，最後無論成敗都清理並寫結果 */
  async run(body: () => Promise<string>, cleanup: () => Promise<void>) {
    let summary = '';
    try {
      summary = await body();
    } catch (e) {
      this.error = e;
      throw e;
    } finally {
      try {
        await cleanup();
      } catch (e) {
        this.log(`清理時發生錯誤：${firstLine(e)}`);
      }
      this.finish(summary);
    }
  }

  private finish(summary: string) {
    const soft = test.info().errors.map((e) => (e.message ?? '').split('\n').find((l) => l.trim()) ?? '');
    let line: string;
    if (this.error) line = `結果：未通過 — ${firstLine(this.error)}`;
    else if (soft.length) line = `結果：部分通過 — ${soft.length} 項檢查與預期不同：${soft.join('；')}${this.partials.length ? `；${this.partials.join('；')}` : ''}`;
    else if (this.partials.length) line = `結果：部分通過 — ${this.partials.join('；')}`;
    else line = `結果：通過 — ${summary}`;
    this.log(line.replace(/\u001b\[[0-9;]*m/g, ''));
  }
}

// ---------------------------------------------------------------- 瀏覽器

/** 每個帳號一個獨立視窗（等同無痕視窗） */
export async function openAs(browser: Browser, user: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, user);
  return { ctx, page };
}

/** 佇列順序頁：某佇列卡片與表格中某工作的那一列 */
export function queueCard(page: Page, q: string) {
  return page.locator('section').filter({ has: page.locator(`h2#queue-${q}`) });
}
export function queueRow(page: Page, q: string, id: number) {
  return page
    .getByRole('table', { name: `佇列 ${q}` })
    .locator('tbody tr')
    .filter({ has: page.getByRole('rowheader', { name: String(id), exact: true }) });
}
/** 佇列表格每一列的「順序」欄與工作 ID（畫面上的先後） */
export async function queueTableOrder(page: Page, q: string): Promise<{ order: string; id: number }[]> {
  const rows = page.getByRole('table', { name: `佇列 ${q}` }).locator('tbody tr');
  const out: { order: string; id: number }[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    out.push({ order: (await r.locator('td').first().innerText()).trim(), id: Number((await r.locator('th').innerText()).trim()) });
  }
  return out;
}

export async function refreshQueuePage(page: Page) {
  await page.getByRole('button', { name: '重新整理', exact: true }).first().click();
  await page.waitForLoadState('networkidle');
}

/** 訓練紀錄：某次訓練的那一列（依「展開／收合訓練 #N」按鈕找） */
export function runRow(page: Page, runId: number) {
  return page
    .getByRole('table', { name: '訓練清單' })
    .locator('tbody tr')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^(展開|收合)訓練 #${runId}$`) }) });
}

export { expect };
