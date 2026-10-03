// 與 platform/api 的回應形狀一致（app/routers/me.py、admin.py、permissions.py）。

export const PERMISSIONS = ['project', 'labeling', 'training', 'prediction', 'coding'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'viewer',
  'medical_doctor',
  'research_assistant',
  'coder_assistant',
  'principal_investigator',
] as const;
export type Role = (typeof ROLES)[number];

export type AccountType = 'admin' | 'user';

export interface MeProject {
  id: number;
  name: string;
  role: Role | null;
  permissions: Permission[];
}

export interface Me {
  username: string;
  account_type: AccountType;
  projects: MeProject[];
}

export interface Project {
  id: number;
  name: string;
  description: string;
  gpu_group: string | null;
}

export interface User {
  id: number;
  username: string;
  account_type: AccountType;
}

export interface Membership {
  project_id: number;
  user_id: number;
  role: Role;
  permissions: Permission[];
}

// 角色預設權限，與 platform/api/app/permissions.py 相同（需與甲方確認）。
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: ['project', 'prediction'],
  medical_doctor: ['project', 'labeling', 'prediction'],
  research_assistant: ['project', 'labeling', 'training', 'prediction'],
  coder_assistant: ['project', 'training', 'coding', 'prediction'],
  principal_investigator: ['project', 'labeling', 'training', 'prediction', 'coding'],
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  project: 'Project',
  labeling: 'Labeling',
  training: 'Training',
  prediction: 'Prediction',
  coding: 'Coding',
};

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  medical_doctor: 'Medical Doctor',
  research_assistant: 'Research Assistant',
  coder_assistant: 'Coder Assistant',
  principal_investigator: 'Principal Investigator',
};

/** 頁首顯示的中文角色名稱（帳號管理頁仍用規格的英文名稱） */
export const ROLE_NAMES_ZH: Record<Role, string> = {
  viewer: '檢視者',
  medical_doctor: '醫師',
  research_assistant: '研究助理',
  coder_assistant: '程式開發助理',
  principal_investigator: '計畫主持人',
};

export const ACCOUNT_TYPE_NAMES_ZH: Record<AccountType, string> = {
  admin: '系統管理者',
  user: '一般使用者',
};

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  admin: 'Admin',
  user: 'User',
};

/** 標註群組（GET /api/admin/projects/{id}/labeling-groups） */
export interface LabelGroup {
  id: number;
  project_id: number;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  members: { user_id: number; username: string }[];
}

/** 專案成員（GET /api/admin/projects/{id}/members） */
export interface MemberRow {
  user_id: number;
  username: string;
  role: Role;
  permissions: Permission[];
  unknown_permissions?: string[];
}

/** Admin Dashboard（GET /api/admin/dashboard） */
export interface AdminDashboard {
  generated_at: string;
  accounts: { total: number; admin: number; user: number };
  projects: number;
  memberships: number;
  labeling_groups: number;
  labeling_group_members: number;
  tabular_datasets: number;
  imaging_studies: number;
  gpu_groups: number;
  jobs: { total: number; by_status: Record<string, number> };
  per_project: {
    id: number;
    name: string;
    gpu_group: string | null;
    members: number;
    labeling_groups: number;
    tabular_datasets: number;
    imaging_studies: number;
    jobs: number;
  }[];
}
