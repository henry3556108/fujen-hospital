// 模擬 platform/api 的排程 API（app/scheduling）：語意照 FakeJobBackend（StrictFIFO、獨占一卡一件、共享池時間片）。
import { http } from 'msw';
import type { ClusterNode, GpuAllocation, GpuGroup, Job, JobKind, SharedSchedulingSettings } from '../pages/scheduling/types';
import { POOL_MODES } from '../pages/scheduling/types';
import { mockDb } from './handlers';
import { API, detail, json, jsonBody, moduleState, noContent, requireAdmin, requireProject, validation } from './support';

interface SimJob extends Job {
  pool: string;
  gpus: number;
  duration: number;
  fail: boolean;
  node: string | null;
  slots: number[];
  endsAt: number | null;
  timeout: number | null;
}

interface SimNode {
  name: string;
  pool: string | null;
  physical: number;
  capacity: number;
  cpuSlots: number;
}

interface State {
  groups: GpuGroup[];
  settings: SharedSchedulingSettings;
  jobs: SimJob[];
  nodes: SimNode[];
  nextJobId: number;
  /** 模擬時鐘相對於真實時間的位移（秒），測試用 advanceMockClock 推進 */
  offset: number;
  available: boolean;
}

function seed(): State {
  return {
    groups: [
      { name: 'gpu-exclusive', pool: 'gpu-exclusive', gpu_count: 2, mode: 'exclusive', queue: 'gpu-exclusive' },
      { name: 'gpu-shared', pool: 'gpu-shared', gpu_count: 1, mode: 'shared', queue: 'gpu-shared' },
    ],
    settings: { time_slice_replicas: 4, job_timeout_minutes: 60 },
    jobs: [],
    nodes: [
      { name: 'ai-platform-control-plane', pool: null, physical: 0, capacity: 0, cpuSlots: 0 },
      { name: 'ai-platform-worker', pool: 'cpu-web', physical: 0, capacity: 0, cpuSlots: 8 },
      { name: 'ai-platform-worker2', pool: 'cpu-data', physical: 0, capacity: 0, cpuSlots: 8 },
      { name: 'ai-platform-worker3', pool: 'gpu-exclusive', physical: 2, capacity: 2, cpuSlots: 8 },
      { name: 'ai-platform-worker4', pool: 'gpu-shared', physical: 1, capacity: 4, cpuSlots: 8 },
    ],
    nextJobId: 1,
    offset: 0,
    available: true,
  };
}

const state = () => moduleState('scheduling', seed);
const clock = (s: State) => Date.now() / 1000 + s.offset;
const iso = (t: number) => new Date(t * 1000).toISOString();

/** 測試用：把模擬時鐘往前推（秒）。 */
export function advanceMockClock(seconds: number): void {
  state().offset += seconds;
}

/** 測試用：模擬「排程服務尚未設定」（503）。 */
export function setSchedulingAvailable(available: boolean): void {
  state().available = available;
}

export function mockJobs(): Job[] {
  const s = state();
  sync(s);
  return s.jobs.map(jobOut);
}

function usedSlots(s: State, node: SimNode): Set<number> {
  return new Set(s.jobs.filter((j) => j.status === 'running' && j.node === node.name).flatMap((j) => j.slots));
}

function place(s: State, job: SimJob): boolean {
  for (const node of s.nodes.filter((n) => n.pool === job.pool)) {
    if (job.gpus > 0) {
      const used = usedSlots(s, node);
      const free = Array.from({ length: node.capacity }, (_, i) => i).filter((i) => !used.has(i));
      if (free.length >= job.gpus) {
        job.slots = free.slice(0, job.gpus);
        job.node = node.name;
        return true;
      }
    } else if (s.jobs.filter((j) => j.status === 'running' && j.node === node.name).length < node.cpuSlots) {
      job.node = node.name;
      return true;
    }
  }
  return false;
}

function schedule(s: State, now: number): void {
  const queues = new Set(s.jobs.filter((j) => j.status === 'queued').map((j) => j.queue));
  for (const queue of queues) {
    // StrictFIFO：排頭放不下時，後面的也不能插隊
    for (const job of s.jobs.filter((j) => j.status === 'queued' && j.queue === queue)) {
      if (!place(s, job)) break;
      job.status = 'running';
      job.started_at = iso(now);
      const runtime = job.timeout ? Math.min(job.duration, job.timeout) : job.duration;
      job.endsAt = now + runtime;
    }
  }
}

function finish(job: SimJob): void {
  if (job.timeout && job.duration > job.timeout) {
    job.status = 'failed';
    job.message = '超過執行時限';
  } else if (job.fail) {
    job.status = 'failed';
    job.message = '工作以非 0 結束';
  } else {
    job.status = 'succeeded';
  }
  job.finished_at = iso(job.endsAt!);
  job.slots = [];
}

function sync(s: State): void {
  const now = clock(s);
  for (;;) {
    const due = s.jobs.filter((j) => j.status === 'running' && j.endsAt !== null && j.endsAt <= now);
    if (due.length === 0) break;
    const first = due.reduce((a, b) => (a.endsAt! <= b.endsAt! ? a : b));
    finish(first);
    schedule(s, first.endsAt!);
  }
  schedule(s, now);
}

function jobOut(j: SimJob): Job {
  const { id, project_id, user, kind, gpu_group, queue, status, k8s_name, message, created_at, started_at, finished_at } = j;
  return { id, project_id, user, kind, gpu_group, queue, status, k8s_name, message, created_at, started_at, finished_at };
}

function nodeOut(n: SimNode): ClusterNode {
  return {
    name: n.name,
    pool: n.pool,
    ready: true,
    gpu_capacity: n.capacity,
    gpu_allocatable: n.capacity,
    gpu_physical: n.physical,
  };
}

function dashboard(s: State): GpuAllocation[] {
  const rows: GpuAllocation[] = [];
  for (const job of s.jobs) {
    if (job.status !== 'running' || job.gpus === 0 || !job.node) continue;
    const node = s.nodes.find((n) => n.name === job.node)!;
    const replicas = Math.max(1, Math.floor(node.capacity / Math.max(1, node.physical)));
    for (const slot of job.slots) {
      rows.push({
        node: node.name,
        gpu_index: Math.floor(slot / replicas),
        slot: slot % replicas,
        k8s_name: job.k8s_name,
        project_id: job.project_id,
        job_id: job.id,
        training_id: job.kind === 'training' ? job.id : null,
        user: job.user,
      });
    }
  }
  return rows.sort((a, b) => a.node.localeCompare(b.node) || a.gpu_index - b.gpu_index || a.slot - b.slot);
}

const unavailable = () => detail(503, '排程服務尚未設定（JOB_BACKEND）');

function intField(b: Record<string, unknown>, field: string, min: number, max: number, fallback?: number): number | Response {
  const v = b[field] === undefined ? fallback : b[field];
  if (v === undefined) return validation(field, 'Field required', 'missing');
  if (typeof v !== 'number' || !Number.isInteger(v)) return validation(field, 'Input should be a valid integer', 'int_type', v);
  if (v < min) return validation(field, `Input should be greater than or equal to ${min}`, 'greater_than_equal', v);
  if (v > max) return validation(field, `Input should be less than or equal to ${max}`, 'less_than_equal', v);
  return v;
}

function validateGroup(pool: unknown, mode: unknown, count: unknown): Response | null {
  if (typeof pool !== 'string' || !(pool in POOL_MODES)) {
    return detail(422, `不存在的 GPU 池：${String(pool)}（可用：${Object.keys(POOL_MODES).join(', ')}）`);
  }
  const expected = POOL_MODES[pool as keyof typeof POOL_MODES];
  if (mode !== expected) return detail(422, `${pool} 只能使用 ${expected} 模式`);
  if (typeof count !== 'number' || count < 1) return detail(422, 'GPU 數量至少為 1');
  return null;
}

export const schedulingHandlers = [
  // ---- 專案工作 ----
  http.get(`${API}/projects/:pid/jobs`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const s = state();
    if (!s.available) return unavailable();
    sync(s);
    return json(s.jobs.filter((j) => j.project_id === ctx.project.id).map(jobOut));
  }),
  http.post(`${API}/projects/:pid/jobs`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const s = state();
    if (!s.available) return unavailable();
    const b = await jsonBody(request);
    const kind = (b.kind ?? 'training') as JobKind;
    if (kind !== 'training' && kind !== 'data-cleaning') {
      return validation('kind', "Input should be 'training' or 'data-cleaning'", 'literal_error', kind);
    }
    const duration = intField(b, 'duration_seconds', 1, 3600, 30);
    if (duration instanceof Response) return duration;
    const memory = intField(b, 'memory_mb', 1, 256, 16);
    if (memory instanceof Response) return memory;
    let group: GpuGroup | undefined;
    if (kind === 'training') {
      if (!ctx.project.gpu_group) return detail(409, `專案「${ctx.project.name}」尚未綁定 GPU 群組，無法送出 GPU 工作`);
      group = s.groups.find((g) => g.name === ctx.project.gpu_group);
      if (!group) return detail(409, `專案綁定的 GPU 群組「${ctx.project.gpu_group}」不存在`);
    }
    sync(s);
    const now = clock(s);
    const id = s.nextJobId++;
    const pool = group ? group.pool : 'cpu-data';
    const job: SimJob = {
      id,
      project_id: ctx.project.id,
      user: ctx.user.username,
      kind,
      gpu_group: group ? group.name : null,
      queue: pool,
      status: 'queued',
      k8s_name: `job-${id}-${(id * 2654435761).toString(16).slice(-6)}`,
      message: '',
      created_at: iso(now),
      started_at: null,
      finished_at: null,
      pool,
      gpus: group ? 1 : 0,
      duration,
      fail: b.fail === true,
      node: null,
      slots: [],
      endsAt: null,
      timeout: group?.mode === 'shared' ? s.settings.job_timeout_minutes * 60 : null,
    };
    s.jobs.push(job);
    return json(jobOut(job), 201);
  }),
  http.get(`${API}/projects/:pid/jobs/:jid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const s = state();
    if (!s.available) return unavailable();
    sync(s);
    const job = s.jobs.find((j) => j.id === Number(params.jid) && j.project_id === ctx.project.id);
    return job ? json(jobOut(job)) : detail(404, `找不到工作 ${params.jid}`);
  }),
  http.post(`${API}/projects/:pid/jobs/:jid/cancel`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'training');
    if (ctx instanceof Response) return ctx;
    const s = state();
    if (!s.available) return unavailable();
    sync(s);
    const job = s.jobs.find((j) => j.id === Number(params.jid) && j.project_id === ctx.project.id);
    if (!job) return detail(404, `找不到工作 ${params.jid}`);
    if (job.status !== 'queued' && job.status !== 'running') {
      return detail(409, `工作 ${job.id} 已結束（${job.status}），無法取消`);
    }
    job.status = 'cancelled';
    job.finished_at = iso(clock(s));
    job.slots = [];
    job.endsAt = null;
    schedule(s, clock(s));
    return json(jobOut(job));
  }),

  // ---- GPU 群組 ----
  http.get(`${API}/admin/gpu-groups`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    return json(state().groups);
  }),
  http.post(`${API}/admin/gpu-groups`, async ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const s = state();
    const b = await jsonBody(request);
    if (typeof b.name !== 'string' || !b.name) {
      return validation('name', 'String should have at least 1 character', 'string_too_short', b.name ?? '');
    }
    const bad = validateGroup(b.pool, b.mode, b.gpu_count);
    if (bad) return bad;
    if (s.groups.some((g) => g.name === b.name)) return detail(409, `GPU 群組「${b.name}」已存在`);
    const g: GpuGroup = { name: b.name, pool: b.pool as string, gpu_count: b.gpu_count as number, mode: b.mode as string, queue: b.pool as string };
    s.groups.push(g);
    return json(g, 201);
  }),
  http.patch(`${API}/admin/gpu-groups/:name`, async ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const s = state();
    const g = s.groups.find((x) => x.name === params.name);
    if (!g) return detail(404, `找不到 GPU 群組 ${params.name}`);
    const b = await jsonBody(request);
    const next = { pool: b.pool ?? g.pool, mode: b.mode ?? g.mode, gpu_count: b.gpu_count ?? g.gpu_count };
    const bad = validateGroup(next.pool, next.mode, next.gpu_count);
    if (bad) return bad;
    Object.assign(g, next, { queue: next.pool });
    return json(g);
  }),
  http.delete(`${API}/admin/gpu-groups/:name`, ({ request, params }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const s = state();
    if (!s.groups.some((x) => x.name === params.name)) return detail(404, `找不到 GPU 群組 ${params.name}`);
    const bound = mockDb().projects.filter((p) => p.gpu_group === params.name).map((p) => p.name);
    if (bound.length) return detail(409, `GPU 群組「${params.name}」仍綁定專案：${bound.join(', ')}`);
    s.groups = s.groups.filter((x) => x.name !== params.name);
    return noContent();
  }),

  // ---- 叢集 ----
  http.get(`${API}/admin/cluster/nodes`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const s = state();
    if (!s.available) return unavailable();
    return json([...s.nodes].sort((x, y) => x.name.localeCompare(y.name)).map(nodeOut));
  }),
  http.get(`${API}/admin/cluster/gpu-dashboard`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const s = state();
    if (!s.available) return unavailable();
    sync(s);
    return json(dashboard(s));
  }),
  http.get(`${API}/admin/cluster/shared-scheduling`, ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    return json(state().settings);
  }),
  http.put(`${API}/admin/cluster/shared-scheduling`, async ({ request }) => {
    const a = requireAdmin(request);
    if (a instanceof Response) return a;
    const s = state();
    if (!s.available) return unavailable();
    const b = await jsonBody(request);
    const replicas = intField(b, 'time_slice_replicas', 1, 16);
    if (replicas instanceof Response) return replicas;
    const timeout = intField(b, 'job_timeout_minutes', 1, 1440);
    if (timeout instanceof Response) return timeout;
    s.settings = { time_slice_replicas: replicas, job_timeout_minutes: timeout };
    for (const n of s.nodes) if (n.pool === 'gpu-shared') n.capacity = n.physical * replicas;
    sync(s);
    return json(s.settings);
  }),
];
