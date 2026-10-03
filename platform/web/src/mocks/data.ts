// 模擬資料：對應 docs/test-cases/acceptance-test-cases.md「共用測試基線」。
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Me,
  type Membership,
  type Permission,
  type Project,
  type Role,
  type User,
} from '../api/types';

export interface MockLabelGroup {
  id: number;
  project_id: number;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  member_ids: number[];
}

export interface MockDb {
  projects: Project[];
  labelGroups: MockLabelGroup[];
  nextLabelGroupId: number;
  users: User[];
  memberships: Membership[];
  passwords: Record<number, string>;
  nextProjectId: number;
  nextUserId: number;
}

const P1 = 1;

export function seedDb(): MockDb {
  const projects: Project[] = [
    { id: 1, name: 'P1-lung-ct', description: '影像', gpu_group: 'gpu-exclusive' },
    { id: 2, name: 'P2-tabular', description: '結構式', gpu_group: null },
    { id: 3, name: 'P3-llm', description: 'LLM', gpu_group: 'gpu-shared' },
  ];
  const names: [string, 'admin' | 'user'][] = [
    ['admin01', 'admin'],
    ['pi01', 'user'],
    ['md01', 'user'],
    ['ra01', 'user'],
    ['ca01', 'user'],
    ['vw01', 'user'],
    ['user01', 'user'],
    ['user02', 'user'],
  ];
  const users: User[] = names.map(([username, account_type], i) => ({ id: i + 1, username, account_type }));
  const roleOf: Record<string, Role> = {
    pi01: 'principal_investigator',
    md01: 'medical_doctor',
    ra01: 'research_assistant',
    ca01: 'coder_assistant',
    vw01: 'viewer',
  };
  const memberships: Membership[] = users
    .filter((u) => roleOf[u.username])
    .map((u) => ({
      project_id: P1,
      user_id: u.id,
      role: roleOf[u.username],
      permissions: [...DEFAULT_ROLE_PERMISSIONS[roleOf[u.username]]],
    }));
  return {
    projects,
    labelGroups: [],
    nextLabelGroupId: 1,
    users,
    memberships,
    passwords: {},
    nextProjectId: projects.length + 1,
    nextUserId: users.length + 1,
  };
}

const sortPerms = (ps: Permission[]) => [...ps].sort();

export function meFor(db: MockDb, username: string): Me | null {
  const user = db.users.find((u) => u.username === username);
  if (!user) return null;
  if (user.account_type === 'admin') {
    return {
      username,
      account_type: 'admin',
      projects: db.projects.map((p) => ({ id: p.id, name: p.name, role: null, permissions: sortPerms([...PERMISSIONS]) })),
    };
  }
  return {
    username,
    account_type: 'user',
    projects: db.memberships
      .filter((m) => m.user_id === user.id)
      .sort((a, b) => a.project_id - b.project_id)
      .map((m) => {
        const p = db.projects.find((x) => x.id === m.project_id)!;
        return { id: p.id, name: p.name, role: m.role, permissions: sortPerms(m.permissions) };
      }),
  };
}

/** 單元測試用：取得種子帳號的 /api/me 回應。 */
export function fixtureMe(username: string): Me {
  const me = meFor(seedDb(), username);
  if (!me) throw new Error(`unknown fixture user ${username}`);
  return me;
}
