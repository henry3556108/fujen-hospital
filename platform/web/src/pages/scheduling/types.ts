// 與 platform/api/app/scheduling 的回應形狀一致（service.py 的 *_out）。

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
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
  queued: '排隊中',
  running: '執行中',
  succeeded: '已完成',
  failed: '失敗',
  cancelled: '已取消',
};

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  training: '訓練（GPU）',
  'data-cleaning': '資料清洗（CPU）',
};

export const isActive = (s: JobStatus) => s === 'queued' || s === 'running';
