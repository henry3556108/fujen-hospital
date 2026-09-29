// MSW 模擬 platform/api 的 FHIR 端點（WP6）。狀態碼與錯誤形狀照後端；只模擬網頁會用到的部分。
import { http, HttpResponse, type JsonBodyType } from 'msw';
import type {
  FhirMapping,
  FhirResource,
  FhirRun,
  FhirSchedule,
  FhirSource,
  GatewayRoute,
  ResourceType,
  SourceKind,
  TrafficAlert,
} from '../pages/fhir/types';

const API = '*/api';
const json = (body: unknown, status = 200) => HttpResponse.json(body as JsonBodyType, { status });
const detail = (status: number, message: unknown) => json({ detail: message }, status);

const BUILTIN: { name: string; source_kind: SourceKind; resource_types: ResourceType[] }[] = [
  { name: 'sql-patient', source_kind: 'sql', resource_types: ['Patient'] },
  { name: 'csv-encounter', source_kind: 'csv', resource_types: ['Encounter'] },
  { name: 'json-lab-observation', source_kind: 'json', resource_types: ['Observation'] },
  { name: 'hl7v2-adt', source_kind: 'hl7v2', resource_types: ['Patient', 'Encounter'] },
  { name: 'monitor-vitals', source_kind: 'json', resource_types: ['Observation'] },
];

interface Tenant {
  resources: FhirResource[];
  sources: FhirSource[];
  mappings: FhirMapping[];
  runs: FhirRun[];
  schedules: FhirSchedule[];
  alerts: TrafficAlert[];
}

interface FhirMock {
  tenants: Map<number, Tenant>;
  route: GatewayRoute;
  nextId: number;
}

function seedP1(): FhirResource[] {
  const mrn = 'urn:ai-platform:mrn';
  const ref = { reference: 'Patient/1000' };
  return [
    { resourceType: 'Patient', id: '1000', identifier: [{ system: mrn, value: 'SYN-42-0001' }], name: [{ family: 'TSAI', given: ['JACK'] }], gender: 'male' },
    { resourceType: 'Patient', id: '1001', identifier: [{ system: mrn, value: 'SYN-42-0002' }], name: [{ family: 'LIN', given: ['AMY'] }], gender: 'female' },
    { resourceType: 'Encounter', id: '1002', identifier: [{ value: 'ENC0001' }], class: { code: 'IMP' }, period: { start: '2024-09-12T11:08:00+08:00' }, subject: ref },
    { resourceType: 'Encounter', id: '1003', identifier: [{ value: 'VN0001' }], class: { code: 'IMP' }, period: { start: '2024-09-12T11:08:00+08:00' }, subject: ref },
    { resourceType: 'Observation', id: '1004', identifier: [{ value: 'LAB0001' }], code: { coding: [{ code: '2345-7', display: 'Glucose' }] }, valueQuantity: { value: 101.8, unit: 'mg/dL' }, subject: ref },
    { resourceType: 'Encounter', id: '1005', identifier: [{ value: 'ENC0002' }], class: { code: 'AMB' }, period: { start: '2024-01-05T10:32:00+08:00' }, subject: { reference: 'Patient/1001' } },
  ];
}

function emptyTenant(resources: FhirResource[] = []): Tenant {
  return { resources, sources: [], mappings: [], runs: [], schedules: [], alerts: [] };
}

function seed(): FhirMock {
  const tenants = new Map<number, Tenant>([[1, emptyTenant(seedP1())]]);
  tenants.get(1)!.alerts.push({
    id: 1, project_id: 1, actor: 'md01', window_start: '2026-09-29T08:00:00Z', request_count: 131, threshold: 120,
    notified: true, created_at: '2026-09-29T08:00:41Z',
  });
  return {
    tenants,
    nextId: 1,
    route: {
      id: 'fhir-rest', managed: true, description: 'FHIR REST（外部系統存取各專案租戶的 FHIR 資料）',
      uri: '/fhir/projects/*', upstream: ['hapi:8080'], enabled: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      alert_threshold_per_minute: 120, plugins: ['forward-auth'], updated_by: null, updated_at: null,
    },
  };
}

let state = seed();
export function resetFhirMock(): void {
  state = seed();
}

const STATIC_ROUTES: GatewayRoute[] = [
  { id: '/api/*', managed: false, description: '', uri: '/api/*', upstream: ['api:8000'], enabled: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], alert_threshold_per_minute: null, plugins: ['cors'],
    updated_by: null, updated_at: null },
  { id: '/dicomweb/projects/*', managed: false, description: '', uri: '/dicomweb/projects/*', upstream: ['orthanc:8042'],
    enabled: true, methods: ['GET', 'HEAD'], alert_threshold_per_minute: null,
    plugins: ['forward-auth', 'proxy-rewrite', 'serverless-post-function'], updated_by: null, updated_at: null },
];

/** 測試登入模式的 token 是 test-token:<帳號>；FHIR 管理頁只給 Admin，這裡只認 admin01。 */
function admin(request: Request): Response | null {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return detail(401, '未登入');
  if (auth.slice(7) !== 'test-token:admin01') return detail(403, '需要 Admin 權限');
  return null;
}

function tenant(pid: string | readonly string[] | undefined): Tenant {
  const id = Number(pid);
  if (!state.tenants.has(id)) state.tenants.set(id, emptyTenant());
  return state.tenants.get(id)!;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function graphFor(t: Tenant, mrn: string) {
  const patient = t.resources.find((r) => r.resourceType === 'Patient' && r.identifier?.[0]?.value === mrn);
  if (!patient) return null;
  const ref = `Patient/${patient.id}`;
  const related = t.resources.filter((r) => (r.subject as { reference?: string } | undefined)?.reference === ref);
  const label = (r: FhirResource) =>
    r.resourceType === 'Patient'
      ? `${(r.name as { family: string; given: string[] }[])[0].family} ${(r.name as { given: string[] }[])[0].given[0]}（${mrn}）`
      : String(r.identifier?.[0]?.value ?? '');
  return {
    patient: mrn,
    nodes: [patient, ...related].map((r) => ({ id: `${r.resourceType}/${r.id}`, type: r.resourceType, label: label(r),
      identifier: String(r.identifier?.[0]?.value ?? '') })),
    edges: related.map((r) => ({ from: `${r.resourceType}/${r.id}`, to: ref, relation: 'subject' })),
    truncated: false,
  };
}

export const fhirHandlers = [
  http.get(`${API}/projects/:pid/fhir/summary`, ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const t = tenant(params.pid);
    const count = (k: ResourceType) => t.resources.filter((r) => r.resourceType === k).length;
    return json({ tenant: Number(params.pid), counts: { Patient: count('Patient'), Encounter: count('Encounter'), Observation: count('Observation') } });
  }),
  http.get(`${API}/projects/:pid/fhir/resources/:type`, ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const url = new URL(request.url);
    const count = Number(url.searchParams.get('count') ?? 20);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const rows = tenant(params.pid).resources.filter((r) => r.resourceType === params.type);
    return json({ total: rows.length, count, offset, items: rows.slice(offset, offset + count) });
  }),
  http.get(`${API}/projects/:pid/fhir/graph`, ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const mrn = new URL(request.url).searchParams.get('patient') ?? '';
    const g = graphFor(tenant(params.pid), mrn);
    return g ? json(g) : detail(404, `找不到病人 ${mrn}`);
  }),
  http.get(`${API}/projects/:pid/fhir/sources`, ({ request, params }) => admin(request) ?? json(tenant(params.pid).sources)),
  http.post(`${API}/projects/:pid/fhir/sources`, async ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const b = await body(request);
    const t = tenant(params.pid);
    const name = String(b.name ?? '').trim();
    if (!name) return detail(422, '名稱必填，且不可超過 128 個字元');
    if (t.sources.some((s) => s.name === name)) return detail(409, `來源名稱 ${name} 已存在`);
    const kind = b.kind as SourceKind;
    const config = (b.config as Record<string, unknown>) ?? {};
    if (kind !== 'sql' && !String(b.content ?? '').trim()) return detail(422, `${kind} 來源需要 content`);
    const s: FhirSource = {
      id: state.nextId++, project_id: Number(params.pid), name, kind,
      config: kind === 'sql' ? { ...config, dsn: String(config.dsn ?? '').replace(/:[^:@/]+@/, ':***@') } : {},
      content_bytes: new TextEncoder().encode(String(b.content ?? '')).length, created_by: 'admin01', created_at: new Date().toISOString(),
    };
    t.sources.push(s);
    return json(s, 201);
  }),
  http.get(`${API}/projects/:pid/fhir/mappings/builtin`, ({ request }) => admin(request) ?? json(BUILTIN)),
  http.get(`${API}/projects/:pid/fhir/mappings`, ({ request, params }) => admin(request) ?? json(tenant(params.pid).mappings)),
  http.post(`${API}/projects/:pid/fhir/mappings`, async ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const b = await body(request);
    const spec = BUILTIN.find((x) => x.name === b.builtin);
    if (!spec) return detail(422, `沒有內建規則 ${String(b.builtin)}`);
    const t = tenant(params.pid);
    if (t.mappings.some((m) => m.name === spec.name)) return detail(409, `對應規則名稱 ${spec.name} 已存在`);
    const m: FhirMapping = { id: state.nextId++, project_id: Number(params.pid), name: spec.name, source_kind: spec.source_kind,
      rules: {}, resource_types: spec.resource_types, created_by: 'admin01', updated_at: new Date().toISOString() };
    t.mappings.push(m);
    return json(m, 201);
  }),
  http.post(`${API}/projects/:pid/fhir/runs`, async ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const b = await body(request);
    const t = tenant(params.pid);
    const source = t.sources.find((s) => s.id === b.source_id);
    const mapping = t.mappings.find((m) => m.id === b.mapping_id);
    if (!source || !mapping) return detail(404, '找不到來源或對應規則');
    const ok = mapping.source_kind === source.kind;
    const run: FhirRun = {
      id: state.nextId++, project_id: Number(params.pid), trigger: 'manual', source_id: source.id, mapping_id: mapping.id,
      schedule_id: null, actor: 'admin01', status: ok ? 'succeeded' : 'rejected', records_read: ok ? 20 : 0,
      resources_written: ok ? Object.fromEntries(mapping.resource_types.map((k) => [k, 20])) : {},
      errors: ok ? [] : [{ reasons: [`對應規則適用的來源類型是 ${mapping.source_kind}，與來源的 ${source.kind} 不符`] }],
      planned_at: null, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), deviation_seconds: null,
    };
    t.runs.unshift(run);
    return ok ? json(run, 201) : detail(422, { message: '資料不合格，整批未寫入', run });
  }),
  http.get(`${API}/projects/:pid/fhir/runs`, ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100);
    return json(tenant(params.pid).runs.slice(0, limit));
  }),
  http.get(`${API}/projects/:pid/fhir/schedules`, ({ request, params }) => admin(request) ?? json(tenant(params.pid).schedules)),
  http.post(`${API}/projects/:pid/fhir/schedules`, async ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const b = await body(request);
    const minutes = Number(b.interval_minutes);
    if (!(minutes >= 1 && minutes <= 10080)) return detail(422, 'interval_minutes 必須介於 1 與 10080');
    const s: FhirSchedule = {
      id: state.nextId++, project_id: Number(params.pid), name: String(b.name), source_id: Number(b.source_id),
      mapping_id: Number(b.mapping_id), interval_minutes: minutes, enabled: true,
      next_run_at: new Date(Date.now() + minutes * 60_000).toISOString(), last_run_at: null, created_by: 'admin01', last_run: null,
    };
    tenant(params.pid).schedules.push(s);
    return json(s, 201);
  }),
  http.patch(`${API}/projects/:pid/fhir/schedules/:sid`, async ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const s = tenant(params.pid).schedules.find((x) => x.id === Number(params.sid));
    if (!s) return detail(404, `找不到排程 ${String(params.sid)}`);
    Object.assign(s, await body(request));
    return json(s);
  }),
  http.delete(`${API}/projects/:pid/fhir/schedules/:sid`, ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    const t = tenant(params.pid);
    t.schedules = t.schedules.filter((x) => x.id !== Number(params.sid));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/projects/:pid/fhir/alerts`, ({ request, params }) => admin(request) ?? json(tenant(params.pid).alerts)),
  http.get(`${API}/admin/gateway/routes`, ({ request }) => admin(request) ?? json([state.route, ...STATIC_ROUTES])),
  http.patch(`${API}/admin/gateway/routes/:id`, async ({ request, params }) => {
    const denied = admin(request);
    if (denied) return denied;
    if (params.id !== 'fhir-rest') {
      return STATIC_ROUTES.some((r) => r.id === params.id)
        ? detail(409, `路由 ${String(params.id)} 是部署設定檔內的靜態路由，請修改設定檔後重新部署`)
        : detail(404, `找不到路由 ${String(params.id)}`);
    }
    const b = await body(request);
    if (Array.isArray(b.methods) && b.methods.length === 0) return detail(422, 'methods 至少一個');
    const threshold = b.alert_threshold_per_minute;
    if (threshold !== undefined && !(Number(threshold) >= 1 && Number(threshold) <= 100000)) {
      return detail(422, 'alert_threshold_per_minute 必須介於 1 與 100000');
    }
    state.route = { ...state.route, ...(b as Partial<GatewayRoute>), updated_by: 'admin01', updated_at: new Date().toISOString() };
    return json(state.route);
  }),
];
