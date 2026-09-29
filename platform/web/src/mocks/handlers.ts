// MSW 模擬 platform/api：路徑、狀態碼與錯誤形狀都照後端（401/403/404/409/422）。
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Permission, type Role, type User } from '../api/types';
import { meFor, seedDb, type MockDb } from './data';
import { createLabelingHandlers } from './labeling';
import { createInferenceHandlers } from './inference';

let db: MockDb = seedDb();
export function resetMockDb(): void {
  db = seedDb();
}
export function mockDb(): MockDb {
  return db;
}

const API = '*/api';
const json = (body: JsonBodyType, status = 200) => HttpResponse.json(body, { status });
const detail = (status: number, message: string) => json({ detail: message }, status);
const noContent = () => new HttpResponse(null, { status: 204 });

function validation(loc: string[], msg = 'String should have at least 1 character', type = 'string_too_short') {
  return json({ detail: [{ type, loc: ['body', ...loc], msg, input: '' }] }, 422);
}

function authUser(request: Request): User | Response {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return detail(401, '未登入');
  const token = auth.slice(7);
  const m = /^test-token:(.+)$/.exec(token);
  if (!m) return detail(401, '登入已失效，請重新登入');
  const user = db.users.find((u) => u.username === m[1]);
  if (!user) return detail(401, '帳號不存在或已停用');
  return user;
}

function requireAdmin(request: Request): User | Response {
  const u = authUser(request);
  if (u instanceof Response) return u;
  if (u.account_type !== 'admin') return detail(403, '需要 Admin 權限');
  return u;
}

const adminCount = () => db.users.filter((u) => u.account_type === 'admin').length;

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const handlers = [
  http.get(`${API}/me`, ({ request }) => {
    const u = authUser(request);
    if (u instanceof Response) return u;
    return json(meFor(db, u.username) as unknown as JsonBodyType);
  }),

  // ---- 專案 ----
  http.get(`${API}/admin/projects`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    return json(db.projects as unknown as JsonBodyType);
  }),
  http.post(`${API}/admin/projects`, async ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const b = await body(request);
    const name = typeof b.name === 'string' ? b.name : '';
    if (!name) return validation(['name']);
    if (db.projects.some((p) => p.name === name)) return detail(409, `專案名稱「${name}」已存在`);
    const p = {
      id: db.nextProjectId++,
      name,
      description: typeof b.description === 'string' ? b.description : '',
      gpu_group: typeof b.gpu_group === 'string' && b.gpu_group ? b.gpu_group : null,
    };
    db.projects.push(p);
    return json(p, 201);
  }),
  http.patch(`${API}/admin/projects/:id`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const p = db.projects.find((x) => x.id === Number(params.id));
    if (!p) return detail(404, `找不到 projects ${params.id}`);
    const b = await body(request);
    if ('name' in b) {
      if (typeof b.name !== 'string' || !b.name) return validation(['name']);
      if (db.projects.some((x) => x.name === b.name && x.id !== p.id)) return detail(409, `專案名稱「${b.name}」已存在`);
      p.name = b.name;
    }
    if (typeof b.description === 'string') p.description = b.description;
    if ('gpu_group' in b) p.gpu_group = typeof b.gpu_group === 'string' && b.gpu_group ? b.gpu_group : null;
    return json(p);
  }),
  http.delete(`${API}/admin/projects/:id`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const id = Number(params.id);
    if (!db.projects.some((p) => p.id === id)) return detail(404, `找不到 projects ${id}`);
    db.projects = db.projects.filter((p) => p.id !== id);
    db.memberships = db.memberships.filter((m) => m.project_id !== id);
    return noContent();
  }),

  // ---- 帳號 ----
  http.get(`${API}/admin/users`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    return json(db.users as unknown as JsonBodyType);
  }),
  http.post(`${API}/admin/users`, async ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const b = await body(request);
    if (typeof b.username !== 'string' || !b.username) return validation(['username']);
    if (typeof b.password !== 'string' || !b.password) return validation(['password']);
    if (b.account_type !== 'admin' && b.account_type !== 'user')
      return validation(['account_type'], "Input should be 'admin' or 'user'", 'enum');
    if (db.users.some((u) => u.username === b.username)) return detail(409, `帳號「${b.username}」已存在`);
    const u: User = { id: db.nextUserId++, username: b.username, account_type: b.account_type };
    db.users.push(u);
    db.passwords[u.id] = b.password;
    return json(u as unknown as JsonBodyType, 201);
  }),
  http.patch(`${API}/admin/users/:id`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const u = db.users.find((x) => x.id === Number(params.id));
    if (!u) return detail(404, `找不到 users ${params.id}`);
    const b = await body(request);
    if (b.account_type !== 'admin' && b.account_type !== 'user')
      return validation(['account_type'], "Input should be 'admin' or 'user'", 'enum');
    if (u.account_type === 'admin' && b.account_type === 'user' && adminCount() <= 1)
      return detail(409, '至少要保留 1 個 Admin');
    u.account_type = b.account_type;
    return json(u as unknown as JsonBodyType);
  }),
  http.delete(`${API}/admin/users/:id`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const u = db.users.find((x) => x.id === Number(params.id));
    if (!u) return detail(404, `找不到 users ${params.id}`);
    if (u.id === a.id) return detail(409, '不能刪除自己的帳號');
    if (u.account_type === 'admin' && adminCount() <= 1) return detail(409, '至少要保留 1 個 Admin');
    db.users = db.users.filter((x) => x.id !== u.id);
    db.memberships = db.memberships.filter((m) => m.user_id !== u.id);
    return noContent();
  }),
  http.post(`${API}/admin/users/:id/reset-password`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const u = db.users.find((x) => x.id === Number(params.id));
    if (!u) return detail(404, `找不到 users ${params.id}`);
    const b = await body(request);
    if (typeof b.new_password !== 'string' || !b.new_password) return validation(['new_password']);
    db.passwords[u.id] = b.new_password;
    return noContent();
  }),

  // ---- 專案成員 ----
  http.put(`${API}/admin/projects/:pid/members/:uid`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    const uid = Number(params.uid);
    if (!db.projects.some((p) => p.id === pid)) return detail(404, `找不到 projects ${pid}`);
    if (!db.users.some((u) => u.id === uid)) return detail(404, `找不到 users ${uid}`);
    const b = await body(request);
    if (!ROLES.includes(b.role as Role)) return validation(['role'], 'Input should be a valid role', 'enum');
    let permissions: Permission[];
    if (b.permissions === null || b.permissions === undefined) {
      permissions = [...DEFAULT_ROLE_PERMISSIONS[b.role as Role]];
    } else if (Array.isArray(b.permissions) && b.permissions.every((x) => PERMISSIONS.includes(x as Permission))) {
      permissions = [...new Set(b.permissions as Permission[])];
    } else {
      return validation(['permissions'], 'Input should be a valid permission', 'enum');
    }
    const existing = db.memberships.find((m) => m.project_id === pid && m.user_id === uid);
    const m = { project_id: pid, user_id: uid, role: b.role as Role, permissions: permissions.sort() };
    if (existing) Object.assign(existing, m);
    else db.memberships.push(m);
    return json(m);
  }),
  http.delete(`${API}/admin/projects/:pid/members/:uid`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    const uid = Number(params.uid);
    const before = db.memberships.length;
    db.memberships = db.memberships.filter((m) => !(m.project_id === pid && m.user_id === uid));
    if (db.memberships.length === before) return detail(404, `找不到成員資格：使用者 ${uid} 不在專案 ${pid}`);
    return noContent();
  }),
  // WP5a 影像標註：定義在 mocks/labeling.ts
  ...createLabelingHandlers(() => db),
  // WP5b 推論服務管理：定義在 mocks/inference.ts
  ...createInferenceHandlers(() => db),
];
