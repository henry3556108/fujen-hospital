// 待處理清單的共用邏輯：哪些研究算待處理、下一筆是哪一個、資料範圍篩選。
import { useSession } from '../../auth/SessionContext';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import type { StudySummary } from './types';

/** 待處理＝還沒有已確認的標註，或還有待確認的草稿。舊後端沒有 confirmed 欄位時用標註數判斷。 */
export function isPendingStudy(s: StudySummary): boolean {
  return (s.confirmed ?? s.annotations) === 0 || (s.drafts ?? 0) > 0;
}

/** 清單中 current 之後的第一筆待處理研究；後面沒有就從頭找，都沒有回 null。 */
export function nextPendingStudy(studies: StudySummary[], current: string | null): StudySummary | null {
  const at = current ? studies.findIndex((s) => s.study_instance_uid === current) : -1;
  const ordered = [...studies.slice(at + 1), ...studies.slice(0, Math.max(0, at))];
  return ordered.find((s) => s.study_instance_uid !== current && isPendingStudy(s)) ?? null;
}

/** 已確認／總數／待處理（總數與已確認依研究數；待處理照 API，沒有就自己算）。 */
export function progressOf(studies: StudySummary[], pending?: number, confirmed?: number) {
  const done = confirmed ?? studies.filter((s) => !isPendingStudy(s)).length;
  const todo = pending ?? studies.filter(isPendingStudy).length + studies.reduce((n, s) => n + (s.drafts ?? 0), 0);
  return { confirmed: done, total: studies.length, pending: todo };
}

export interface Scope {
  id: number;
  name: string;
  filters: Record<string, string>;
  study_count: number;
  created_by: string;
  created_at: string;
}

/** 專案已存的資料範圍；舊後端沒有這支 API 時回空清單，畫面就不顯示選單。 */
export function useScopes() {
  const { api, project } = useSession();
  const pid = project?.id;
  return useResource(async () => {
    if (!pid) return [] as Scope[];
    try {
      return await api.get<Scope[]>(`/api/projects/${pid}/imaging/scopes`);
    } catch {
      return [] as Scope[];
    }
  }, [api, pid]);
}

/** 資料範圍內的研究 UID；沒選範圍回 null（代表不篩）。 */
export function useScopeStudyUids(scopeId: number | null) {
  const { api, project } = useSession();
  const pid = project?.id;
  return useResource(async () => {
    if (!pid || scopeId === null) return null;
    const page = await api.get<{ items: { study_instance_uid: string }[] }>(
      withQuery(`/api/projects/${pid}/imaging/studies`, { scope_id: scopeId, limit: 500 }),
    );
    return new Set(page.items.map((s) => s.study_instance_uid));
  }, [api, pid, scopeId]);
}

/** 開啟工作台的網址；帶著資料範圍，工作台的「下一筆」才會在同一個範圍內找。 */
export function workbenchPath(uid: string, scopeId: number | null): string {
  return `/labeling/studies/${encodeURIComponent(uid)}${scopeId !== null ? `?scope=${scopeId}` : ''}`;
}
