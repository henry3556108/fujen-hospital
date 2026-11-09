import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { EVIDENCE_DIR, P1, clickMenu, login, note, useProject } from './helpers';
import { adminTab } from './ops';

// 新功能情境 B（LLM）與 C（MONAI 自動標註）共用：情境紀錄與截圖、API 呼叫、終端機指令、docker compose。
// 在 platform/web 執行；GATEWAY、KEYCLOAK 預設為本機 compose 環境（9080、8080）。

export const REPO = path.resolve(process.cwd(), '../..');
export const DEPLOY_DIR = path.join(REPO, 'platform/deploy/local');
export const GATEWAY = process.env.GATEWAY || 'http://localhost:9080';
export const KEYCLOAK = process.env.KEYCLOAK || 'http://localhost:8080';
export const DOCS_DIR = process.env.N_DOCS_DIR || '/mnt/c/Users/skyland/Desktop/workspace/sample-data/M2/documents';
export const CT_DIR = process.env.AUTOLABEL_CT_DIR || '/mnt/c/Users/skyland/Desktop/workspace/sample-data/M2/ct-spleen';

// 與 scratchpad/env.sh 相同的完整 compose 組合；C2 只加減 compose.monai.yaml，其他服務不受影響
const BASE_COMPOSE =
  process.env.N_COMPOSE_FILE ||
  'compose.yaml:compose.kind.yaml:compose.training.yaml:compose.labeling.yaml:compose.web.yaml:compose.fhir.yaml:compose.compliance.yaml:compose.llm.yaml:compose.ollama.yaml';
export const composeEnv = (monai = true) => ({
  COMPOSE_FILE: monai ? `${BASE_COMPOSE}:compose.monai.yaml` : BASE_COMPOSE,
  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME || 'ai-platform',
});

const PASSWORDS: Record<string, string> = { admin01: 'Admin01-dev!' };
for (const pair of (process.env.KIT_PASSWORDS ?? '').split(',').filter(Boolean)) {
  const [u, p] = pair.split('=');
  PASSWORDS[u] = p;
}
const password = (user: string) => PASSWORDS[user] ?? 'Dev-Passw0rd!';

const ANSI = /\x1b\[[0-9;]*m/g;
export const firstLine = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
export { oneLine };

// ---------------------------------------------------------------- 情境紀錄

export class Scenario {
  private n = 0;
  readonly dir: string;
  readonly deviations: string[] = [];
  readonly partial: string[] = [];
  private contexts: BrowserContext[] = [];

  constructor(readonly tc: string, title: string) {
    this.dir = path.join(EVIDENCE_DIR, tc);
    fs.mkdirSync(this.dir, { recursive: true });
    // 重跑時先清掉上一輪的截圖，避免編號不同的舊圖混在一起；紀錄.txt 保留並加分隔線
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.png')) fs.rmSync(path.join(this.dir, f));
    this.raw(`\n===== ${new Date().toLocaleString('zh-TW', { hour12: false })} 開始：${tc} ${title} =====`);
  }

  log(line: string) {
    note(this.tc, line);
  }

  /** 原樣寫入紀錄.txt（多行輸出） */
  raw(text: string) {
    fs.appendFileSync(path.join(this.dir, '紀錄.txt'), text.endsWith('\n') ? text : `${text}\n`);
  }

  /** 截圖（可先把某個元素捲到畫面中、或整頁），回傳檔名 */
  async snap(page: Page, desc: string, opts: { focus?: Locator; full?: boolean } = {}) {
    this.n += 1;
    const file = `${String(this.n).padStart(2, '0')}-${desc.replace(/[\\/:*?"<>|\s]+/g, '_')}.png`;
    if (opts.focus) await opts.focus.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.screenshot({ path: path.join(this.dir, file), fullPage: !!opts.full });
    return file;
  }

  /** 一個步驟：截圖並寫一行紀錄「步驟 X｜描述：補充〔截圖〕」 */
  async step(page: Page, label: string, desc: string, opts: { line?: string; focus?: Locator; full?: boolean } = {}) {
    const file = await this.snap(page, desc, opts);
    this.log(`${label}｜${desc}${opts.line ? `：${opts.line}` : ''}〔${file}〕`);
  }

  /** 與文件不符但可繼續的檢查：失敗時記下差異並標成 soft 失敗 */
  async soft(desc: string, fn: () => unknown): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      const msg = firstLine(e);
      this.deviations.push(`${desc}（${msg}）`);
      this.log(`【差異】${desc}：${msg}`);
      expect.soft(false, `${this.tc} ${desc}：${msg}`).toBe(true);
      return false;
    }
  }

  /** 無法完整驗證的部分（部分通過的原因） */
  partialBecause(reason: string) {
    this.partial.push(reason);
    this.log(`【部分驗證】${reason}`);
  }

  async open(browser: Browser, user: string, project = P1): Promise<Page> {
    const ctx = await browser.newContext();
    this.contexts.push(ctx);
    const page = await ctx.newPage();
    await login(page, user);
    await useProject(page, project);
    return page;
  }

  /** 執行情境本體，最後一定執行清理並寫「結果：…」 */
  async run(body: () => Promise<string>, cleanup?: () => Promise<void>) {
    let summary = '';
    let error: unknown = null;
    try {
      summary = await body();
    } catch (e) {
      error = e;
      this.log(`錯誤：${firstLine(e)}`);
      for (const ctx of this.contexts) {
        for (const p of ctx.pages()) await this.snap(p, '錯誤當下畫面', { full: true }).catch(() => undefined);
      }
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (e) {
          this.log(`清理失敗（請手動處理）：${firstLine(e)}`);
        }
      }
      for (const ctx of this.contexts) await ctx.close().catch(() => undefined);
      let verdict: string;
      if (error) verdict = `未通過 — ${firstLine(error)}${this.deviations.length ? `；另有差異：${this.deviations.join('；')}` : ''}`;
      else if (this.deviations.length || this.partial.length)
        verdict = `部分通過 — ${[summary, ...this.partial, ...this.deviations.map((d) => `差異：${d}`)].filter(Boolean).join('；')}`;
      else verdict = `通過 — ${summary}`;
      this.log(`結果：${verdict}`);
    }
    if (error) throw error;
  }
}

// ---------------------------------------------------------------- 網頁操作

/** 舊分頁名稱 → 改版後「大型語言模型」的分頁名稱 */
const LLM_TAB_NEW: Record<string, string> = {
  Playground: 'LLM Playground',
  模型管理: '模型',
  'Prompt 範本': 'Prompt Template',
  知識庫: 'RAG 知識庫',
  '發布 API': '內部服務',
  工作流: 'LangGraph 工作流',
  Wiki: 'Wiki 知識庫',
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 大型語言模型頁內分頁的 navigation 名稱（新舊都認得） */
const LLM_NAV = /LLM 功能分頁|大型語言模型/;

/**
 * 大型語言模型的頁內分頁（沿用舊分頁名稱呼叫；新舊名稱都認得）。
 * 不在 /llm 時先從「功能目錄」點契約入口「LLM No-code 開發」進入。
 */
export async function llmTab(page: Page, tab: string) {
  if (!/\/llm(\/|$)/.test(new URL(page.url()).pathname)) await clickMenu(page, 'LLM No-code 開發');
  await expect(page).toHaveURL(/\/llm(\/|$)/);
  const name = new RegExp(`^\\s*(${esc(LLM_TAB_NEW[tab] ?? tab)}|${esc(tab)})\\s*$`);
  const nav = page.getByRole('navigation', { name: LLM_NAV });
  await nav.getByRole('link', { name }).or(nav.getByRole('tab', { name })).first().click();
  await page.waitForLoadState('networkidle');
}

/** 管理區「稽核與審核」→「模型下載審核」：LLM 模型下載申請的待審核表格 */
export async function llmApprovals(page: Page) {
  await adminTab(page, '模型下載審核');
  return page.getByRole('table', { name: '待審核的下載申請' });
}

/** 下拉選單選「文字包含 text」的選項（選項文字含有動態數字時用） */
export async function selectContaining(select: Locator, text: string) {
  await expect(select.locator('option', { hasText: text }).first()).toBeAttached({ timeout: 30_000 });
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value');
  await select.selectOption(value ?? '');
}

/** 表格中「列標題（th）＝ name」的那一列 */
export function rowOf(table: Locator, name: string) {
  return table.locator('tbody tr').filter({ has: table.page().getByRole('rowheader', { name, exact: true }) });
}

/** 行內成功訊息（role=status 的 Alert） */
export const okMsg = (scope: Page | Locator, text: string | RegExp) => scope.getByRole('status').filter({ hasText: text });

/** 等「成功訊息」或錯誤訊息（role=alert）其中一個出現；回傳是否成功與畫面上的訊息文字（記錄實際行為用） */
export async function outcome(scope: Locator, okText: string, timeout: number): Promise<{ ok: boolean; text: string }> {
  const good = okMsg(scope, okText);
  const bad = scope.getByRole('alert');
  await expect(good.or(bad).first()).toBeVisible({ timeout });
  if (await good.isVisible()) return { ok: true, text: oneLine(await good.innerText()) };
  return { ok: false, text: oneLine(await bad.first().innerText()) };
}

// ---------------------------------------------------------------- API

const tokens = new Map<string, { token: string; until: number }>();

export async function token(user: string): Promise<string> {
  const cached = tokens.get(user);
  if (cached && cached.until > Date.now()) return cached.token;
  const res = await fetch(`${KEYCLOAK}/realms/ai-platform/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'ai-platform-web', username: user, password: password(user) }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error(`取得 ${user} 的 token 失敗：HTTP ${res.status}`);
  tokens.set(user, { token: body.access_token, until: Date.now() + ((body.expires_in ?? 300) - 30) * 1000 });
  return body.access_token;
}

export interface ApiResult {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export async function api(user: string | null, method: string, url: string, body?: unknown, form?: FormData): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (user) headers.Authorization = `Bearer ${await token(user)}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GATEWAY}${url}`, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

let projectIds: Record<string, number> | null = null;
export async function projectId(name = P1): Promise<number> {
  if (!projectIds) {
    const r = await api('admin01', 'GET', '/api/admin/projects');
    projectIds = Object.fromEntries((r.json as { id: number; name: string }[]).map((p) => [p.name, p.id]));
  }
  const id = projectIds[name];
  if (!id) throw new Error(`找不到專案 ${name}`);
  return id;
}

// ---------------------------------------------------------------- 終端機指令

export interface ShResult {
  out: string;
  code: number;
}

/** 執行 bash 指令並把「$ 指令、輸出、結束碼」寫進紀錄.txt。display 用來遮掉 token 等不該寫進紀錄的內容。 */
export function sh(
  s: Scenario,
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; display?: string; timeoutMs?: number } = {},
): Promise<ShResult> {
  const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`, ...opts.env };
  s.log(`執行指令：${opts.display ?? cmd}`);
  return new Promise((resolve) => {
    exec(
      cmd,
      { cwd: opts.cwd ?? REPO, env, shell: '/bin/bash', maxBuffer: 64 << 20, timeout: opts.timeoutMs ?? 10 * 60_000 },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`;
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        s.raw(`$ ${opts.display ?? cmd}\n${out.trimEnd()}\n（結束碼 ${code}）`);
        resolve({ out, code });
      },
    );
  });
}

/** 在 platform/deploy/local 以完整的 compose 組合執行 docker compose（monai=false 時拿掉 compose.monai.yaml） */
export function dc(s: Scenario, args: string, opts: { monai?: boolean; timeoutMs?: number } = {}) {
  const env = composeEnv(opts.monai ?? true);
  return sh(s, `docker compose ${args}`, {
    cwd: DEPLOY_DIR,
    env,
    display: `cd platform/deploy/local && COMPOSE_FILE=${env.COMPOSE_FILE} docker compose ${args}`,
    timeoutMs: opts.timeoutMs,
  });
}

// ---------------------------------------------------------------- LLM 資料準備與清理（API）

export const llmBase = async () => `/api/projects/${await projectId()}/llm`;

/** 模型回到「沒登記、沒下載」：處理進行中的申請、卸載並刪除模型、移出白名單 */
export async function resetModel(s: Scenario, name: string, opts: { keepWhitelist?: boolean } = {}) {
  const base = await llmBase();
  const open = ((await api('admin01', 'GET', '/api/admin/llm/downloads')).json as { id: number; name: string; status: string }[]).filter(
    (d) => d.name === name && ['pending', 'approved', 'downloading'].includes(d.status),
  );
  for (const d of open) {
    if (d.status === 'pending') {
      const r = await api('admin01', 'POST', `/api/admin/llm/downloads/${d.id}/reject`, { reason: '新功能測試前清理' });
      s.log(`清理：駁回上次留下的申請 #${d.id} → HTTP ${r.status}`);
      continue;
    }
    if (d.status === 'approved') {
      const r = await api('admin01', 'POST', `${base}/models/downloads/${d.id}/execute`, { token: null });
      s.log(`清理：上次核准未下載的申請 #${d.id} 先執行完 → HTTP ${r.status}`);
    }
    for (let i = 0; i < 200; i++) {
      const now = ((await api('admin01', 'GET', '/api/admin/llm/downloads')).json as { id: number; status: string }[]).find((x) => x.id === d.id);
      if (!now || now.status !== 'downloading') break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const model = ((await api('admin01', 'GET', `${base}/models/catalog`)).json as { name: string; installed: boolean; loaded: boolean }[]).find(
    (m) => m.name === name,
  );
  if (model?.loaded) s.log(`清理：卸載 ${name} → HTTP ${(await api('admin01', 'POST', `${base}/models/${name}/unload`)).status}`);
  if (model?.installed) s.log(`清理：刪除模型 ${name} → HTTP ${(await api('admin01', 'DELETE', `${base}/models/${name}`)).status}`);
  if (model && !opts.keepWhitelist) s.log(`清理：移出白名單 ${name} → HTTP ${(await api('admin01', 'DELETE', `/api/admin/llm/whitelist/${name}`)).status}`);
}

export interface Kb {
  id: number;
  name: string;
  documents: number;
  chunks: number;
}

export async function kbsNamed(name: string): Promise<Kb[]> {
  const r = await api('ca01', 'GET', `${await llmBase()}/knowledge-bases`);
  return (r.json as Kb[]).filter((k) => k.name === name);
}

export async function deleteKbs(s: Scenario, name: string) {
  for (const k of await kbsNamed(name)) {
    const r = await api('ca01', 'DELETE', `${await llmBase()}/knowledge-bases/${k.id}`);
    s.log(`清理：刪除知識庫「${name}」(#${k.id}) → HTTP ${r.status}`);
  }
}

export const DOC_FILES = [
  'registration_flow.html',
  'hand_hygiene.txt',
  'outpatient_hours.pdf',
  'mri_preparation.docx',
  'department_extensions.csv',
  'lab_reference_ranges.json',
];

/** B6、B7 單獨執行時的前提：知識庫存在且有文件（沒有就以 API 建立並上傳） */
export async function ensureKb(s: Scenario, name: string): Promise<Kb> {
  const found = (await kbsNamed(name)).find((k) => k.documents > 0);
  if (found) {
    s.log(`前提：知識庫「${name}」已存在（#${found.id}，${found.documents} 份文件、${found.chunks} 個片段）`);
    return found;
  }
  await deleteKbs(s, name);
  const base = await llmBase();
  const kb = await api('ca01', 'POST', `${base}/knowledge-bases`, { name });
  expect(kb.status, kb.text).toBe(201);
  const form = new FormData();
  for (const f of DOC_FILES) form.append('files', new Blob([fs.readFileSync(path.join(DOCS_DIR, f))]), f);
  const up = await api('ca01', 'POST', `${base}/knowledge-bases/${kb.json.id}/documents`, undefined, form);
  expect(up.status, up.text).toBe(201);
  s.log(`前提：以 API 建立知識庫「${name}」(#${kb.json.id}) 並上傳 ${DOC_FILES.length} 份文件：${JSON.stringify(up.json.counts)}`);
  return (await kbsNamed(name))[0];
}

/** 與平台相同的內容 hash：依檔名排序，檔名＋\0＋檔案 sha256 一起算（app/llm/registry 的 content_hash） */
export function contentHash(folder: string): string {
  const digest = crypto.createHash('sha256');
  for (const name of fs.readdirSync(folder).filter((f) => f !== 'manifest.json').sort()) {
    const inner = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest();
    digest.update(Buffer.concat([Buffer.from(name), Buffer.from([0]), inner]));
  }
  return digest.digest('hex');
}

// ---------------------------------------------------------------- Playground

export interface Reply {
  text: string;
  sources: string;
  seconds: string;
}

/** 在 Playground 的「訊息」輸入問題、按「送出」，等模型回應；回傳回應內容與出處、回應時間那幾行 */
export async function ask(s: Scenario, page: Page, question: string, label: string, how: 'button' | 'enter' = 'button'): Promise<Reply> {
  const log = page.getByRole('list', { name: '對話內容' });
  const replies = log.locator('li[data-role="assistant"]');
  const failed = page.getByTestId('chat-failed');
  const before = await replies.count();
  const input = page.getByLabel('訊息', { exact: true }); // 不加 exact 會同時對到 aria-label「送出訊息」的表單
  await input.fill(question);
  if (how === 'enter') await input.press('Enter');
  else await page.getByRole('button', { name: '送出', exact: true }).click();
  const pending = log.locator('li[data-role="pending"]');
  if (await pending.isVisible().catch(() => false)) await s.step(page, label, '送出後模型回應中', { line: question, focus: pending });
  await expect
    .poll(async () => (await replies.count()) > before || (await failed.isVisible()), { timeout: 240_000, intervals: [1000] })
    .toBe(true);
  if (await failed.isVisible()) throw new Error(`模型沒有回應：${oneLine(await failed.innerText())}`);
  const last = replies.last();
  const paras = (await last.locator('p').allInnerTexts()).map((t) => t.trim());
  // 改版後出處是「參考來源：」底下的卡片清單（每張「檔名 · 段落 N」），回應時間在「時間 · 回應時間 N 秒」那一行；
  // 仍整理成「出處：檔名 · 段落 N、…」與「回應時間 N 秒」，紀錄格式不變
  const names = (await last.getByRole('list', { name: '參考來源' }).locator('.llm-source__name').allInnerTexts()).map(oneLine);
  return {
    text: paras[0] ?? '',
    sources: names.length ? `出處：${names.join('、')}` : '',
    seconds: paras.map((p) => /回應時間 [\d.]+ 秒/.exec(p)?.[0]).find(Boolean) ?? '',
  };
}

export { clickMenu };
