// 授權對象的帳號查詢（/api/projects/{pid}/user-lookup）：部署模型、發布 LLM 服務時選同事的帳號。
// 需要本專案的 training 或 coding 權限；只回帳號名稱與是否為本專案成員。
import { useCallback } from 'react';
import { useSession } from '../auth/SessionContext';
import { withQuery } from './client';

export interface UserMatch {
  username: string;
  /** 是否為本專案成員 */
  member: boolean;
}

export type UserLookup = (prefix: string) => Promise<UserMatch[]>;

/** 目前專案的帳號查詢；尚未選專案時回 null。 */
export function useUserLookup(): UserLookup | null {
  const { api, project } = useSession();
  const pid = project?.id ?? null;
  const lookup = useCallback<UserLookup>(
    (prefix) => api.get<UserMatch[]>(withQuery(`/api/projects/${pid}/user-lookup`, { q: prefix, limit: 10 })),
    [api, pid],
  );
  return pid === null ? null : lookup;
}
