// GET /api/projects/{id}/overview（第二期 API 合約）。沒有權限的區塊不回傳。
import type { Permission } from '../../api/types';

export interface OverviewTrainingRun {
  id: number;
  status: string;
  queue_position: number | null;
  task: string;
  setting_name: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ProjectOverview {
  project: { id: number; name: string };
  me: { role: string | null; permissions: Permission[] };
  data?: { studies: number; tabular_datasets: number };
  labeling?: {
    pending: number;
    confirmed: number;
    total_studies: number;
    last: { study_instance_uid: string; accession_number: string | null; updated_at: string } | null;
  };
  training?: { recent: OverviewTrainingRun[]; recent_completed: number[] };
  models?: { run_id: number; name: string; task: string; metric_name: string | null; metric_value: number | null; finished_at: string | null }[];
  predictions?: { id: number; run_id: number; model_name: string; created_at: string; rows: number | null }[];
}
