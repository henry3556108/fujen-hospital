// 與 platform/api/app/scheduling 的回應形狀一致（service.py 的 *_out）。
import type { BadgeTone } from '../../components/StatusBadge';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'held';
export type JobKind = 'training' | 'data-cleaning';

export interface Job {
  id: number;
  project_id: number;
  user: string;
  kind: JobKind;
  gpu_group: string | null;
  queue: string;
  status: JobStatus;
  k8s_name: string;
  message: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type GpuPool = 'gpu-exclusive' | 'gpu-shared';
export type GpuMode = 'exclusive' | 'shared';

export const POOL_MODES: Record<GpuPool, GpuMode> = { 'gpu-exclusive': 'exclusive', 'gpu-shared': 'shared' };
export const POOL_LABELS: Record<GpuPool, string> = { 'gpu-exclusive': '獨占池（gpu-exclusive）', 'gpu-shared': '共享池（gpu-shared）' };
export const MODE_LABELS: Record<GpuMode, string> = { exclusive: '獨占', shared: '共享（時間片）' };

export interface GpuGroup {
  name: string;
  pool: string;
  gpu_count: number;
  mode: string;
  queue: string;
}

export interface ClusterNode {
  name: string;
  pool: string | null;
  ready: boolean;
  gpu_capacity: number;
  gpu_allocatable: number;
  gpu_physical: number;
}

export interface GpuAllocation {
  node: string;
  gpu_index: number;
  slot: number;
  k8s_name: string;
  project_id: number | null;
  job_id: number | null;
  training_id: number | null;
  user: string | null;
}

export interface SharedSchedulingSettings {
  time_slice_replicas: number;
  job_timeout_minutes: number;
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: '等待中',
  running: '執行中',
  succeeded: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  held: '已暫存',
};

export const JOB_STATUS_TONE: Record<JobStatus, BadgeTone> = {
  queued: 'info',
  running: 'warning',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'neutral',
  held: 'neutral',
};

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  training: '訓練（GPU）',
  'data-cleaning': '資料清洗（CPU）',
};

/** 佇列頁也會出現平台送出的批次推論工作 */
export const QUEUE_KIND_LABELS: Record<string, string> = {
  ...JOB_KIND_LABELS,
  inference: '批次推論（GPU）',
  'inference-cpu': '批次推論（CPU）',
};

/** 排隊或執行中（畫面要自動更新）；暫存的工作不會自己變化，不算 */
export const isActive = (s: JobStatus) => s === 'queued' || s === 'running';
/** 還沒結束、可以取消（含暫存） */
export const isOpen = (s: JobStatus) => isActive(s) || s === 'held';

/** 後台佇列順序（GET /api/admin/queues） */
export interface QueueJob {
  id: number;
  project_id: number;
  project_name: string;
  user: string;
  kind: string;
  status: JobStatus;
  queue: string;
  k8s_name: string;
  created_at: string;
  started_at: string | null;
  /** 等待中的第幾位（1 起算）；執行中與暫存為 null */
  position: number | null;
  /** 已被排程放行、容器啟動中（狀態仍是 queued） */
  admitted: boolean;
  training_run: { id: number; name: string } | null;
  inference_id: number | null;
  held_by: string | null;
  held_at: string | null;
}

export interface QueueOverview {
  queue: string;
  running: QueueJob[];
  waiting: QueueJob[];
  held: QueueJob[];
}
