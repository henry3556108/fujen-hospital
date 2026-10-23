// MSW 模擬 platform/api：路徑、狀態碼與錯誤形狀都照後端（401/403/404/409/422）。
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type Permission, type Role, type User } from '../api/types';
import { meFor, seedDb, type MockDb } from './data';
import { fhirHandlers, resetFhirMock } from './fhir';
import { createLabelingHandlers } from './labeling';
import { createInferenceHandlers } from './inference';
import { llmHandlers, resetLlmMock } from './llm';
import { trainingHandlers } from './training';
import { trainingStageHandlers } from './trainingStages';
import { mockStudyCounts } from './imaging';
import { mockGpuGroupCount, mockJobs } from './scheduling';
import { mockDatasetCounts } from './tabular';
import { createOverviewHandlers } from './overview';

let db: MockDb = seedDb();
export function resetMockDb(): void {
  db = seedDb();
  resetFhirMock();
  resetLlmMock();
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


/** 模擬稽核：與 platform/api 相同的欄位；來源固定為瀏覽器所在的 127.0.0.1。 */
function audit(actor: User, category: string, action: string, target: string, detail: Record<string, unknown> = {}) {
  db.audit.push({
    id: db.audit.length + 1,
    at: new Date().toISOString(),
    actor: actor.username,
    category,
    action,
    target,
    result: 'success',
    source_ip: '127.0.0.1',
    detail,
  });
}

function groupOut(g: MockDb['labelGroups'][number]) {
  const members = g.member_ids
    .map((id) => db.users.find((u) => u.id === id))
    .filter((u): u is User => !!u)
    .sort((x, y) => x.username.localeCompare(y.username))
    .map((u) => ({ user_id: u.id, username: u.username }));
  const { member_ids: _ids, ...rest } = g;
  return { ...rest, members };
}

const groupsOf = (pid: number) =>
  db.labelGroups
    .filter((g) => g.project_id === pid)
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(groupOut);

function checkGroupMembers(pid: number, ids: number[]): Response | null {
  const missing = ids.filter((id) => !db.users.some((u) => u.id === id));
  if (missing.length) return detail(404, `找不到帳號 ${missing.join(', ')}`);
  const outsiders = ids
    .filter((id) => !db.memberships.some((m) => m.project_id === pid && m.user_id === id))
    .map((id) => db.users.find((u) => u.id === id)!.username)
    .sort();
  const project = db.projects.find((p) => p.id === pid)!;
  if (outsiders.length) return detail(409, `${outsiders.join('、')} 不是專案「${project.name}」的成員，請先在「專案成員」加入`);
  return null;
}

export const handlers = [
  http.get(`${API}/me`, ({ request }) => {
    const u = authUser(request);
    if (u instanceof Response) return u;
    return json(meFor(db, u.username) as unknown as JsonBodyType);
  }),

  http.get(`${API}/admin/dashboard`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const jobs = mockJobs();
    const studies = mockStudyCounts();
    const datasets = mockDatasetCounts();
    const byStatus: Record<string, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    const sum = (m: Map<number, number>) => [...m.values()].reduce((x, y) => x + y, 0);
    return json({
      generated_at: new Date().toISOString(),
      accounts: {
        total: db.users.length,
        admin: db.users.filter((u) => u.account_type === 'admin').length,
        user: db.users.filter((u) => u.account_type === 'user').length,
      },
      projects: db.projects.length,
      memberships: db.memberships.length,
      labeling_groups: db.labelGroups.length,
      labeling_group_members: db.labelGroups.reduce((n, g) => n + g.member_ids.length, 0),
      tabular_datasets: sum(datasets),
      imaging_studies: sum(studies),
      gpu_groups: mockGpuGroupCount(),
      jobs: { total: jobs.length, by_status: byStatus },
      per_project: db.projects.map((p) => ({
        id: p.id,
        name: p.name,
        gpu_group: p.gpu_group,
        members: db.memberships.filter((m) => m.project_id === p.id).length,
        labeling_groups: db.labelGroups.filter((g) => g.project_id === p.id).length,
        tabular_datasets: datasets.get(p.id) ?? 0,
        imaging_studies: studies.get(p.id) ?? 0,
        jobs: jobs.filter((j) => j.project_id === p.id).length,
      })),
    });
  }),

  // ---- 稽核（唯讀） ----
  http.get(`${API}/admin/audit`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const q = new URL(request.url).searchParams;
    const page = Number(q.get('page') ?? 1);
    const size = Number(q.get('page_size') ?? 50);
    if (!(page >= 1) || !(size >= 1 && size <= 200)) return validation(['page'], 'Input should be valid', 'greater_than_equal');
    const category = q.get('category');
    const actor = q.get('actor');
    const action = q.get('action');
    const result = q.get('result');
    const since = q.get('since') ? Date.parse(q.get('since')!) : null;
    const until = q.get('until') ? Date.parse(q.get('until')!) : null;
    if (since !== null && until !== null && until <= since) return detail(422, '結束時間不可早於或等於開始時間');
    const rows = db.audit
      .filter(
        (r) =>
          (!category || r.category === category) &&
          (!actor || r.actor === actor) &&
          (!action || r.action.startsWith(action)) &&
          (!result || r.result === result) &&
          (since === null || Date.parse(r.at) >= since) &&
          (until === null || Date.parse(r.at) < until),
      )
      .sort((x, y) => y.id - x.id);
    return json({ total: rows.length, page, page_size: size, items: rows.slice((page - 1) * size, page * size) });
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
    audit(a, 'project', 'create', `project:${p.id}`, { name: p.name, gpu_group: p.gpu_group });
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
    audit(a, 'project', 'update', `project:${p.id}`, b);
    return json(p);
  }),
  http.delete(`${API}/admin/projects/:id`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const id = Number(params.id);
    if (!db.projects.some((p) => p.id === id)) return detail(404, `找不到 projects ${id}`);
    db.projects = db.projects.filter((p) => p.id !== id);
    db.memberships = db.memberships.filter((m) => m.project_id !== id);
    db.labelGroups = db.labelGroups.filter((g) => g.project_id !== id);
    audit(a, 'project', 'delete', `project:${id}`);
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
    audit(a, 'account', 'create', `user:${u.id}`, { username: u.username, account_type: u.account_type });
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
    audit(a, 'account', 'update', `user:${u.id}`, { account_type: { from: u.account_type, to: b.account_type } });
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
    for (const g of db.labelGroups) g.member_ids = g.member_ids.filter((x) => x !== u.id);
    audit(a, 'account', 'delete', `user:${u.id}`, { username: u.username });
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
    audit(a, 'account', 'reset_password', `user:${u.id}`);
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
    const target = `project:${pid}/user:${uid}`;
    if (!existing) {
      audit(a, 'role', 'assign', target, { role: m.role });
      audit(a, 'permission', 'grant', target, { permissions: m.permissions });
    } else {
      if (existing.role !== m.role) audit(a, 'role', 'change', target, { from: existing.role, to: m.role });
      if ([...existing.permissions].sort().join() !== m.permissions.join())
        audit(a, 'permission', 'change', target, { from: existing.permissions, to: m.permissions });
    }
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
    for (const g of db.labelGroups) if (g.project_id === pid) g.member_ids = g.member_ids.filter((x) => x !== uid);
    audit(a, 'role', 'revoke', `project:${pid}/user:${uid}`);
    return noContent();
  }),
  http.get(`${API}/admin/projects/:pid/members`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    if (!db.projects.some((p) => p.id === pid)) return detail(404, `找不到 projects ${pid}`);
    const rows = db.memberships
      .filter((m) => m.project_id === pid)
      .map((m) => {
        const u = db.users.find((x) => x.id === m.user_id)!;
        return { user_id: u.id, username: u.username, role: m.role, permissions: [...m.permissions].sort() };
      })
      .sort((x, y) => x.username.localeCompare(y.username));
    return json(rows as unknown as JsonBodyType);
  }),

  // ---- 標註群組 ----
  http.get(`${API}/admin/projects/:pid/labeling-groups`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    if (!db.projects.some((p) => p.id === pid)) return detail(404, `找不到專案 ${pid}`);
    return json(groupsOf(pid) as unknown as JsonBodyType);
  }),
  http.post(`${API}/admin/projects/:pid/labeling-groups`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    if (!db.projects.some((p) => p.id === pid)) return detail(404, `找不到專案 ${pid}`);
    const b = await body(request);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return validation(['name']);
    if (db.labelGroups.some((g) => g.project_id === pid && g.name === name))
      return detail(409, `標註群組「${name}」已存在於這個專案`);
    const ids = Array.isArray(b.member_ids) ? (b.member_ids as number[]) : [];
    const bad = checkGroupMembers(pid, ids);
    if (bad) return bad;
    const g = {
      id: db.nextLabelGroupId++,
      project_id: pid,
      name,
      description: typeof b.description === 'string' ? b.description.trim() : '',
      created_by: a.username,
      created_at: new Date().toISOString(),
      member_ids: [...new Set(ids)],
    };
    db.labelGroups.push(g);
    audit(a, 'project', 'labeling_group.create', `project:${pid}/labeling_group:${g.id}`, { name: g.name });
    return json(groupOut(g) as unknown as JsonBodyType, 201);
  }),
  http.patch(`${API}/admin/projects/:pid/labeling-groups/:gid`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    const g = db.labelGroups.find((x) => x.id === Number(params.gid) && x.project_id === pid);
    if (!g) return detail(404, `找不到標註群組 ${params.gid}（專案 ${pid}）`);
    const b = await body(request);
    if ('name' in b) {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) return validation(['name']);
      if (db.labelGroups.some((x) => x.project_id === pid && x.name === name && x.id !== g.id))
        return detail(409, `標註群組「${name}」已存在於這個專案`);
      g.name = name;
    }
    if (typeof b.description === 'string') g.description = b.description.trim();
    if (Array.isArray(b.member_ids)) {
      const bad = checkGroupMembers(pid, b.member_ids as number[]);
      if (bad) return bad;
      g.member_ids = [...new Set(b.member_ids as number[])];
    }
    audit(a, 'project', 'labeling_group.update', `project:${pid}/labeling_group:${g.id}`, b);
    return json(groupOut(g) as unknown as JsonBodyType);
  }),
  http.delete(`${API}/admin/projects/:pid/labeling-groups/:gid`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const pid = Number(params.pid);
    const before = db.labelGroups.length;
    db.labelGroups = db.labelGroups.filter((x) => !(x.id === Number(params.gid) && x.project_id === pid));
    if (db.labelGroups.length === before) return detail(404, `找不到標註群組 ${params.gid}（專案 ${pid}）`);
    audit(a, 'project', 'labeling_group.delete', `project:${pid}/labeling_group:${params.gid}`);
    return noContent();
  }),
  // WP6 FHIR（C-03）
  ...fhirHandlers,
  // M2 建模管理與 AI 模型部署：定義在 mocks/training.ts（標註頁「建立訓練任務」也走這裡）
  ...trainingStageHandlers,
  ...trainingHandlers,
  // WP5a 影像標註：定義在 mocks/labeling.ts
  ...createLabelingHandlers(() => db),
  // WP5b 推論服務管理：定義在 mocks/inference.ts
  ...createInferenceHandlers(() => db),
  ...llmHandlers, // WP7
  ...createOverviewHandlers(() => db), // 專案首頁
];
