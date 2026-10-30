import { execFileSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';

// 語言模型（E1–E5）手冊情境共用：示範專案、文件、鏡頭外準備。
// 鏡頭外準備（白名單登記、清掉上次留下的資料）用 scratchpad 的 prep.py（LLM_PREP 指定；沒設就略過）。

export const PROJECT = '手冊-院內知識問答';
export const KB = '院內作業規範';
export const DOCS_DIR = process.env.N_DOCS_DIR || '/mnt/c/Users/skyland/Desktop/workspace/sample-data/M2/documents';
export const DOC_FILES = [
  'registration_flow.html',
  'hand_hygiene.txt',
  'outpatient_hours.pdf',
  'mri_preparation.docx',
  'department_extensions.csv',
  'lab_reference_ranges.json',
];

const PREP =
  process.env.LLM_PREP ||
  '/mnt/c/Users/skyland/AppData/Local/Temp/claude/C--Users-skyland-Desktop-workspace/7ee039bd-e7c6-4091-9359-664088975d1c/scratchpad/manual/LLM/prep.py';

/** 鏡頭外準備（python3 prep.py <step>），回傳輸出 */
export function prep(step: string): string {
  const dir = PREP.replace(/\/[^/]+$/, '');
  const out = execFileSync('python3', ['-I', PREP, step], { cwd: dir, encoding: 'utf8' });
  console.log(`[prep ${step}] ${out.trim()}`);
  return out;
}

/** 表格中列標題（th）＝ name 的那一列 */
export function rowOf(table: Locator, name: string) {
  return table.locator('tbody tr').filter({ has: table.page().getByRole('rowheader', { name, exact: true }) });
}

export const llmNav = (p: Page) => p.getByRole('navigation', { name: '語言模型分頁' });
export const llmTabLink = (p: Page, name: string) => llmNav(p).getByRole('link', { name, exact: true });
export const sideLink = (p: Page, name: string) => sideNav(p).getByRole('link', { name, exact: true });

/** 等最後一則模型回應出現（或失敗訊息），回傳是否成功 */
export async function waitReply(p: Page, before: number) {
  const replies = p.getByRole('list', { name: '對話內容' }).locator('li[data-role="assistant"]');
  const failed = p.getByTestId('chat-failed');
  await expect
    .poll(async () => (await replies.count()) > before || (await failed.isVisible()), { timeout: 120_000, intervals: [500] })
    .toBe(true);
  if (await failed.isVisible()) throw new Error(`模型沒有回應：${await failed.innerText()}`);
  return replies.last();
}

export const assistantCount = (p: Page) => p.getByRole('list', { name: '對話內容' }).locator('li[data-role="assistant"]').count();

const WEB = process.env.WEB_URL || 'http://localhost:38982';
const KC = process.env.KEYCLOAK || 'http://localhost:38180';

/** 以帳號的 token 呼叫平台 API（鏡頭外查 id 用） */
export async function apiGet<T = unknown>(user: string, p: string): Promise<T> {
  const res = await fetch(`${KC}/realms/ai-platform/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password', client_id: 'ai-platform-web', username: user, password: user === 'admin01' ? 'Admin01-dev!' : 'Dev-Passw0rd!',
    }),
  });
  const tok = ((await res.json()) as { access_token: string }).access_token;
  const r = await fetch(`${WEB}${p}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`GET ${p} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function llmBase() {
  const list = await apiGet<{ id: number; name: string }[]>('admin01', '/api/admin/projects');
  return `/api/projects/${list.find((x) => x.name === PROJECT)!.id}/llm`;
}
