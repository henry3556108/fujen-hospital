// 各模組模擬 API 共用：驗證、專案權限、回應形狀、跟著 mockDb() 重置的模組狀態。
import { HttpResponse, type JsonBodyType } from 'msw';
import { PERMISSIONS, type Permission, type Project, type User } from '../api/types';
import type { MockDb } from './data';
import { mockDb } from './handlers';

export const API = '*/api';
export const json = (body: unknown, status = 200) => HttpResponse.json(body as JsonBodyType, { status });
export const detail = (status: number, message: string) => json({ detail: message }, status);
export const noContent = () => new HttpResponse(null, { status: 204 });

export function validation(field: string, msg: string, type: string, input: unknown = null) {
  return json({ detail: [{ type, loc: ['body', field], msg, input }] }, 422);
}

/** 函式庫錯誤（結構式資料）：422 {"detail": {code, message, detail}} */
export function tabularError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return json({ detail: { code, message, detail: extra } }, 422);
}

export function authUser(request: Request): User | Response {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return detail(401, '未登入');
  const m = /^test-token:(.+)$/.exec(auth.slice(7));
  if (!m) return detail(401, '登入已失效，請重新登入');
  const user = mockDb().users.find((u) => u.username === m[1]);
  if (!user) return detail(401, '帳號不存在或已停用');
  return user;
}

export function requireAdmin(request: Request): User | Response {
  const u = authUser(request);
  if (u instanceof Response) return u;
  if (u.account_type !== 'admin') return detail(403, '需要 Admin 權限');
  return u;
}

export interface ProjectCtx {
  user: User;
  project: Project;
}

/** 與 platform/api 的 require_project_permission 相同：非 Admin 查不存在的專案回 403，Admin 回 404。 */
export function requireProject(request: Request, projectId: unknown, permission: Permission): ProjectCtx | Response {
  const user = authUser(request);
  if (user instanceof Response) return user;
  const db = mockDb();
  const project = db.projects.find((p) => p.id === Number(projectId));
  if (user.account_type === 'admin') {
    if (!project) return detail(404, `找不到專案 ${projectId}`);
    return { user, project };
  }
  const membership = project && db.memberships.find((m) => m.project_id === project.id && m.user_id === user.id);
  const granted: readonly Permission[] = membership ? membership.permissions : [];
  if (!project || !granted.includes(permission) || !PERMISSIONS.includes(permission)) {
    return json({ detail: { code: 'forbidden', permission, message: `你沒有 ${permission} 權限` } }, 403);
  }
  return { user, project };
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await request.json()) as unknown;
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 模組狀態掛在目前的 mockDb() 物件上：resetMockDb() 換掉物件後，下一次存取就回到種子資料。
// 瀏覽器（dev:mock、Playwright）另外把狀態存進 sessionStorage，重新載入頁面後仍在（同一個分頁內）；
// 這樣「儲存後重新載入仍一致」的流程才測得到。Vitest 不啟用。
const states = new WeakMap<MockDb, Map<string, unknown>>();
const STORAGE_PREFIX = '__AI_PLATFORM_MOCK__.';
let persistent = false;

export function enableMockPersistence(): void {
  persistent = true;
}

function bagFor(db: MockDb): Map<string, unknown> {
  let bag = states.get(db);
  if (!bag) {
    bag = new Map();
    states.set(db, bag);
  }
  return bag;
}

export function moduleState<T>(key: string, seed: () => T): T {
  const bag = bagFor(mockDb());
  if (!bag.has(key)) {
    let value: T | null = null;
    if (persistent) {
      try {
        const saved = window.sessionStorage.getItem(STORAGE_PREFIX + key);
        if (saved) value = JSON.parse(saved) as T;
      } catch {
        value = null;
      }
    }
    bag.set(key, value ?? seed());
  }
  return bag.get(key) as T;
}

/** 每次模擬回應後呼叫：把各模組狀態寫回 sessionStorage。 */
export function persistModuleStates(): void {
  if (!persistent) return;
  for (const [key, value] of bagFor(mockDb())) {
    try {
      window.sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // 容量不足時放棄保存，下次重新載入回到種子資料
    }
  }
}

export const isoNow = () => new Date().toISOString();
