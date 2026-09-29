// 與 platform/api/app/fhir 的回應形狀一致（router.py、service.py、gateway.py、traffic.py、graph.py）。

export const RESOURCE_TYPES = ['Patient', 'Encounter', 'Observation'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const SOURCE_KINDS = ['sql', 'csv', 'hl7v2', 'json'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  sql: 'SQL 資料庫',
  csv: 'CSV',
  hl7v2: 'HL7 V2',
  json: 'JSON',
};

export const GATEWAY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface FhirSummary {
  tenant: number;
  counts: Record<ResourceType, number>;
}

export interface FhirResource {
  resourceType: ResourceType;
  id: string;
  identifier?: { system?: string; value?: string }[];
  [key: string]: unknown;
}

export interface ResourcePage {
  total: number;
  count: number;
  offset: number;
  items: FhirResource[];
}

export interface FhirSource {
  id: number;
  project_id: number;
  name: string;
  kind: SourceKind;
  config: Record<string, unknown>;
  content_bytes: number;
  created_by: string;
  created_at: string | null;
}

export interface FhirMapping {
  id: number;
  project_id: number;
  name: string;
  source_kind: SourceKind;
  rules: unknown;
  resource_types: ResourceType[];
  created_by: string;
  updated_at: string | null;
}

export interface BuiltinMapping {
  name: string;
  source_kind: SourceKind;
  resource_types: ResourceType[];
}

export type RunStatus = 'succeeded' | 'rejected' | 'failed' | 'running';

export interface FhirRun {
  id: number;
  project_id: number;
  trigger: 'manual' | 'schedule' | 'hl7v2' | 'vitals';
  source_id: number | null;
  mapping_id: number | null;
  schedule_id: number | null;
  actor: string;
  status: RunStatus;
  records_read: number;
  resources_written: Record<string, number>;
  errors: { index?: number; control_id?: string | null; reasons: string[] }[];
  planned_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  deviation_seconds: number | null;
}

export interface FhirSchedule {
  id: number;
  project_id: number;
  name: string;
  source_id: number;
  mapping_id: number;
  interval_minutes: number;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_by: string;
  last_run: FhirRun | null;
}

export interface GraphNode {
  id: string;
  type: ResourceType;
  label: string;
  identifier: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface FhirGraph {
  patient: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface GatewayRoute {
  id: string;
  managed: boolean;
  description: string;
  uri: string;
  upstream: string[];
  enabled: boolean;
  methods: string[];
  alert_threshold_per_minute: number | null;
  plugins: string[];
  updated_by: string | null;
  updated_at: string | null;
}

export interface TrafficAlert {
  id: number;
  project_id: number;
  actor: string;
  window_start: string;
  request_count: number;
  threshold: number;
  notified: boolean;
  created_at: string;
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  succeeded: '成功',
  rejected: '資料不合格，整批未寫入',
  failed: '寫入失敗，整批未寫入',
  running: '執行中',
};

export const TRIGGER_LABELS: Record<FhirRun['trigger'], string> = {
  manual: '手動',
  schedule: '排程',
  hl7v2: 'HL7 V2 即時',
  vitals: '生理監視器',
};

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-TW', { hour12: false });
}

export function writtenText(written: Record<string, number>): string {
  const parts = Object.entries(written).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join('、') : '—';
}

export function resourceLabel(r: FhirResource): string {
  if (r.resourceType === 'Patient') {
    const name = (r.name as { family?: string; given?: string[] }[] | undefined)?.[0];
    return [name?.family, ...(name?.given ?? [])].filter(Boolean).join(' ') || '—';
  }
  if (r.resourceType === 'Encounter') {
    const cls = (r.class as { code?: string } | undefined)?.code ?? '';
    const start = ((r.period as { start?: string } | undefined)?.start ?? '').slice(0, 10);
    return `${cls} ${start}`.trim() || '—';
  }
  const coding = (r.code as { coding?: { code?: string; display?: string }[] } | undefined)?.coding?.[0];
  const q = r.valueQuantity as { value?: number; unit?: string } | undefined;
  const value = q?.value !== undefined ? ` ${q.value} ${q.unit ?? ''}` : '';
  return `${coding?.display ?? coding?.code ?? '—'}${value}`.trim();
}
