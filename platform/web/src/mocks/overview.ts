// 模擬 GET /api/projects/{id}/overview（第二期首頁 API）：沒有權限的區塊不回傳。
// 數字取自其他模擬資料（影像、表格）；訓練、模型、預測用固定示範資料。
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { PERMISSIONS, type Permission } from '../api/types';
import type { MockDb } from './data';
import { mockStudyCounts } from './imaging';
import { mockDatasetCounts } from './tabular';

const detail = (status: number, message: string) => HttpResponse.json({ detail: message }, { status });

export function createOverviewHandlers(getDb: () => MockDb) {
  return [
    http.get('*/api/projects/:pid/overview', ({ request, params }) => {
      const db = getDb();
      const m = /^bearer test-token:(.+)$/i.exec(request.headers.get('authorization') ?? '');
      const user = m ? db.users.find((u) => u.username === m[1]) : undefined;
      if (!user) return detail(401, '未登入');
      const pid = Number(params.pid);
      const project = db.projects.find((p) => p.id === pid);
      if (!project) return detail(404, `找不到專案 ${pid}`);
      const membership = db.memberships.find((x) => x.project_id === pid && x.user_id === user.id);
      if (!membership && user.account_type !== 'admin') return detail(403, '你不是這個專案的成員');
      const permissions: Permission[] = membership ? membership.permissions : [...PERMISSIONS];
      const can = (p: Permission) => permissions.includes(p);
      const studies = mockStudyCounts().get(pid) ?? 0;
      const body: Record<string, unknown> = {
        project: { id: project.id, name: project.name },
        me: { role: membership?.role ?? (user.account_type === 'admin' ? 'admin' : null), permissions },
      };
      if (can('project')) body.data = { studies, tabular_datasets: mockDatasetCounts().get(pid) ?? 0 };
      if (can('labeling')) body.labeling = { pending: studies, confirmed: 0, total_studies: studies, last: null };
      if (can('training')) body.training = { recent: [], recent_completed: [] };
      if (can('prediction')) {
        body.models = [];
        body.predictions = [];
      }
      return HttpResponse.json(body as JsonBodyType);
    }),
  ];
}
